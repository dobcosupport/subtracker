-- =====================================================================
-- NJ PWC auto-approval + daily registry sync: functions
-- Date: 2026-10-14
-- Requires 20261014_nj_pwc_registry_sync_schema.sql.
--
-- Every state-changing entry point is SECURITY DEFINER, executes as one
-- transaction, is callable only by service_role (server routes), and
-- writes an administration_audit_log entry together with its changes.
--
-- Mode (compliance_sync_settings.mode for NJ PWC) is read here, inside
-- the transaction, so it is the single master switch:
--   review_required -> human workflow (Review Queue)
--   auto_approve    -> high-confidence results are applied automatically
-- Low-confidence results (multiple matches, name mismatch, expired
-- registration, certificate changes, registry anomalies) always go to
-- review regardless of mode.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- Preflight: this file depends on objects created by
-- 20261014_nj_pwc_registry_sync_schema.sql. Without them PostgreSQL
-- reports misleading parse errors (e.g. "missing FROM-clause entry for
-- table p_record" when compliance_records.registry_status is absent),
-- so fail fast with an actionable message instead.
-- ---------------------------------------------------------------------
DO $$
DECLARE
    v_missing TEXT;
BEGIN
    SELECT string_agg(req.tbl || '.' || req.col, ', ' ORDER BY req.tbl, req.col)
    INTO v_missing
    FROM (VALUES
        ('compliance_records', 'registry_status'),
        ('compliance_records', 'registry_status_updated_at'),
        ('compliance_records', 'last_registry_sync_at'),
        ('compliance_sync_settings', 'failure_expire_threshold'),
        ('compliance_sync_runs', 'run_type'),
        ('compliance_sync_runs', 'run_date'),
        ('compliance_sync_search_requests', 'contractor_id'),
        ('compliance_sync_search_requests', 'origin'),
        ('compliance_sync_search_requests', 'priority'),
        ('compliance_sync_search_requests', 'sync_run_id'),
        ('compliance_sync_search_requests', 'search_variation'),
        ('compliance_sync_search_requests', 'sync_outcome'),
        ('compliance_sync_search_requests', 'processed_at'),
        ('compliance_sync_search_requests', 'imported_at'),
        ('compliance_sync_search_requests', 'imported_by'),
        ('compliance_sync_search_requests', 'imported_certificate_number'),
        ('compliance_sync_search_requests', 'import_review_queue_id'),
        ('compliance_sync_review_queue', 'review_reason'),
        ('compliance_sync_review_queue', 'search_request_id'),
        ('nj_pwc_sync_state', 'dry_run_action'),
        ('nj_pwc_sync_state', 'dry_run_action_at'),
        ('nj_pwc_sync_exceptions', 'id')
    ) AS req(tbl, col)
    WHERE NOT EXISTS (
        SELECT 1 FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.table_name = req.tbl AND c.column_name = req.col
    );

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION 'NJ PWC registry sync schema migration has not been applied (missing: %).', v_missing
            USING HINT = 'Apply supabase/20261014_nj_pwc_registry_sync_schema.sql first, then re-run this file.';
    END IF;
END $$;

-- ---------------------------------------------------------------------
-- Normalization helpers
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nj_pwc_normalize_name(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v TEXT;
    previous TEXT;
BEGIN
    v := upper(coalesce(p_name, ''));
    v := replace(v, '&', ' AND ');
    v := regexp_replace(v, '[^A-Z0-9 ]', ' ', 'g');
    v := btrim(regexp_replace(v, '\s+', ' ', 'g'));
    v := regexp_replace(v, '^THE ', '');
    LOOP
        previous := v;
        v := btrim(regexp_replace(
            v,
            '(^| )(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|L L P|PC|P C|PLLC)$',
            ''
        ));
        EXIT WHEN v = previous OR v = '';
    END LOOP;
    RETURN nullif(v, '');
END;
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_normalize_certificate(p_value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT nullif(upper(regexp_replace(coalesce(p_value, ''), '[\s-]', '', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_try_date(p_value TEXT)
RETURNS DATE
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_value IS NULL OR p_value !~ '^\d{4}-\d{2}-\d{2}' THEN
        RETURN NULL;
    END IF;
    RETURN left(p_value, 10)::DATE;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

-- TRUE when a registry row cannot be trusted for automatic processing.
CREATE OR REPLACE FUNCTION public.nj_pwc_candidate_is_anomalous(p_candidate JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    cert TEXT := public.nj_pwc_normalize_certificate(p_candidate->>'certificate_number');
    registration DATE := public.nj_pwc_try_date(p_candidate->>'registration_date');
    expiration DATE := public.nj_pwc_try_date(p_candidate->>'expiration_date');
BEGIN
    RETURN cert IS NULL
        OR cert !~ '^[A-Z0-9]+$'
        OR expiration IS NULL
        OR (nullif(p_candidate->>'registration_date', '') IS NOT NULL AND registration IS NULL)
        OR (registration IS NOT NULL AND registration > expiration);
END;
$$;

-- ---------------------------------------------------------------------
-- Daily-sync classification (pure; no writes)
--   kind: success | failure | review | infrastructure
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nj_pwc_classify_sync_result(
    p_contractor_name TEXT,
    p_known_certificates TEXT[],
    p_result_status TEXT,
    p_candidates JSONB
)
RETURNS TABLE (classification TEXT, kind TEXT, candidate JSONB, candidate_count INTEGER)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows JSONB := CASE WHEN jsonb_typeof(p_candidates) = 'array' THEN p_candidates ELSE '[]'::JSONB END;
    total INTEGER;
    contractor_name TEXT := public.nj_pwc_normalize_name(p_contractor_name);
    known TEXT[];
    cert_matches JSONB;
    name_matches JSONB;
    selected JSONB;
BEGIN
    total := jsonb_array_length(v_rows);
    SELECT coalesce(array_agg(DISTINCT public.nj_pwc_normalize_certificate(k)) FILTER (
               WHERE public.nj_pwc_normalize_certificate(k) IS NOT NULL), ARRAY[]::TEXT[])
    INTO known
    FROM unnest(coalesce(p_known_certificates, ARRAY[]::TEXT[])) AS k;

    IF p_result_status IN ('Website Error', 'RPA Error') THEN
        RETURN QUERY SELECT 'Registry Unavailable'::TEXT, 'infrastructure'::TEXT, NULL::JSONB, total;
        RETURN;
    END IF;
    IF p_result_status = 'Invalid Search' THEN
        RETURN QUERY SELECT 'Invalid Search'::TEXT, 'infrastructure'::TEXT, NULL::JSONB, total;
        RETURN;
    END IF;
    IF p_result_status = 'No Match Found' OR total = 0 THEN
        RETURN QUERY SELECT 'No Match Found'::TEXT, 'failure'::TEXT, NULL::JSONB, total;
        RETURN;
    END IF;

    SELECT coalesce(jsonb_agg(c), '[]'::JSONB) INTO cert_matches
    FROM jsonb_array_elements(v_rows) AS c
    WHERE public.nj_pwc_normalize_certificate(c->>'certificate_number') = ANY(known);

    IF jsonb_array_length(cert_matches) > 1 THEN
        RETURN QUERY SELECT 'Registry Anomaly'::TEXT, 'review'::TEXT, cert_matches->0, total;
        RETURN;
    END IF;

    IF jsonb_array_length(cert_matches) = 1 THEN
        -- Exactly one row carries the contractor's certificate: treated as
        -- the exact match even when the search returned several rows.
        selected := cert_matches->0;
        IF contractor_name IS NULL
           OR public.nj_pwc_normalize_name(selected->>'business_name') IS DISTINCT FROM contractor_name THEN
            RETURN QUERY SELECT 'Name Mismatch'::TEXT, 'failure'::TEXT, selected, total;
        ELSIF public.nj_pwc_candidate_is_anomalous(selected) THEN
            RETURN QUERY SELECT 'Registry Anomaly'::TEXT, 'review'::TEXT, selected, total;
        ELSIF public.nj_pwc_try_date(selected->>'expiration_date') < CURRENT_DATE THEN
            RETURN QUERY SELECT 'Expired Registration'::TEXT, 'review'::TEXT, selected, total;
        ELSE
            RETURN QUERY SELECT 'Exact Match'::TEXT, 'success'::TEXT, selected, total;
        END IF;
        RETURN;
    END IF;

    SELECT coalesce(jsonb_agg(c), '[]'::JSONB) INTO name_matches
    FROM jsonb_array_elements(v_rows) AS c
    WHERE contractor_name IS NOT NULL
      AND public.nj_pwc_normalize_name(c->>'business_name') = contractor_name;

    IF jsonb_array_length(name_matches) = 1 THEN
        RETURN QUERY SELECT 'Certificate Changed'::TEXT, 'review'::TEXT, name_matches->0, total;
    ELSIF jsonb_array_length(name_matches) > 1 OR total > 1 THEN
        RETURN QUERY SELECT 'Multiple Matches'::TEXT, 'failure'::TEXT, NULL::JSONB, total;
    ELSE
        RETURN QUERY SELECT 'Name Mismatch'::TEXT, 'failure'::TEXT, NULL::JSONB, total;
    END IF;
END;
$$;

-- User-selected import: NULL means high confidence; otherwise the reason
-- the selection must be reviewed even in auto_approve mode.
CREATE OR REPLACE FUNCTION public.nj_pwc_import_review_reason(
    p_contractor_name TEXT,
    p_active_registration TEXT,
    p_candidate JSONB,
    p_duplicate_rows INTEGER
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF coalesce(p_duplicate_rows, 0) > 1 OR public.nj_pwc_candidate_is_anomalous(p_candidate) THEN
        RETURN 'Registry Anomaly';
    END IF;
    IF public.nj_pwc_try_date(p_candidate->>'expiration_date') < CURRENT_DATE THEN
        RETURN 'Expired Registration';
    END IF;
    IF public.nj_pwc_normalize_name(p_contractor_name) IS NULL
       OR public.nj_pwc_normalize_name(p_candidate->>'business_name')
          IS DISTINCT FROM public.nj_pwc_normalize_name(p_contractor_name) THEN
        RETURN 'Name Mismatch';
    END IF;
    IF public.nj_pwc_normalize_certificate(p_active_registration) IS NOT NULL
       AND public.nj_pwc_normalize_certificate(p_active_registration)
           <> public.nj_pwc_normalize_certificate(p_candidate->>'certificate_number') THEN
        RETURN 'Certificate Changed';
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------
-- Internal write helpers (not granted to any API role)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.nj_pwc_compliance_type_id()
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id INTEGER;
BEGIN
    SELECT ct.id INTO v_id FROM public.compliance_types ct
    WHERE ct.compliance_name = 'NJ PWC'
    ORDER BY ct.active DESC, ct.id
    LIMIT 1;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'NJ PWC compliance type is not configured'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    RETURN v_id;
END;
$$;

-- PL/pgSQL so the parameter's fields are resolved at call time rather than
-- when the function is created.
CREATE OR REPLACE FUNCTION public.nj_pwc_record_snapshot(p_record public.compliance_records)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_record.id IS NULL THEN
        RETURN NULL;
    END IF;
    RETURN jsonb_build_object(
        'compliance_record_id', p_record.id,
        'registration_number', p_record.registration_number,
        'effective_date', p_record.effective_date,
        'expiration_date', p_record.expiration_date,
        'verified_date', p_record.verified_date,
        'registry_status', p_record.registry_status,
        'active', p_record.active,
        'is_current', p_record.is_current
    );
END;
$$;

-- Apply a registry-confirmed certificate. If the active record already
-- carries the same certificate and dates, only verification data is
-- refreshed (no duplicate). Otherwise the prior active record is
-- deactivated and a new active version is inserted; history is never
-- overwritten in place.
CREATE OR REPLACE FUNCTION public.nj_pwc_apply_certificate(
    p_contractor_id INTEGER,
    p_candidate JSONB,
    p_verified_by TEXT,
    p_verification_source TEXT,
    p_sync_run_id INTEGER,
    p_notes TEXT
)
RETURNS TABLE (record_id INTEGER, record_action TEXT, old_values JSONB, new_values JSONB)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_cert TEXT := public.nj_pwc_normalize_certificate(p_candidate->>'certificate_number');
    v_effective DATE := public.nj_pwc_try_date(p_candidate->>'registration_date');
    v_expiration DATE := public.nj_pwc_try_date(p_candidate->>'expiration_date');
    v_current public.compliance_records%ROWTYPE;
    v_found BOOLEAN;
    v_new public.compliance_records%ROWTYPE;
    v_action TEXT;
BEGIN
    IF v_cert IS NULL THEN
        RAISE EXCEPTION 'NJ PWC certificate number is required' USING ERRCODE = 'check_violation';
    END IF;

    SELECT * INTO v_current FROM public.compliance_records cr
    WHERE cr.contractor_id = p_contractor_id
      AND cr.compliance_type_id = v_type_id
      AND cr.active AND cr.is_current
    ORDER BY cr.id DESC
    LIMIT 1
    FOR UPDATE;
    v_found := FOUND;

    IF v_found
       AND public.nj_pwc_normalize_certificate(v_current.registration_number) = v_cert
       AND v_current.effective_date IS NOT DISTINCT FROM coalesce(v_effective, v_current.effective_date)
       AND v_current.expiration_date IS NOT DISTINCT FROM v_expiration
       AND coalesce(v_current.registry_status, 'OK') <> 'Expired - Not Found in Registry' THEN
        UPDATE public.compliance_records cr SET
            verified_date = CURRENT_DATE,
            verified_by = left(p_verified_by, 200),
            registry_status = 'OK',
            registry_status_updated_at = CASE WHEN cr.registry_status IS DISTINCT FROM 'OK' THEN now() ELSE cr.registry_status_updated_at END,
            last_registry_sync_at = now(),
            synced_registration_number = v_cert,
            synced_effective_date = v_effective,
            synced_expiration_date = v_expiration,
            synced_last_verified_at = now(),
            last_sync_at = now(),
            sync_source = 'RPA',
            sync_status = 'Approved',
            sync_run_id = coalesce(p_sync_run_id, cr.sync_run_id),
            certificate_number = v_cert,
            matched_company_name = coalesce(p_candidate->>'business_name', cr.matched_company_name),
            source_url = coalesce(p_candidate->>'source_url', cr.source_url),
            updated_at = now()
        WHERE cr.id = v_current.id
        RETURNING * INTO v_new;
        v_action := 'refreshed';
    ELSE
        UPDATE public.compliance_records cr
        SET active = FALSE, is_current = FALSE, updated_at = now()
        WHERE cr.contractor_id = p_contractor_id
          AND cr.compliance_type_id = v_type_id
          AND (cr.active OR cr.is_current);

        INSERT INTO public.compliance_records(
            contractor_id, compliance_type_id, registration_number, effective_date, expiration_date,
            verified_date, verified_by, verification_source, is_current, active, notes,
            registry_status, registry_status_updated_at, last_registry_sync_at,
            synced_registration_number, synced_effective_date, synced_expiration_date,
            synced_last_verified_at, last_sync_at, sync_source, sync_status, sync_run_id,
            certificate_number, matched_company_name, source_url
        )
        VALUES (
            p_contractor_id, v_type_id, v_cert, v_effective, v_expiration,
            CURRENT_DATE, left(p_verified_by, 200), p_verification_source, TRUE, TRUE, p_notes,
            'OK', now(), now(),
            v_cert, v_effective, v_expiration,
            now(), now(), 'RPA', 'Approved', p_sync_run_id,
            v_cert, p_candidate->>'business_name', p_candidate->>'source_url'
        )
        RETURNING * INTO v_new;
        v_action := CASE WHEN v_found THEN 'versioned' ELSE 'created' END;
    END IF;

    UPDATE public.contractors c
    SET nj_pwc_number = v_cert, updated_at = now()
    WHERE c.id = p_contractor_id
      AND public.nj_pwc_normalize_certificate(c.nj_pwc_number) IS DISTINCT FROM v_cert;

    RETURN QUERY SELECT v_new.id, v_action,
        CASE WHEN v_found THEN public.nj_pwc_record_snapshot(v_current) ELSE NULL END,
        public.nj_pwc_record_snapshot(v_new);
END;
$$;

-- Registry-confirmed expiration: deactivate the prior active record and
-- insert a new active version flagged 'Expired - Not Found in Registry'.
CREATE OR REPLACE FUNCTION public.nj_pwc_expire_active_record(
    p_contractor_id INTEGER,
    p_actor_name TEXT,
    p_sync_run_id INTEGER,
    p_note TEXT
)
RETURNS TABLE (record_id INTEGER, record_action TEXT, old_values JSONB, new_values JSONB)
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_current public.compliance_records%ROWTYPE;
    v_new public.compliance_records%ROWTYPE;
BEGIN
    SELECT * INTO v_current FROM public.compliance_records cr
    WHERE cr.contractor_id = p_contractor_id
      AND cr.compliance_type_id = v_type_id
      AND cr.active AND cr.is_current
    ORDER BY cr.id DESC
    LIMIT 1
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT NULL::INTEGER, 'no_active_record'::TEXT, NULL::JSONB, NULL::JSONB;
        RETURN;
    END IF;
    IF v_current.registry_status = 'Expired - Not Found in Registry' THEN
        RETURN QUERY SELECT v_current.id, 'unchanged'::TEXT,
            public.nj_pwc_record_snapshot(v_current), public.nj_pwc_record_snapshot(v_current);
        RETURN;
    END IF;

    UPDATE public.compliance_records cr
    SET active = FALSE, is_current = FALSE, updated_at = now()
    WHERE cr.contractor_id = p_contractor_id
      AND cr.compliance_type_id = v_type_id
      AND (cr.active OR cr.is_current);

    INSERT INTO public.compliance_records(
        contractor_id, compliance_type_id, registration_number, effective_date, expiration_date,
        verified_date, verified_by, verification_source, is_current, active, notes,
        registry_status, registry_status_updated_at, last_registry_sync_at,
        sync_source, sync_status, sync_run_id, certificate_number, matched_company_name, source_url
    )
    VALUES (
        v_current.contractor_id, v_current.compliance_type_id, v_current.registration_number,
        v_current.effective_date, v_current.expiration_date,
        v_current.verified_date, v_current.verified_by, v_current.verification_source, TRUE, TRUE,
        coalesce(p_note, 'NJ PWC registration not found in the registry after consecutive sync failures.'),
        'Expired - Not Found in Registry', now(), now(),
        'RPA', 'Approved', p_sync_run_id, v_current.certificate_number,
        v_current.matched_company_name, v_current.source_url
    )
    RETURNING * INTO v_new;

    RETURN QUERY SELECT v_new.id, 'expired'::TEXT,
        public.nj_pwc_record_snapshot(v_current), public.nj_pwc_record_snapshot(v_new);
END;
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_write_audit(
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_email TEXT,
    p_action TEXT,
    p_object_type TEXT,
    p_object_id TEXT,
    p_object_label TEXT,
    p_details JSONB
)
RETURNS VOID
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    INSERT INTO public.administration_audit_log(
        user_id, user_name, user_email, action, object_type, object_id, object_label, details
    )
    VALUES (
        p_actor_id,
        coalesce(nullif(btrim(p_actor_name), ''), 'NJ PWC Daily Sync'),
        coalesce(p_actor_email, ''),
        p_action,
        p_object_type,
        p_object_id,
        coalesce(p_object_label, ''),
        coalesce(p_details, '{}'::JSONB)
    );
$$;

-- Test Mode (shadow mode) audit naming: NJ_PWC_X -> NJ_PWC_TEST_MODE_X so
-- dry-run observations are never mistaken for real compliance updates.
CREATE OR REPLACE FUNCTION public.nj_pwc_audit_action(p_action TEXT, p_is_test BOOLEAN)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN coalesce(p_is_test, FALSE) AND p_action LIKE 'NJ\_PWC\_%' AND p_action NOT LIKE 'NJ\_PWC\_TEST\_MODE\_%'
        THEN 'NJ_PWC_TEST_MODE_' || substr(p_action, 8) ELSE p_action END;
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_audit_label(p_label TEXT, p_is_test BOOLEAN)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN coalesce(p_is_test, FALSE) THEN '[TEST MODE] ' || coalesce(p_label, '') ELSE p_label END;
$$;

-- One open exception per (contractor, reason, is_test); repeated
-- detections update the same row.
CREATE OR REPLACE FUNCTION public.nj_pwc_upsert_exception(
    p_contractor_id INTEGER,
    p_is_test BOOLEAN,
    p_reason TEXT,
    p_kind TEXT,
    p_failure_count INTEGER,
    p_run_id INTEGER,
    p_search_request_id INTEGER,
    p_review_queue_id INTEGER,
    p_details JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_id INTEGER;
BEGIN
    INSERT INTO public.nj_pwc_sync_exceptions AS e(
        contractor_id, is_test, reason, kind, status, consecutive_failure_count, occurrences,
        first_detected_at, last_attempt_at, last_run_id, last_search_request_id, review_queue_id, details
    )
    VALUES (
        p_contractor_id, p_is_test, p_reason, p_kind, 'open', coalesce(p_failure_count, 0), 1,
        now(), now(), p_run_id, p_search_request_id, p_review_queue_id, coalesce(p_details, '{}'::JSONB)
    )
    ON CONFLICT (contractor_id, reason, is_test) WHERE status = 'open'
    DO UPDATE SET
        kind = EXCLUDED.kind,
        consecutive_failure_count = EXCLUDED.consecutive_failure_count,
        occurrences = e.occurrences + 1,
        last_attempt_at = now(),
        last_run_id = coalesce(EXCLUDED.last_run_id, e.last_run_id),
        last_search_request_id = EXCLUDED.last_search_request_id,
        review_queue_id = coalesce(EXCLUDED.review_queue_id, e.review_queue_id),
        details = EXCLUDED.details,
        updated_at = now()
    RETURNING e.id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_resolve_exceptions(
    p_contractor_id INTEGER,
    p_is_test BOOLEAN,
    p_kinds TEXT[],
    p_resolved_by TEXT,
    p_note TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.nj_pwc_sync_exceptions e
    SET status = 'resolved',
        resolved_by = left(p_resolved_by, 200),
        resolved_at = now(),
        resolution_note = p_note,
        updated_at = now()
    WHERE e.contractor_id = p_contractor_id
      AND e.is_test = p_is_test
      AND e.status = 'open'
      AND (p_kinds IS NULL OR e.kind = ANY(p_kinds));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_lock_state(p_contractor_id INTEGER, p_is_test BOOLEAN)
RETURNS public.nj_pwc_sync_state
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_state public.nj_pwc_sync_state%ROWTYPE;
BEGIN
    INSERT INTO public.nj_pwc_sync_state(contractor_id, is_test)
    VALUES (p_contractor_id, p_is_test)
    ON CONFLICT (contractor_id, is_test) DO NOTHING;
    SELECT * INTO v_state FROM public.nj_pwc_sync_state s
    WHERE s.contractor_id = p_contractor_id AND s.is_test = p_is_test
    FOR UPDATE;
    RETURN v_state;
END;
$$;

-- Reuse the latest pending NJ PWC review for the contractor (one open
-- decision per contractor) or create one.
CREATE OR REPLACE FUNCTION public.nj_pwc_upsert_review(
    p_contractor_id INTEGER,
    p_sync_run_id INTEGER,
    p_search_request_id INTEGER,
    p_review_reason TEXT,
    p_result_status TEXT,
    p_candidate JSONB,
    p_proposed_status TEXT,
    p_exception_message TEXT,
    p_raw_summary TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_active public.compliance_records%ROWTYPE;
    v_review_id INTEGER;
    v_cert TEXT := public.nj_pwc_normalize_certificate(p_candidate->>'certificate_number');
BEGIN
    SELECT * INTO v_active FROM public.compliance_records cr
    WHERE cr.contractor_id = p_contractor_id
      AND cr.compliance_type_id = v_type_id
      AND cr.active AND cr.is_current
    ORDER BY cr.id DESC
    LIMIT 1;

    SELECT q.id INTO v_review_id FROM public.compliance_sync_review_queue q
    WHERE q.contractor_id = p_contractor_id
      AND q.compliance_name = 'NJ PWC'
      AND q.status = 'pending'
      AND NOT q.is_test
    ORDER BY q.created_at DESC, q.id DESC
    LIMIT 1
    FOR UPDATE;

    IF v_review_id IS NOT NULL THEN
        -- The run/contractor uniqueness index allows one row per run, so a
        -- reused row only adopts the new run when no sibling holds it.
        UPDATE public.compliance_sync_review_queue q SET
            sync_run_id = CASE WHEN EXISTS (
                SELECT 1 FROM public.compliance_sync_review_queue o
                WHERE o.sync_run_id = p_sync_run_id AND o.contractor_id = p_contractor_id
                  AND o.compliance_name = 'NJ PWC' AND o.id <> q.id
            ) THEN q.sync_run_id ELSE p_sync_run_id END,
            compliance_record_id = v_active.id,
            proposed_registration_number = v_cert,
            proposed_status = p_proposed_status,
            proposed_expiration_date = public.nj_pwc_try_date(p_candidate->>'expiration_date'),
            synced_effective_date_proposed = public.nj_pwc_try_date(p_candidate->>'registration_date'),
            current_registration_number = v_active.registration_number,
            current_effective_date = v_active.effective_date,
            current_expiration_date = v_active.expiration_date,
            certificate_number = v_cert,
            matched_registration_number = v_cert,
            matched_company_name = left(p_candidate->>'business_name', 200),
            source_url = p_candidate->>'source_url',
            last_verified = now(),
            result_status = p_result_status,
            exception_message = p_exception_message,
            raw_result_summary = p_raw_summary,
            review_reason = p_review_reason,
            search_request_id = p_search_request_id,
            result_key = 'nj-pwc:' || coalesce(p_sync_run_id::TEXT, '-') || ':' || p_contractor_id::TEXT,
            updated_at = now()
        WHERE q.id = v_review_id;
        RETURN v_review_id;
    END IF;

    INSERT INTO public.compliance_sync_review_queue(
        sync_run_id, contractor_id, compliance_record_id, compliance_name,
        proposed_registration_number, proposed_status, proposed_expiration_date, synced_effective_date_proposed,
        current_registration_number, current_effective_date, current_expiration_date,
        status, sync_source, certificate_number, matched_registration_number, matched_company_name,
        source_url, last_verified, result_status, exception_message, raw_result_summary,
        review_reason, search_request_id, result_key, is_test
    )
    VALUES (
        p_sync_run_id, p_contractor_id, v_active.id, 'NJ PWC',
        v_cert, p_proposed_status, public.nj_pwc_try_date(p_candidate->>'expiration_date'),
        public.nj_pwc_try_date(p_candidate->>'registration_date'),
        v_active.registration_number, v_active.effective_date, v_active.expiration_date,
        'pending', 'RPA', v_cert, v_cert, left(p_candidate->>'business_name', 200),
        p_candidate->>'source_url', now(), p_result_status, p_exception_message, p_raw_summary,
        p_review_reason, p_search_request_id,
        'nj-pwc:' || coalesce(p_sync_run_id::TEXT, '-') || ':' || p_contractor_id::TEXT, FALSE
    )
    RETURNING id INTO v_review_id;
    RETURN v_review_id;
END;
$$;

-- Records an already-decided (approved) review entry so the Review Queue
-- history shows automatic approvals alongside manual ones.
CREATE OR REPLACE FUNCTION public.nj_pwc_insert_approved_review(
    p_contractor_id INTEGER,
    p_sync_run_id INTEGER,
    p_search_request_id INTEGER,
    p_candidate JSONB,
    p_old_values JSONB,
    p_record_id INTEGER,
    p_approval_source TEXT,
    p_reviewed_by TEXT,
    p_notes TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_review_id INTEGER;
    v_cert TEXT := public.nj_pwc_normalize_certificate(p_candidate->>'certificate_number');
BEGIN
    INSERT INTO public.compliance_sync_review_queue(
        sync_run_id, contractor_id, compliance_record_id, compliance_name,
        proposed_registration_number, proposed_expiration_date, synced_effective_date_proposed,
        current_registration_number, current_effective_date, current_expiration_date,
        status, sync_source, certificate_number, matched_registration_number, matched_company_name,
        source_url, last_verified, result_status, approval_source, reviewed_by, reviewed_at, review_notes,
        search_request_id, result_key, is_test
    )
    VALUES (
        p_sync_run_id, p_contractor_id, p_record_id, 'NJ PWC',
        v_cert, public.nj_pwc_try_date(p_candidate->>'expiration_date'),
        public.nj_pwc_try_date(p_candidate->>'registration_date'),
        p_old_values->>'registration_number',
        public.nj_pwc_try_date(p_old_values->>'effective_date'),
        public.nj_pwc_try_date(p_old_values->>'expiration_date'),
        'approved', 'RPA', v_cert, v_cert, left(p_candidate->>'business_name', 200),
        p_candidate->>'source_url', now(), 'Match Found', p_approval_source,
        left(p_reviewed_by, 200), now(), p_notes,
        p_search_request_id,
        'nj-pwc:' || coalesce(p_sync_run_id::TEXT, '-') || ':' || p_contractor_id::TEXT, FALSE
    )
    ON CONFLICT DO NOTHING
    RETURNING id INTO v_review_id;
    RETURN v_review_id;
END;
$$;

-- Pending NJ PWC reviews made obsolete by a newer approved decision.
CREATE OR REPLACE FUNCTION public.nj_pwc_supersede_pending_reviews(
    p_contractor_id INTEGER,
    p_except_review_id INTEGER,
    p_reviewed_by TEXT,
    p_reason TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count INTEGER;
BEGIN
    UPDATE public.compliance_sync_review_queue q
    SET status = 'rejected',
        rejection_reason = p_reason,
        reviewed_by = left(p_reviewed_by, 200),
        reviewed_at = now(),
        updated_at = now()
    WHERE q.contractor_id = p_contractor_id
      AND q.compliance_name = 'NJ PWC'
      AND q.status = 'pending'
      AND NOT q.is_test
      AND q.id IS DISTINCT FROM p_except_review_id;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Registry confirmed the certificate: clear live/test investigation state.
CREATE OR REPLACE FUNCTION public.nj_pwc_mark_sync_success(
    p_contractor_id INTEGER,
    p_is_test BOOLEAN,
    p_search_request_id INTEGER,
    p_run_id INTEGER,
    p_resolved_by TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.nj_pwc_lock_state(p_contractor_id, p_is_test);
    UPDATE public.nj_pwc_sync_state s SET
        state = 'OK',
        consecutive_failure_count = 0,
        last_reason = 'Exact Match',
        last_attempt_at = now(),
        last_successful_sync_at = now(),
        last_search_request_id = coalesce(p_search_request_id, s.last_search_request_id),
        last_run_id = coalesce(p_run_id, s.last_run_id),
        pending_expiration_run_id = NULL,
        expired_at = NULL,
        updated_at = now()
    WHERE s.contractor_id = p_contractor_id AND s.is_test = p_is_test;
    PERFORM public.nj_pwc_resolve_exceptions(
        p_contractor_id, p_is_test, NULL, p_resolved_by, 'Registry confirmed the NJ PWC registration.'
    );
END;
$$;

-- =====================================================================
-- Entry point: user-selected NJ PWC import
-- =====================================================================
CREATE OR REPLACE FUNCTION public.import_nj_pwc_candidate(
    p_search_request_id INTEGER,
    p_contractor_id INTEGER,
    p_certificate_number TEXT,
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_email TEXT
)
RETURNS TABLE (
    sync_run_id INTEGER,
    review_queue_id INTEGER,
    approval TEXT,
    review_reason TEXT,
    compliance_record_id INTEGER,
    record_action TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_contractor public.contractors%ROWTYPE;
    v_request public.compliance_sync_search_requests%ROWTYPE;
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_cert TEXT := public.nj_pwc_normalize_certificate(p_certificate_number);
    v_candidate JSONB;
    v_duplicates INTEGER;
    v_active public.compliance_records%ROWTYPE;
    v_reason TEXT;
    v_run_id INTEGER;
    v_review_id INTEGER;
    v_apply RECORD;
    v_approval TEXT;
    v_record_id INTEGER;
    v_record_action TEXT;
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name), ''), 'Unknown user');
BEGIN
    IF v_cert IS NULL THEN
        RAISE EXCEPTION 'certificate_number is required' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_settings FROM public.compliance_sync_settings s
    WHERE s.compliance_name = 'NJ PWC'
    FOR SHARE;
    IF NOT FOUND OR NOT v_settings.enabled THEN
        RAISE EXCEPTION 'NJ PWC compliance sync is disabled' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT * INTO v_contractor FROM public.contractors c WHERE c.id = p_contractor_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Contractor not found' USING ERRCODE = 'no_data_found';
    END IF;

    SELECT * INTO v_request FROM public.compliance_sync_search_requests r
    WHERE r.id = p_search_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Search request not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_request.compliance_name <> 'NJ PWC' THEN
        RAISE EXCEPTION 'Search request is not an NJ PWC search' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_request.status <> 'completed'
       OR v_request.result_status NOT IN ('Match Found', 'Multiple Matches') THEN
        RAISE EXCEPTION 'Search request has no importable results' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF v_request.contractor_id IS NOT NULL AND v_request.contractor_id <> p_contractor_id THEN
        RAISE EXCEPTION 'Search request belongs to a different contractor' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF v_request.imported_at IS NOT NULL THEN
        IF v_request.contractor_id = p_contractor_id
           AND public.nj_pwc_normalize_certificate(v_request.imported_certificate_number) = v_cert THEN
            -- Idempotent replay of the same import.
            RETURN QUERY
            SELECT q.sync_run_id, q.id,
                   (CASE WHEN q.status = 'approved' THEN 'auto_approved'
                        WHEN q.status = 'pending' THEN 'review_required'
                        ELSE q.status END)::TEXT,
                   q.review_reason::TEXT, q.compliance_record_id, 'already_imported'::TEXT
            FROM public.compliance_sync_review_queue q
            WHERE q.id = v_request.import_review_queue_id;
            IF NOT FOUND THEN
                RETURN QUERY SELECT NULL::INTEGER, NULL::INTEGER, 'already_imported'::TEXT,
                    NULL::TEXT, NULL::INTEGER, 'already_imported'::TEXT;
            END IF;
            RETURN;
        END IF;
        RAISE EXCEPTION 'Search request was already imported' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- The selected candidate must exist in the stored registry results;
    -- client-supplied candidate fields are never trusted.
    SELECT count(*), (array_agg(c))[1] INTO v_duplicates, v_candidate
    FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(v_request.candidates) = 'array' THEN v_request.candidates ELSE '[]'::JSONB END
    ) AS c
    WHERE public.nj_pwc_normalize_certificate(c->>'certificate_number') = v_cert;
    IF coalesce(v_duplicates, 0) = 0 THEN
        RAISE EXCEPTION 'Selected certificate is not in the stored search results' USING ERRCODE = 'check_violation';
    END IF;
    v_candidate := v_candidate || jsonb_build_object(
        'source_url', coalesce(v_candidate->>'source_url', v_request.source_url)
    );

    SELECT * INTO v_active FROM public.compliance_records cr
    WHERE cr.contractor_id = p_contractor_id
      AND cr.compliance_type_id = v_type_id
      AND cr.active AND cr.is_current
    ORDER BY cr.id DESC
    LIMIT 1
    FOR UPDATE;

    v_reason := public.nj_pwc_import_review_reason(
        v_contractor.company_name, v_active.registration_number, v_candidate, v_duplicates
    );

    INSERT INTO public.compliance_sync_runs(
        run_at, started_at, completed_at, sync_source, run_status, status,
        records_checked, changes_detected, records_approved, records_rejected, records_failed, failures,
        initiated_by, triggered_by, is_test, run_type, notes
    )
    VALUES (
        now(), now(), now(), 'RPA', 'Completed', 'completed',
        1, 0, 0, 0, 0, 0,
        left(v_actor, 200), left(v_actor, 200), FALSE, 'nj_pwc_import',
        'NJ PWC user-selected import (search request ' || p_search_request_id || ').'
    )
    RETURNING id INTO v_run_id;

    IF v_settings.mode = 'auto_approve' AND v_reason IS NULL THEN
        SELECT * INTO v_apply FROM public.nj_pwc_apply_certificate(
            p_contractor_id, v_candidate, v_actor, 'NJ PWC Registry (User Selected Import)', v_run_id,
            'Created from user-selected NJ PWC import (search request ' || p_search_request_id || ').'
        );
        v_review_id := public.nj_pwc_insert_approved_review(
            p_contractor_id, v_run_id, p_search_request_id, v_candidate, v_apply.old_values,
            v_apply.record_id, 'User Selected Import', v_actor,
            'Approved by explicit user selection (auto_approve mode).'
        );
        PERFORM public.nj_pwc_supersede_pending_reviews(
            p_contractor_id, v_review_id, v_actor, 'Superseded by user-selected NJ PWC import'
        );
        PERFORM public.nj_pwc_mark_sync_success(p_contractor_id, FALSE, p_search_request_id, NULL, v_actor);
        UPDATE public.compliance_sync_runs r
        SET changes_detected = CASE WHEN v_apply.record_action = 'refreshed' THEN 0 ELSE 1 END,
            records_approved = 1
        WHERE r.id = v_run_id;
        v_approval := CASE WHEN v_apply.record_action = 'refreshed' THEN 'refreshed' ELSE 'auto_approved' END;
        v_record_id := v_apply.record_id;
        v_record_action := v_apply.record_action;

        PERFORM public.nj_pwc_write_audit(
            p_actor_id, v_actor, p_actor_email, 'NJ_PWC_IMPORT_AUTO_APPROVED', 'contractor',
            p_contractor_id::TEXT, v_contractor.company_name,
            jsonb_build_object(
                'search_request_id', p_search_request_id,
                'sync_run_id', v_run_id,
                'review_queue_id', v_review_id,
                'imported_certificate', v_cert,
                'imported_business_name', v_candidate->>'business_name',
                'compliance_record_id', v_apply.record_id,
                'record_action', v_apply.record_action,
                'mode', v_settings.mode,
                'old_values', v_apply.old_values,
                'new_values', v_apply.new_values
            )
        );
    ELSE
        v_review_id := public.nj_pwc_upsert_review(
            p_contractor_id, v_run_id, p_search_request_id,
            coalesce(v_reason, 'Review Required Mode'),
            'Match Found', v_candidate, NULL, NULL,
            'NJ PWC user-selected import.'
        );
        IF v_active.id IS NOT NULL THEN
            UPDATE public.compliance_records cr SET
                synced_registration_number = v_cert,
                synced_effective_date = public.nj_pwc_try_date(v_candidate->>'registration_date'),
                synced_expiration_date = public.nj_pwc_try_date(v_candidate->>'expiration_date'),
                synced_last_verified_at = now(),
                last_sync_at = now(),
                sync_source = 'RPA',
                sync_status = 'Pending Review',
                sync_run_id = v_run_id,
                updated_at = now()
            WHERE cr.id = v_active.id;
        END IF;
        v_approval := 'review_required';
        v_record_id := v_active.id;
        v_record_action := 'none';

        PERFORM public.nj_pwc_write_audit(
            p_actor_id, v_actor, p_actor_email, 'NJ_PWC_IMPORT_REVIEW_REQUIRED', 'contractor',
            p_contractor_id::TEXT, v_contractor.company_name,
            jsonb_build_object(
                'search_request_id', p_search_request_id,
                'sync_run_id', v_run_id,
                'review_queue_id', v_review_id,
                'imported_certificate', v_cert,
                'imported_business_name', v_candidate->>'business_name',
                'review_reason', coalesce(v_reason, 'Review Required Mode'),
                'mode', v_settings.mode,
                'old_values', public.nj_pwc_record_snapshot(v_active),
                'proposed_values', jsonb_build_object(
                    'registration_number', v_cert,
                    'effective_date', v_candidate->>'registration_date',
                    'expiration_date', v_candidate->>'expiration_date'
                )
            )
        );
    END IF;

    UPDATE public.compliance_sync_search_requests r SET
        contractor_id = p_contractor_id,
        selected_candidate = v_candidate,
        imported_at = now(),
        imported_by = left(v_actor, 200),
        imported_certificate_number = v_cert,
        import_review_queue_id = v_review_id,
        updated_at = now()
    WHERE r.id = p_search_request_id;

    RETURN QUERY SELECT v_run_id, v_review_id, v_approval,
        CASE WHEN v_approval = 'review_required' THEN coalesce(v_reason, 'Review Required Mode') ELSE NULL END,
        v_record_id, v_record_action;
END;
$$;

-- =====================================================================
-- Entry points: manual review decisions
-- =====================================================================
CREATE OR REPLACE FUNCTION public.approve_nj_pwc_review(
    p_review_id INTEGER,
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_email TEXT,
    p_notes TEXT
)
RETURNS TABLE (review_queue_id INTEGER, compliance_record_id INTEGER, record_action TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_review public.compliance_sync_review_queue%ROWTYPE;
    v_contractor public.contractors%ROWTYPE;
    v_candidate JSONB;
    v_apply RECORD;
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name), ''), 'Unknown user');
    v_action TEXT;
BEGIN
    SELECT * INTO v_review FROM public.compliance_sync_review_queue q WHERE q.id = p_review_id;
    IF NOT FOUND OR v_review.compliance_name <> 'NJ PWC' THEN
        RAISE EXCEPTION 'NJ PWC review item not found' USING ERRCODE = 'no_data_found';
    END IF;

    SELECT * INTO v_contractor FROM public.contractors c WHERE c.id = v_review.contractor_id FOR UPDATE;
    SELECT * INTO v_review FROM public.compliance_sync_review_queue q WHERE q.id = p_review_id FOR UPDATE;
    IF v_review.status <> 'pending' THEN
        RAISE EXCEPTION 'Review item is already %', v_review.status USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF v_review.is_test THEN
        RAISE EXCEPTION 'Test-mode review items cannot change compliance records' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    IF v_review.review_reason = 'Expiration Proposed' THEN
        SELECT * INTO v_apply FROM public.nj_pwc_expire_active_record(
            v_review.contractor_id, v_actor, v_review.sync_run_id,
            'NJ PWC registration expiration approved by ' || v_actor || '.'
        );
        UPDATE public.nj_pwc_sync_state s
        SET state = 'Expired', expired_at = now(), pending_expiration_run_id = NULL, updated_at = now()
        WHERE s.contractor_id = v_review.contractor_id AND NOT s.is_test;
        v_action := 'NJ_PWC_EXPIRATION_APPROVED';
    ELSE
        IF public.nj_pwc_normalize_certificate(coalesce(v_review.proposed_registration_number, v_review.certificate_number)) IS NULL THEN
            RAISE EXCEPTION 'Review item has no proposed certificate' USING ERRCODE = 'object_not_in_prerequisite_state';
        END IF;
        v_candidate := jsonb_build_object(
            'certificate_number', coalesce(nullif(btrim(v_review.proposed_registration_number), ''), v_review.certificate_number),
            'registration_date', v_review.synced_effective_date_proposed,
            'expiration_date', v_review.proposed_expiration_date,
            'business_name', v_review.matched_company_name,
            'source_url', v_review.source_url
        );
        SELECT * INTO v_apply FROM public.nj_pwc_apply_certificate(
            v_review.contractor_id, v_candidate, v_actor, 'NJ PWC Registry (Manual Review)',
            v_review.sync_run_id, coalesce(p_notes, 'Approved from NJ PWC review queue.')
        );
        -- An approved expired registration is a registry-confirmed expiry.
        IF public.nj_pwc_try_date(v_candidate->>'expiration_date') >= CURRENT_DATE THEN
            PERFORM public.nj_pwc_mark_sync_success(v_review.contractor_id, FALSE, v_review.search_request_id, NULL, v_actor);
        ELSE
            PERFORM public.nj_pwc_resolve_exceptions(v_review.contractor_id, FALSE, ARRAY['review'], v_actor,
                'Resolved by manual review approval.');
        END IF;
        v_action := 'NJ_PWC_REVIEW_APPROVED';
    END IF;

    UPDATE public.compliance_sync_review_queue q SET
        status = 'approved',
        approval_source = 'Manual Review',
        reviewed_by = left(v_actor, 200),
        reviewed_at = now(),
        review_notes = p_notes,
        compliance_record_id = coalesce(v_apply.record_id, q.compliance_record_id),
        updated_at = now()
    WHERE q.id = p_review_id;

    UPDATE public.nj_pwc_sync_exceptions e
    SET status = 'resolved', resolved_by = left(v_actor, 200), resolved_at = now(),
        resolution_note = 'Resolved by review approval.', updated_at = now()
    WHERE e.review_queue_id = p_review_id AND e.status = 'open';

    PERFORM public.nj_pwc_write_audit(
        p_actor_id, v_actor, p_actor_email, v_action, 'contractor',
        v_review.contractor_id::TEXT, v_contractor.company_name,
        jsonb_build_object(
            'review_queue_id', p_review_id,
            'review_reason', v_review.review_reason,
            'search_request_id', v_review.search_request_id,
            'sync_run_id', v_review.sync_run_id,
            'certificate', v_review.proposed_registration_number,
            'compliance_record_id', v_apply.record_id,
            'record_action', v_apply.record_action,
            'old_values', v_apply.old_values,
            'new_values', v_apply.new_values,
            'notes', p_notes
        )
    );

    RETURN QUERY SELECT p_review_id, v_apply.record_id, v_apply.record_action;
END;
$$;

CREATE OR REPLACE FUNCTION public.reject_nj_pwc_review(
    p_review_id INTEGER,
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_email TEXT,
    p_reason TEXT
)
RETURNS TABLE (review_queue_id INTEGER, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_review public.compliance_sync_review_queue%ROWTYPE;
    v_label TEXT;
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name), ''), 'Unknown user');
BEGIN
    SELECT * INTO v_review FROM public.compliance_sync_review_queue q WHERE q.id = p_review_id FOR UPDATE;
    IF NOT FOUND OR v_review.compliance_name <> 'NJ PWC' THEN
        RAISE EXCEPTION 'NJ PWC review item not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_review.status <> 'pending' THEN
        RAISE EXCEPTION 'Review item is already %', v_review.status USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    UPDATE public.compliance_sync_review_queue q SET
        status = 'rejected',
        rejection_reason = p_reason,
        reviewed_by = left(v_actor, 200),
        reviewed_at = now(),
        updated_at = now()
    WHERE q.id = p_review_id;

    UPDATE public.compliance_records cr
    SET sync_status = 'Rejected', updated_at = now()
    WHERE cr.id = v_review.compliance_record_id AND cr.sync_status = 'Pending Review';

    IF v_review.review_reason = 'Expiration Proposed' THEN
        UPDATE public.nj_pwc_sync_state s
        SET pending_expiration_run_id = NULL, updated_at = now()
        WHERE s.contractor_id = v_review.contractor_id AND NOT s.is_test;
    END IF;

    SELECT c.company_name INTO v_label FROM public.contractors c WHERE c.id = v_review.contractor_id;
    PERFORM public.nj_pwc_write_audit(
        p_actor_id, v_actor, p_actor_email, 'NJ_PWC_REVIEW_REJECTED', 'contractor',
        v_review.contractor_id::TEXT, v_label,
        jsonb_build_object(
            'review_queue_id', p_review_id,
            'review_reason', v_review.review_reason,
            'search_request_id', v_review.search_request_id,
            'proposed_certificate', v_review.proposed_registration_number,
            'rejection_reason', p_reason
        )
    );

    RETURN QUERY SELECT p_review_id, 'rejected'::TEXT;
END;
$$;

-- =====================================================================
-- Entry point: enqueue the daily NJ PWC registry sync
-- Scope: active contractors with an NJ PWC # OR an active NJ PWC record.
-- One run per (date, test_mode); safe to call repeatedly.
-- =====================================================================
CREATE OR REPLACE FUNCTION public.enqueue_nj_pwc_daily_sync(
    p_run_date DATE,
    p_triggered_by TEXT
)
RETURNS TABLE (run_id INTEGER, created BOOLEAN, enqueued INTEGER, is_test BOOLEAN, skipped_reason TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_run_date DATE := coalesce(p_run_date, CURRENT_DATE);
    v_trigger TEXT := coalesce(nullif(btrim(p_triggered_by), ''), 'NJ PWC Daily Sync');
    v_run_id INTEGER;
    v_count INTEGER;
    v_stale RECORD;
BEGIN
    SELECT * INTO v_settings FROM public.compliance_sync_settings s
    WHERE s.compliance_name = 'NJ PWC'
    FOR UPDATE;
    IF NOT FOUND OR NOT v_settings.enabled THEN
        RETURN QUERY SELECT NULL::INTEGER, FALSE, 0, coalesce(v_settings.test_mode, FALSE), 'disabled'::TEXT;
        RETURN;
    END IF;

    FOR v_stale IN
        SELECT r.id FROM public.compliance_sync_runs r
        WHERE r.run_type = 'nj_pwc_daily' AND r.run_status = 'Running' AND r.run_date < v_run_date
        ORDER BY r.id
    LOOP
        PERFORM public.finalize_nj_pwc_daily_run(v_stale.id, TRUE);
    END LOOP;

    SELECT r.id INTO v_run_id FROM public.compliance_sync_runs r
    WHERE r.run_type = 'nj_pwc_daily' AND r.run_date = v_run_date AND r.is_test = v_settings.test_mode;
    IF v_run_id IS NOT NULL THEN
        SELECT count(*) INTO v_count FROM public.compliance_sync_search_requests q WHERE q.sync_run_id = v_run_id;
        RETURN QUERY SELECT v_run_id, FALSE, v_count, v_settings.test_mode, 'already_started'::TEXT;
        RETURN;
    END IF;

    INSERT INTO public.compliance_sync_runs(
        run_at, started_at, sync_source, run_status, status,
        records_checked, changes_detected, records_approved, records_rejected, records_failed, failures,
        initiated_by, triggered_by, is_test, run_type, run_date, notes
    )
    VALUES (
        now(), now(), 'RPA', 'Running', 'completed',
        0, 0, 0, 0, 0, 0,
        left(v_trigger, 200), left(v_trigger, 200), v_settings.test_mode, 'nj_pwc_daily', v_run_date,
        CASE WHEN v_settings.test_mode THEN 'NJ PWC daily registry sync (Test Mode dry run).'
             ELSE 'NJ PWC daily registry sync (mode: ' || v_settings.mode || ').' END
    )
    RETURNING id INTO v_run_id;

    INSERT INTO public.compliance_sync_search_requests(
        compliance_name, searched_company_name, searched_city, searched_state, searched_zip_code,
        status, candidates, is_test, requested_by, contractor_id, origin, priority, sync_run_id
    )
    SELECT 'NJ PWC',
           left(upper(btrim(regexp_replace(c.company_name, '\s+', ' ', 'g'))), 200),
           left(nullif(btrim(c.city), ''), 150),
           left(nullif(btrim(c.state), ''), 100),
           left(nullif(btrim(c.zip_code), ''), 20),
           'pending', '[]'::JSONB, v_settings.test_mode, 'NJ PWC Daily Sync', c.id, 'daily_sync', 20, v_run_id
    FROM public.contractors c
    WHERE c.active
      AND nullif(btrim(c.company_name), '') IS NOT NULL
      AND (
          nullif(btrim(c.nj_pwc_number), '') IS NOT NULL
          OR EXISTS (
              SELECT 1 FROM public.compliance_records cr
              WHERE cr.contractor_id = c.id AND cr.compliance_type_id = v_type_id
                AND cr.active AND cr.is_current
          )
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.compliance_sync_search_requests p
          WHERE p.contractor_id = c.id AND p.compliance_name = 'NJ PWC'
            AND p.status = 'pending' AND p.origin <> 'user'
      )
    ORDER BY c.id;
    GET DIAGNOSTICS v_count = ROW_COUNT;

    PERFORM public.nj_pwc_write_audit(
        NULL, 'NJ PWC Daily Sync', '', public.nj_pwc_audit_action('NJ_PWC_DAILY_SYNC_STARTED', v_settings.test_mode),
        'compliance_sync_run', v_run_id::TEXT,
        public.nj_pwc_audit_label('NJ PWC Daily Sync ' || v_run_date::TEXT, v_settings.test_mode),
        jsonb_build_object('run_date', v_run_date, 'enqueued', v_count, 'is_test', v_settings.test_mode,
                           'test_mode', v_settings.test_mode,
                           'compliance_records_modified', NOT v_settings.test_mode,
                           'mode', v_settings.mode, 'triggered_by', v_trigger)
    );

    IF v_count = 0 THEN
        PERFORM public.finalize_nj_pwc_daily_run(v_run_id, FALSE);
    END IF;

    RETURN QUERY SELECT v_run_id, TRUE, v_count, v_settings.test_mode, NULL::TEXT;
END;
$$;

-- =====================================================================
-- Entry point: worker result for a daily-sync / exception-retry search
-- =====================================================================
CREATE OR REPLACE FUNCTION public.submit_nj_pwc_sync_result(
    p_search_request_id INTEGER,
    p_result_status TEXT,
    p_candidates JSONB,
    p_error_message TEXT,
    p_source_url TEXT,
    p_search_variation TEXT
)
RETURNS TABLE (
    search_request_id INTEGER,
    classification TEXT,
    kind TEXT,
    outcome TEXT,
    consecutive_failure_count INTEGER,
    review_queue_id INTEGER,
    compliance_record_id INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_request public.compliance_sync_search_requests%ROWTYPE;
    v_contractor public.contractors%ROWTYPE;
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_active public.compliance_records%ROWTYPE;
    v_candidates JSONB := CASE WHEN jsonb_typeof(p_candidates) = 'array' THEN p_candidates ELSE '[]'::JSONB END;
    v_class RECORD;
    v_state public.nj_pwc_sync_state%ROWTYPE;
    v_is_test BOOLEAN;
    v_live_auto BOOLEAN;
    v_status TEXT;
    v_outcome TEXT;
    v_count INTEGER;
    v_review_id INTEGER;
    v_record_id INTEGER;
    v_apply RECORD;
    v_candidate JSONB;
    v_differs BOOLEAN;
    v_actor CONSTANT TEXT := 'NJ PWC Daily Sync';
BEGIN
    IF p_result_status IS NULL OR p_result_status NOT IN (
        'Match Found', 'No Match Found', 'Multiple Matches', 'Invalid Search', 'Website Error', 'RPA Error'
    ) THEN
        RAISE EXCEPTION 'result_status is invalid' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_request FROM public.compliance_sync_search_requests r WHERE r.id = p_search_request_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Search request not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF v_request.origin = 'user' OR v_request.contractor_id IS NULL OR v_request.compliance_name <> 'NJ PWC' THEN
        RAISE EXCEPTION 'Search request is not an NJ PWC registry sync request' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO v_contractor FROM public.contractors c WHERE c.id = v_request.contractor_id FOR UPDATE;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests r WHERE r.id = p_search_request_id FOR UPDATE;
    IF v_request.status <> 'pending' THEN
        -- Idempotent: a duplicate worker submission does not re-apply.
        SELECT s.consecutive_failure_count INTO v_count FROM public.nj_pwc_sync_state s
        WHERE s.contractor_id = v_request.contractor_id AND s.is_test = v_request.is_test;
        RETURN QUERY SELECT v_request.id, split_part(coalesce(v_request.sync_outcome, ''), ':', 2),
            split_part(coalesce(v_request.sync_outcome, ''), ':', 1), 'already_processed'::TEXT,
            coalesce(v_count, 0), NULL::INTEGER, NULL::INTEGER;
        RETURN;
    END IF;

    SELECT * INTO v_settings FROM public.compliance_sync_settings s WHERE s.compliance_name = 'NJ PWC';
    v_is_test := v_request.is_test;
    v_live_auto := NOT v_is_test AND v_settings.mode = 'auto_approve';

    SELECT * INTO v_active FROM public.compliance_records cr
    WHERE cr.contractor_id = v_contractor.id AND cr.compliance_type_id = v_type_id
      AND cr.active AND cr.is_current
    ORDER BY cr.id DESC
    LIMIT 1
    FOR UPDATE;

    SELECT * INTO v_class FROM public.nj_pwc_classify_sync_result(
        v_contractor.company_name,
        ARRAY[v_contractor.nj_pwc_number, v_active.registration_number],
        p_result_status,
        v_candidates
    );
    v_candidate := CASE WHEN v_class.candidate IS NULL THEN NULL
        ELSE v_class.candidate || jsonb_build_object('source_url', coalesce(v_class.candidate->>'source_url', p_source_url)) END;

    v_status := CASE
        WHEN p_result_status = 'No Match Found' THEN 'no_match'
        WHEN p_result_status IN ('Match Found', 'Multiple Matches') THEN 'completed'
        ELSE 'failed' END;

    v_state := public.nj_pwc_lock_state(v_contractor.id, v_is_test);
    v_count := v_state.consecutive_failure_count;

    IF v_class.kind = 'success' THEN
        IF v_is_test THEN
            -- Shadow mode: record what Mode WOULD do; never touch records/reviews.
            v_outcome := 'success:dry_run_match';
            v_differs := v_active.id IS NULL
                OR coalesce(v_active.registry_status, 'OK') <> 'OK'
                OR public.nj_pwc_normalize_certificate(v_active.registration_number)
                   IS DISTINCT FROM public.nj_pwc_normalize_certificate(v_candidate->>'certificate_number')
                OR v_active.expiration_date IS DISTINCT FROM public.nj_pwc_try_date(v_candidate->>'expiration_date')
                OR (public.nj_pwc_try_date(v_candidate->>'registration_date') IS NOT NULL
                    AND v_active.effective_date IS DISTINCT FROM public.nj_pwc_try_date(v_candidate->>'registration_date'));
            IF v_differs THEN
                PERFORM public.nj_pwc_write_audit(
                    NULL, v_actor, '',
                    CASE WHEN v_settings.mode = 'auto_approve' THEN 'NJ_PWC_TEST_MODE_WOULD_AUTO_APPROVE'
                         ELSE 'NJ_PWC_TEST_MODE_WOULD_REQUEST_REVIEW' END,
                    'contractor', v_contractor.id::TEXT, public.nj_pwc_audit_label(v_contractor.company_name, TRUE),
                    jsonb_build_object(
                        'test_mode', TRUE,
                        'compliance_records_modified', FALSE,
                        'mode', v_settings.mode,
                        'search_request_id', v_request.id,
                        'sync_run_id', v_request.sync_run_id,
                        'certificate', v_candidate->>'certificate_number',
                        'current_values', public.nj_pwc_record_snapshot(v_active),
                        'proposed_values', jsonb_build_object(
                            'registration_number', v_candidate->>'certificate_number',
                            'effective_date', public.nj_pwc_try_date(v_candidate->>'registration_date'),
                            'expiration_date', public.nj_pwc_try_date(v_candidate->>'expiration_date'),
                            'registry_status', 'OK')
                    )
                );
            END IF;
        ELSIF v_live_auto THEN
            SELECT * INTO v_apply FROM public.nj_pwc_apply_certificate(
                v_contractor.id, v_candidate, v_actor, 'NJ PWC Registry (Daily Sync)', v_request.sync_run_id,
                'Updated by NJ PWC daily registry sync.'
            );
            v_record_id := v_apply.record_id;
            v_outcome := 'success:' || CASE WHEN v_apply.record_action = 'refreshed' THEN 'refreshed' ELSE 'auto_approved' END;
            IF v_apply.record_action <> 'refreshed' THEN
                v_review_id := public.nj_pwc_insert_approved_review(
                    v_contractor.id, v_request.sync_run_id, v_request.id, v_candidate, v_apply.old_values,
                    v_apply.record_id, 'Daily Sync Auto Approve', v_actor,
                    'Exact registry match approved automatically (auto_approve mode).'
                );
                PERFORM public.nj_pwc_write_audit(
                    NULL, v_actor, '', 'NJ_PWC_SYNC_AUTO_APPROVED', 'contractor',
                    v_contractor.id::TEXT, v_contractor.company_name,
                    jsonb_build_object(
                        'search_request_id', v_request.id,
                        'sync_run_id', v_request.sync_run_id,
                        'review_queue_id', v_review_id,
                        'certificate', v_candidate->>'certificate_number',
                        'compliance_record_id', v_apply.record_id,
                        'record_action', v_apply.record_action,
                        'old_values', v_apply.old_values,
                        'new_values', v_apply.new_values
                    )
                );
            END IF;
        ELSE
            v_differs := v_active.id IS NULL
                OR coalesce(v_active.registry_status, 'OK') = 'Expired - Not Found in Registry'
                OR public.nj_pwc_normalize_certificate(v_active.registration_number)
                   IS DISTINCT FROM public.nj_pwc_normalize_certificate(v_candidate->>'certificate_number')
                OR v_active.expiration_date IS DISTINCT FROM public.nj_pwc_try_date(v_candidate->>'expiration_date')
                OR (public.nj_pwc_try_date(v_candidate->>'registration_date') IS NOT NULL
                    AND v_active.effective_date IS DISTINCT FROM public.nj_pwc_try_date(v_candidate->>'registration_date'));
            IF v_differs THEN
                v_review_id := public.nj_pwc_upsert_review(
                    v_contractor.id, v_request.sync_run_id, v_request.id, 'Registry Update', 'Match Found',
                    v_candidate, NULL, NULL, 'NJ PWC daily sync exact match (review_required mode).'
                );
                v_outcome := 'success:review_required_update';
            ELSE
                v_outcome := 'success:verified';
            END IF;
        END IF;
        PERFORM public.nj_pwc_mark_sync_success(v_contractor.id, v_is_test, v_request.id, v_request.sync_run_id, v_actor);
        v_count := 0;
        IF v_review_id IS NOT NULL AND v_outcome = 'success:review_required_update' THEN
            UPDATE public.nj_pwc_sync_state s SET state = 'Review Required', updated_at = now()
            WHERE s.contractor_id = v_contractor.id AND s.is_test = v_is_test;
        END IF;

    ELSIF v_class.kind = 'failure' THEN
        v_count := CASE WHEN v_request.origin = 'exception_retry' THEN greatest(v_count, 1) ELSE v_count + 1 END;
        PERFORM public.nj_pwc_resolve_exceptions(v_contractor.id, v_is_test, ARRAY['infrastructure', 'review'], v_actor,
            'Superseded by a newer registry result.');
        UPDATE public.nj_pwc_sync_exceptions e
        SET status = 'resolved', resolved_by = v_actor, resolved_at = now(),
            resolution_note = 'Superseded by a newer registry result.', updated_at = now()
        WHERE e.contractor_id = v_contractor.id AND e.is_test = v_is_test AND e.status = 'open'
          AND e.kind = 'failure' AND e.reason <> v_class.classification;

        IF NOT v_is_test AND v_class.classification = 'Name Mismatch' AND v_candidate IS NOT NULL THEN
            v_review_id := public.nj_pwc_upsert_review(
                v_contractor.id, v_request.sync_run_id, v_request.id, 'Name Mismatch', p_result_status,
                v_candidate, NULL, 'Registry business name does not match the contractor name.',
                'NJ PWC daily sync name mismatch.'
            );
        END IF;
        IF v_live_auto AND v_active.id IS NOT NULL
           AND coalesce(v_active.registry_status, 'OK') = 'OK' THEN
            UPDATE public.compliance_records cr
            SET registry_status = 'Investigation Required', registry_status_updated_at = now(),
                last_registry_sync_at = now(), updated_at = now()
            WHERE cr.id = v_active.id;
        END IF;

        PERFORM public.nj_pwc_upsert_exception(
            v_contractor.id, v_is_test, v_class.classification, 'failure', v_count,
            v_request.sync_run_id, v_request.id, v_review_id,
            jsonb_build_object('result_status', p_result_status, 'candidate_count', v_class.candidate_count,
                               'search_variation', p_search_variation, 'origin', v_request.origin)
        );
        UPDATE public.nj_pwc_sync_state s SET
            state = CASE WHEN s.state = 'Expired' THEN 'Expired' ELSE 'Investigation Required' END,
            consecutive_failure_count = v_count,
            pending_expiration_run_id = CASE
                WHEN v_request.origin = 'daily_sync' AND s.state <> 'Expired'
                     AND v_count >= coalesce(v_settings.failure_expire_threshold, 3)
                THEN v_request.sync_run_id ELSE s.pending_expiration_run_id END,
            updated_at = now()
        WHERE s.contractor_id = v_contractor.id AND s.is_test = v_is_test;
        v_outcome := 'failure:' || v_class.classification;

    ELSIF v_class.kind = 'review' THEN
        PERFORM public.nj_pwc_resolve_exceptions(v_contractor.id, v_is_test, ARRAY['infrastructure'], v_actor,
            'Registry reachable again.');
        IF NOT v_is_test AND v_candidate IS NOT NULL THEN
            v_review_id := public.nj_pwc_upsert_review(
                v_contractor.id, v_request.sync_run_id, v_request.id, v_class.classification,
                CASE WHEN v_class.candidate_count > 1 THEN 'Multiple Matches' ELSE 'Match Found' END,
                v_candidate, NULL, NULL, 'NJ PWC daily sync result requires review.'
            );
        END IF;
        PERFORM public.nj_pwc_upsert_exception(
            v_contractor.id, v_is_test, v_class.classification, 'review', v_count,
            v_request.sync_run_id, v_request.id, v_review_id,
            jsonb_build_object('result_status', p_result_status, 'candidate_count', v_class.candidate_count,
                               'search_variation', p_search_variation, 'origin', v_request.origin)
        );
        UPDATE public.nj_pwc_sync_state s SET
            state = CASE WHEN s.state = 'Expired' THEN 'Expired' ELSE 'Review Required' END,
            updated_at = now()
        WHERE s.contractor_id = v_contractor.id AND s.is_test = v_is_test;
        v_outcome := 'review:' || v_class.classification;

    ELSE
        -- Registry/worker/website problems never count toward expiration.
        PERFORM public.nj_pwc_upsert_exception(
            v_contractor.id, v_is_test, v_class.classification, 'infrastructure', v_count,
            v_request.sync_run_id, v_request.id, NULL,
            jsonb_build_object('result_status', p_result_status,
                               'error_message', left(p_error_message, 500),
                               'origin', v_request.origin)
        );
        v_outcome := 'infrastructure:' || v_class.classification;
    END IF;

    UPDATE public.nj_pwc_sync_state s SET
        last_reason = v_class.classification,
        last_attempt_at = now(),
        last_search_request_id = v_request.id,
        last_run_id = coalesce(v_request.sync_run_id, s.last_run_id),
        updated_at = now()
    WHERE s.contractor_id = v_contractor.id AND s.is_test = v_is_test;

    -- Shadow-mode classification for the dashboard. A newer match replaces
    -- the prior decision; a failure/review result invalidates a pending
    -- "would approve/review" but keeps a "would expire" until a match clears it.
    -- Infrastructure results carry no new information and change nothing.
    IF v_is_test AND v_class.kind IN ('success', 'failure', 'review') THEN
        UPDATE public.nj_pwc_sync_state s SET
            dry_run_action = CASE
                WHEN v_class.kind = 'success' THEN CASE
                    WHEN NOT coalesce(v_differs, FALSE) THEN NULL
                    WHEN v_settings.mode = 'auto_approve' THEN 'would_auto_approve'
                    ELSE 'would_request_review' END
                WHEN s.dry_run_action IN ('would_auto_approve', 'would_request_review') THEN NULL
                ELSE s.dry_run_action END,
            dry_run_action_at = now()
        WHERE s.contractor_id = v_contractor.id AND s.is_test;
    END IF;

    UPDATE public.compliance_sync_search_requests r SET
        status = v_status,
        result_status = p_result_status,
        candidates = v_candidates,
        selected_candidate = CASE WHEN v_class.kind = 'success' THEN v_candidate ELSE NULL END,
        error_message = left(p_error_message, 2000),
        source_url = p_source_url,
        search_variation = left(p_search_variation, 40),
        sync_outcome = left(v_outcome, 40),
        processed_at = now(),
        completed_at = now(),
        updated_at = now()
    WHERE r.id = v_request.id;

    RETURN QUERY SELECT v_request.id, v_class.classification, v_class.kind, v_outcome, v_count, v_review_id, v_record_id;
END;
$$;

-- =====================================================================
-- Entry point: finalize a daily run and apply threshold expirations
-- =====================================================================
CREATE OR REPLACE FUNCTION public.finalize_nj_pwc_daily_run(
    p_run_id INTEGER,
    p_force BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    run_id INTEGER,
    finished BOOLEAN,
    run_status TEXT,
    total INTEGER,
    pending INTEGER,
    succeeded INTEGER,
    failures INTEGER,
    review_required INTEGER,
    infrastructure INTEGER,
    expired INTEGER,
    expirations_withheld INTEGER,
    circuit_breaker BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_run public.compliance_sync_runs%ROWTYPE;
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_pending INTEGER;
    v_total INTEGER;
    v_success INTEGER;
    v_failure INTEGER;
    v_review INTEGER;
    v_infra INTEGER;
    v_approved INTEGER;
    v_changes INTEGER;
    v_expired INTEGER := 0;
    v_withheld INTEGER := 0;
    v_breaker BOOLEAN := FALSE;
    v_row RECORD;
    v_apply RECORD;
    v_review_id INTEGER;
    v_status TEXT;
    v_actor CONSTANT TEXT := 'NJ PWC Daily Sync';
BEGIN
    SELECT * INTO v_run FROM public.compliance_sync_runs r WHERE r.id = p_run_id FOR UPDATE;
    IF NOT FOUND OR v_run.run_type IS DISTINCT FROM 'nj_pwc_daily' THEN
        RAISE EXCEPTION 'NJ PWC daily run not found' USING ERRCODE = 'no_data_found';
    END IF;

    SELECT count(*) INTO v_pending FROM public.compliance_sync_search_requests q
    WHERE q.sync_run_id = p_run_id AND q.status = 'pending';

    IF v_run.run_status IS DISTINCT FROM 'Running' THEN
        RETURN QUERY SELECT v_run.id, TRUE, v_run.run_status::TEXT, v_run.records_checked, v_pending,
            NULL::INTEGER, v_run.failures, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::BOOLEAN;
        RETURN;
    END IF;

    IF v_pending > 0 AND NOT coalesce(p_force, FALSE) THEN
        RETURN QUERY SELECT v_run.id, FALSE, 'Running'::TEXT, NULL::INTEGER, v_pending,
            NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::BOOLEAN;
        RETURN;
    END IF;

    -- Forced finalization: unprocessed searches are infrastructure outcomes.
    FOR v_row IN
        SELECT q.id, q.contractor_id, q.is_test FROM public.compliance_sync_search_requests q
        WHERE q.sync_run_id = p_run_id AND q.status = 'pending'
        ORDER BY q.id
        FOR UPDATE
    LOOP
        UPDATE public.compliance_sync_search_requests q SET
            status = 'failed', result_status = 'RPA Error',
            error_message = 'Daily run finalized before the search was processed.',
            sync_outcome = 'infrastructure:Registry Unavailable',
            processed_at = now(), completed_at = now(), updated_at = now()
        WHERE q.id = v_row.id;
        PERFORM public.nj_pwc_upsert_exception(
            v_row.contractor_id, v_row.is_test, 'Registry Unavailable', 'infrastructure',
            coalesce((SELECT s.consecutive_failure_count FROM public.nj_pwc_sync_state s
                      WHERE s.contractor_id = v_row.contractor_id AND s.is_test = v_row.is_test), 0),
            p_run_id, v_row.id, NULL,
            jsonb_build_object('result_status', 'RPA Error', 'error_message', 'Search not processed before the run was finalized.')
        );
    END LOOP;

    SELECT count(*),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'success:%'),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'failure:%'),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'review:%'),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'infrastructure:%' OR q.sync_outcome IS NULL),
           count(*) FILTER (WHERE q.sync_outcome = 'success:auto_approved'),
           count(*) FILTER (WHERE q.sync_outcome IN ('success:auto_approved', 'success:review_required_update'))
    INTO v_total, v_success, v_failure, v_review, v_infra, v_approved, v_changes
    FROM public.compliance_sync_search_requests q
    WHERE q.sync_run_id = p_run_id;

    -- Circuit breaker: a registry-wide problem must not expire contractors.
    IF ((v_total - v_infra) >= 5 AND v_failure * 2 > (v_total - v_infra))
       OR (v_total >= 5 AND v_infra * 2 > v_total) THEN
        v_breaker := TRUE;
    END IF;

    SELECT * INTO v_settings FROM public.compliance_sync_settings s WHERE s.compliance_name = 'NJ PWC';

    FOR v_row IN
        SELECT s.contractor_id, s.consecutive_failure_count, c.company_name
        FROM public.nj_pwc_sync_state s
        JOIN public.contractors c ON c.id = s.contractor_id
        WHERE s.pending_expiration_run_id = p_run_id AND s.is_test = v_run.is_test
        ORDER BY s.contractor_id
    LOOP
        IF v_breaker THEN
            UPDATE public.nj_pwc_sync_state s SET pending_expiration_run_id = NULL, updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND s.is_test = v_run.is_test;
            v_withheld := v_withheld + 1;
            CONTINUE;
        END IF;

        PERFORM 1 FROM public.contractors c WHERE c.id = v_row.contractor_id FOR UPDATE;

        IF v_run.is_test THEN
            UPDATE public.nj_pwc_sync_state s
            SET state = 'Expired', expired_at = now(), pending_expiration_run_id = NULL,
                dry_run_action = CASE WHEN v_settings.mode = 'auto_approve' THEN 'would_expire'
                                      ELSE 'would_propose_expiration' END,
                dry_run_action_at = now(), updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND s.is_test;
            v_expired := v_expired + 1;
            PERFORM public.nj_pwc_write_audit(
                NULL, v_actor, '',
                CASE WHEN v_settings.mode = 'auto_approve' THEN 'NJ_PWC_TEST_MODE_WOULD_EXPIRE'
                     ELSE 'NJ_PWC_TEST_MODE_WOULD_PROPOSE_EXPIRATION' END,
                'contractor', v_row.contractor_id::TEXT, public.nj_pwc_audit_label(v_row.company_name, TRUE),
                jsonb_build_object('test_mode', TRUE, 'compliance_records_modified', FALSE,
                    'mode', v_settings.mode, 'sync_run_id', p_run_id,
                    'consecutive_failure_count', v_row.consecutive_failure_count,
                    'threshold', v_settings.failure_expire_threshold)
            );
        ELSIF v_settings.mode = 'auto_approve' THEN
            SELECT * INTO v_apply FROM public.nj_pwc_expire_active_record(
                v_row.contractor_id, v_actor, p_run_id,
                'NJ PWC registration not found in the registry after '
                    || v_row.consecutive_failure_count || ' consecutive daily sync failures.'
            );
            UPDATE public.nj_pwc_sync_state s
            SET state = 'Expired', expired_at = now(), pending_expiration_run_id = NULL, updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND NOT s.is_test;
            IF v_apply.record_action = 'expired' THEN
                v_expired := v_expired + 1;
                PERFORM public.nj_pwc_write_audit(
                    NULL, v_actor, '', 'NJ_PWC_SYNC_EXPIRED', 'contractor',
                    v_row.contractor_id::TEXT, v_row.company_name,
                    jsonb_build_object('sync_run_id', p_run_id,
                        'consecutive_failure_count', v_row.consecutive_failure_count,
                        'threshold', v_settings.failure_expire_threshold,
                        'compliance_record_id', v_apply.record_id,
                        'old_values', v_apply.old_values, 'new_values', v_apply.new_values)
                );
            END IF;
        ELSE
            v_review_id := public.nj_pwc_upsert_review(
                v_row.contractor_id, p_run_id, NULL, 'Expiration Proposed', 'No Match Found', NULL,
                'Expired - Not Found in Registry',
                'Not found in the NJ PWC registry after ' || v_row.consecutive_failure_count
                    || ' consecutive daily sync failures.',
                'NJ PWC daily sync expiration proposal (review_required mode).'
            );
            UPDATE public.nj_pwc_sync_state s SET pending_expiration_run_id = NULL, updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND NOT s.is_test;
            UPDATE public.nj_pwc_sync_exceptions e SET review_queue_id = v_review_id, updated_at = now()
            WHERE e.contractor_id = v_row.contractor_id AND NOT e.is_test AND e.status = 'open' AND e.kind = 'failure';
            v_expired := v_expired + 1;
        END IF;

        UPDATE public.nj_pwc_sync_exceptions e SET expired_by_sync = TRUE, updated_at = now()
        WHERE e.contractor_id = v_row.contractor_id AND e.is_test = v_run.is_test
          AND e.status = 'open' AND e.kind = 'failure'
          AND (v_run.is_test OR v_settings.mode = 'auto_approve');
    END LOOP;

    v_status := CASE WHEN v_infra > 0 OR v_breaker THEN 'Completed With Errors' ELSE 'Completed' END;
    UPDATE public.compliance_sync_runs r SET
        run_status = v_status,
        -- Legacy status is VARCHAR(20); 'completed_with_errors' does not fit,
        -- so run_status carries the detailed outcome.
        status = 'completed',
        completed_at = now(),
        records_checked = v_total,
        changes_detected = v_changes + v_expired,
        records_approved = v_approved,
        records_failed = v_failure + v_infra,
        failures = v_failure + v_infra,
        notes = coalesce(r.notes, '')
            || CASE WHEN v_breaker THEN ' Circuit breaker tripped: ' || v_withheld || ' expiration(s) withheld.' ELSE '' END
            || CASE WHEN coalesce(p_force, FALSE) AND v_pending > 0 THEN ' Finalized with ' || v_pending || ' unprocessed search(es).' ELSE '' END
    WHERE r.id = p_run_id;

    IF NOT v_run.is_test THEN
        UPDATE public.compliance_sync_settings s SET last_sync_at = now(), updated_at = now()
        WHERE s.compliance_name = 'NJ PWC';
    END IF;

    PERFORM public.nj_pwc_write_audit(
        NULL, v_actor, '', public.nj_pwc_audit_action('NJ_PWC_DAILY_SYNC_COMPLETED', v_run.is_test),
        'compliance_sync_run', p_run_id::TEXT,
        public.nj_pwc_audit_label('NJ PWC Daily Sync ' || coalesce(v_run.run_date::TEXT, ''), v_run.is_test),
        jsonb_build_object('run_status', v_status, 'is_test', v_run.is_test, 'mode', v_settings.mode,
            'test_mode', v_run.is_test, 'compliance_records_modified', NOT v_run.is_test,
            'total', v_total, 'succeeded', v_success, 'failures', v_failure, 'review_required', v_review,
            'infrastructure', v_infra, 'expired', v_expired, 'expirations_withheld', v_withheld,
            'circuit_breaker', v_breaker, 'forced', coalesce(p_force, FALSE), 'unprocessed', v_pending)
    );

    RETURN QUERY SELECT p_run_id, TRUE, v_status, v_total, 0, v_success, v_failure, v_review, v_infra,
        v_expired, v_withheld, v_breaker;
END;
$$;

-- =====================================================================
-- Entry points: exception report actions
-- =====================================================================
CREATE OR REPLACE FUNCTION public.retry_nj_pwc_sync_exception(
    p_exception_id INTEGER,
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_email TEXT
)
RETURNS TABLE (exception_id INTEGER, search_request_id INTEGER, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_exception public.nj_pwc_sync_exceptions%ROWTYPE;
    v_contractor public.contractors%ROWTYPE;
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_request_id INTEGER;
    v_created BOOLEAN := FALSE;
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name), ''), 'Unknown user');
BEGIN
    SELECT * INTO v_exception FROM public.nj_pwc_sync_exceptions e WHERE e.id = p_exception_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ PWC sync exception not found' USING ERRCODE = 'no_data_found';
    END IF;
    SELECT * INTO v_contractor FROM public.contractors c WHERE c.id = v_exception.contractor_id FOR UPDATE;
    SELECT * INTO v_exception FROM public.nj_pwc_sync_exceptions e WHERE e.id = p_exception_id FOR UPDATE;
    IF v_exception.status <> 'open' THEN
        RAISE EXCEPTION 'NJ PWC sync exception is already resolved' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    SELECT * INTO v_settings FROM public.compliance_sync_settings s WHERE s.compliance_name = 'NJ PWC';
    IF NOT coalesce(v_settings.enabled, FALSE) THEN
        RAISE EXCEPTION 'NJ PWC compliance sync is disabled' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF NOT v_contractor.active THEN
        RAISE EXCEPTION 'Contractor is inactive' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT q.id INTO v_request_id FROM public.compliance_sync_search_requests q
    WHERE q.contractor_id = v_contractor.id AND q.compliance_name = 'NJ PWC'
      AND q.status = 'pending' AND q.origin <> 'user' AND q.is_test = v_exception.is_test
    ORDER BY q.id
    LIMIT 1;

    IF v_request_id IS NULL THEN
        INSERT INTO public.compliance_sync_search_requests(
            compliance_name, searched_company_name, searched_city, searched_state, searched_zip_code,
            status, candidates, is_test, requested_by, contractor_id, origin, priority
        )
        VALUES (
            'NJ PWC',
            left(upper(btrim(regexp_replace(v_contractor.company_name, '\s+', ' ', 'g'))), 200),
            left(nullif(btrim(v_contractor.city), ''), 150),
            left(nullif(btrim(v_contractor.state), ''), 100),
            left(nullif(btrim(v_contractor.zip_code), ''), 20),
            'pending', '[]'::JSONB, v_exception.is_test, left(v_actor, 200), v_contractor.id, 'exception_retry', 10
        )
        RETURNING id INTO v_request_id;
        v_created := TRUE;
    END IF;

    PERFORM public.nj_pwc_write_audit(
        p_actor_id, v_actor, p_actor_email, public.nj_pwc_audit_action('NJ_PWC_SYNC_EXCEPTION_RETRY', v_exception.is_test),
        'contractor', v_contractor.id::TEXT, public.nj_pwc_audit_label(v_contractor.company_name, v_exception.is_test),
        jsonb_build_object('exception_id', p_exception_id, 'reason', v_exception.reason,
            'search_request_id', v_request_id, 'created', v_created, 'is_test', v_exception.is_test)
    );

    RETURN QUERY SELECT p_exception_id, v_request_id, v_created;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_nj_pwc_sync_exception(
    p_exception_id INTEGER,
    p_reset_failure_count BOOLEAN,
    p_note TEXT,
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_email TEXT
)
RETURNS TABLE (exception_id INTEGER, status TEXT, consecutive_failure_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_exception public.nj_pwc_sync_exceptions%ROWTYPE;
    v_label TEXT;
    v_old_count INTEGER;
    v_new_count INTEGER;
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name), ''), 'Unknown user');
BEGIN
    SELECT * INTO v_exception FROM public.nj_pwc_sync_exceptions e WHERE e.id = p_exception_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ PWC sync exception not found' USING ERRCODE = 'no_data_found';
    END IF;
    SELECT c.company_name INTO v_label FROM public.contractors c WHERE c.id = v_exception.contractor_id FOR UPDATE;
    SELECT * INTO v_exception FROM public.nj_pwc_sync_exceptions e WHERE e.id = p_exception_id FOR UPDATE;
    IF v_exception.status <> 'open' THEN
        RAISE EXCEPTION 'NJ PWC sync exception is already resolved' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    UPDATE public.nj_pwc_sync_exceptions e SET
        status = 'resolved', resolved_by = left(v_actor, 200), resolved_at = now(),
        resolution_note = left(p_note, 2000), updated_at = now()
    WHERE e.id = p_exception_id;

    SELECT s.consecutive_failure_count INTO v_old_count FROM public.nj_pwc_sync_state s
    WHERE s.contractor_id = v_exception.contractor_id AND s.is_test = v_exception.is_test
    FOR UPDATE;
    v_new_count := coalesce(v_old_count, 0);

    IF coalesce(p_reset_failure_count, FALSE) THEN
        UPDATE public.nj_pwc_sync_state s SET
            consecutive_failure_count = 0,
            pending_expiration_run_id = NULL,
            state = CASE WHEN s.state = 'Expired' THEN 'Expired'
                         WHEN EXISTS (SELECT 1 FROM public.nj_pwc_sync_exceptions o
                                      WHERE o.contractor_id = s.contractor_id AND o.is_test = s.is_test
                                        AND o.status = 'open') THEN s.state
                         ELSE 'OK' END,
            updated_at = now()
        WHERE s.contractor_id = v_exception.contractor_id AND s.is_test = v_exception.is_test;
        v_new_count := 0;
        IF NOT v_exception.is_test THEN
            UPDATE public.nj_pwc_sync_exceptions o SET consecutive_failure_count = 0, updated_at = now()
            WHERE o.contractor_id = v_exception.contractor_id AND NOT o.is_test AND o.status = 'open';
            UPDATE public.compliance_records cr
            SET registry_status = 'OK', registry_status_updated_at = now(), updated_at = now()
            WHERE cr.contractor_id = v_exception.contractor_id AND cr.compliance_type_id = v_type_id
              AND cr.active AND cr.is_current AND cr.registry_status = 'Investigation Required';
        END IF;
    END IF;

    PERFORM public.nj_pwc_write_audit(
        p_actor_id, v_actor, p_actor_email, public.nj_pwc_audit_action('NJ_PWC_SYNC_EXCEPTION_RESOLVED', v_exception.is_test),
        'contractor', v_exception.contractor_id::TEXT, public.nj_pwc_audit_label(v_label, v_exception.is_test),
        jsonb_build_object('exception_id', p_exception_id, 'reason', v_exception.reason,
            'kind', v_exception.kind, 'is_test', v_exception.is_test,
            'reset_failure_count', coalesce(p_reset_failure_count, FALSE),
            'old_failure_count', v_old_count, 'new_failure_count', v_new_count, 'note', p_note)
    );

    RETURN QUERY SELECT p_exception_id, 'resolved'::TEXT, v_new_count;
END;
$$;

-- =====================================================================
-- Privileges: helpers are internal; entry points are service_role only.
-- =====================================================================
REVOKE ALL ON FUNCTION public.nj_pwc_normalize_name(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_normalize_certificate(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_try_date(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_candidate_is_anomalous(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_classify_sync_result(TEXT, TEXT[], TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_import_review_reason(TEXT, TEXT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_compliance_type_id() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_record_snapshot(public.compliance_records) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_apply_certificate(INTEGER, JSONB, TEXT, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_expire_active_record(INTEGER, TEXT, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_write_audit(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_audit_action(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_audit_label(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_upsert_exception(INTEGER, BOOLEAN, TEXT, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_resolve_exceptions(INTEGER, BOOLEAN, TEXT[], TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_lock_state(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_upsert_review(INTEGER, INTEGER, INTEGER, TEXT, TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_insert_approved_review(INTEGER, INTEGER, INTEGER, JSONB, JSONB, INTEGER, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_supersede_pending_reviews(INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.nj_pwc_mark_sync_success(INTEGER, BOOLEAN, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.import_nj_pwc_candidate(INTEGER, INTEGER, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.approve_nj_pwc_review(INTEGER, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reject_nj_pwc_review(INTEGER, UUID, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_nj_pwc_daily_sync(DATE, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.submit_nj_pwc_sync_result(INTEGER, TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_nj_pwc_daily_run(INTEGER, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.retry_nj_pwc_sync_exception(INTEGER, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_nj_pwc_sync_exception(INTEGER, BOOLEAN, TEXT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.import_nj_pwc_candidate(INTEGER, INTEGER, TEXT, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.approve_nj_pwc_review(INTEGER, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.reject_nj_pwc_review(INTEGER, UUID, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_nj_pwc_daily_sync(DATE, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.submit_nj_pwc_sync_result(INTEGER, TEXT, JSONB, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_nj_pwc_daily_run(INTEGER, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.retry_nj_pwc_sync_exception(INTEGER, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.resolve_nj_pwc_sync_exception(INTEGER, BOOLEAN, TEXT, UUID, TEXT, TEXT) TO service_role;

COMMIT;
