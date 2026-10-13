-- NJ BRC request queue, review evidence, and manual approval transactions.
-- Requests contain sensitive lookup snapshots and are never directly readable
-- by browser roles. Deploy only after approval; this file is not auto-applied.

BEGIN;

CREATE TABLE public.nj_brc_search_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    company_name VARCHAR(200) NOT NULL,
    nj_brc_number VARCHAR(100),
    brc_name_control VARCHAR(4) NOT NULL,
    federal_tax_id TEXT NOT NULL,
    taxpayer_id_submission VARCHAR(12) NOT NULL
        CHECK (taxpayer_id_submission ~ '^[0-9]{12}$'),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending', 'claimed', 'processing', 'human_verification_required',
            'review_required', 'completed', 'no_match', 'invalid_input',
            'identity_mismatch', 'ambiguous_result', 'website_error', 'failed'
        )),
    result_type TEXT CHECK (result_type IS NULL OR result_type IN (
        'successful_certificate', 'no_match', 'invalid_input', 'identity_mismatch',
        'ambiguous_result', 'website_error', 'failed'
    )),
    result_evidence JSONB,
    error_code TEXT,
    claim_worker_key TEXT,
    worker_instance_id UUID,
    claimed_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    review_queue_id INTEGER REFERENCES public.compliance_sync_review_queue(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    CONSTRAINT nj_brc_submission_matches_fein CHECK (
        federal_tax_id ~ '^[0-9[:space:]().-]+$'
        AND taxpayer_id_submission =
            regexp_replace(coalesce(federal_tax_id, ''), '[^0-9]', '', 'g') || '000'
        AND length(regexp_replace(coalesce(federal_tax_id, ''), '[^0-9]', '', 'g')) = 9
        AND brc_name_control ~ '^[A-Za-z0-9&-]{4}$'
        AND (nj_brc_number IS NULL OR length(nj_brc_number) <= 100)
    )
);

CREATE INDEX nj_brc_search_requests_status_created
    ON public.nj_brc_search_requests(status, created_at);
CREATE UNIQUE INDEX nj_brc_search_requests_one_active_contractor
    ON public.nj_brc_search_requests(contractor_id)
    WHERE status IN (
        'pending', 'claimed', 'processing', 'human_verification_required', 'review_required'
    );
CREATE UNIQUE INDEX nj_brc_search_requests_review_queue
    ON public.nj_brc_search_requests(review_queue_id)
    WHERE review_queue_id IS NOT NULL;
CREATE INDEX nj_brc_search_requests_worker_owner
    ON public.nj_brc_search_requests(worker_instance_id, claimed_at DESC)
    WHERE status IN ('claimed', 'processing', 'human_verification_required');

ALTER TABLE public.nj_brc_search_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nj_brc_search_requests FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.nj_brc_search_requests TO service_role;

CREATE OR REPLACE FUNCTION public.prevent_nj_brc_snapshot_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
    IF ROW(NEW.contractor_id, NEW.company_name, NEW.nj_brc_number, NEW.brc_name_control,
           NEW.federal_tax_id, NEW.taxpayer_id_submission, NEW.created_at)
       IS DISTINCT FROM
       ROW(OLD.contractor_id, OLD.company_name, OLD.nj_brc_number, OLD.brc_name_control,
           OLD.federal_tax_id, OLD.taxpayer_id_submission, OLD.created_at) THEN
        RAISE EXCEPTION 'NJ BRC request snapshots are immutable' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER nj_brc_search_requests_snapshot_immutable
BEFORE UPDATE ON public.nj_brc_search_requests
FOR EACH ROW EXECUTE FUNCTION public.prevent_nj_brc_snapshot_change();
REVOKE ALL ON FUNCTION public.prevent_nj_brc_snapshot_change() FROM PUBLIC, anon, authenticated;

CREATE FUNCTION public.redact_nj_brc_sensitive_text(
    p_value TEXT,
    p_federal_tax_id TEXT,
    p_taxpayer_id_submission TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    result TEXT := p_value;
    fein_digits TEXT := regexp_replace(coalesce(p_federal_tax_id, ''), '[^0-9]', '', 'g');
    fein_mask TEXT;
    submission_mask TEXT;
    fein_pattern TEXT;
    submission_pattern TEXT;
BEGIN
    IF result IS NULL THEN RETURN NULL; END IF;
    fein_mask := '***-**-' || right(fein_digits, 4);
    submission_mask := '********' || right(coalesce(p_taxpayer_id_submission, ''), 4);
    IF p_taxpayer_id_submission IS NOT NULL THEN
        result := replace(result, p_taxpayer_id_submission, submission_mask);
    END IF;
    IF p_federal_tax_id IS NOT NULL THEN
        result := replace(result, p_federal_tax_id, fein_mask);
    END IF;
    IF length(fein_digits) = 9 THEN
        fein_pattern := regexp_replace(fein_digits, '([0-9])', E'\\1[[:space:].()/-]*', 'g');
        result := regexp_replace(
            result, '(^|[^0-9])(' || fein_pattern || ')([^0-9]|$)',
            E'\\1' || fein_mask || E'\\3', 'g'
        );
    END IF;
    IF length(coalesce(p_taxpayer_id_submission, '')) = 12 THEN
        submission_pattern := regexp_replace(
            p_taxpayer_id_submission, '([0-9])', E'\\1[[:space:].()/-]*', 'g'
        );
        result := regexp_replace(
            result, '(^|[^0-9])(' || submission_pattern || ')([^0-9]|$)',
            E'\\1' || submission_mask || E'\\3', 'g'
        );
    END IF;
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.redact_nj_brc_sensitive_text(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- Keep exact-name comparisons in parity with normalizeCompanyName().
CREATE FUNCTION public.normalize_nj_brc_business_name(p_name TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
    normalized TEXT;
    last_token TEXT;
BEGIN
    normalized := lower(trim(coalesce(p_name, '')));
    normalized := replace(normalized, '&', ' and ');
    normalized := replace(normalized, '.', '');
    normalized := replace(normalized, '''', '');
    normalized := replace(normalized, chr(8217), '');
    normalized := regexp_replace(normalized, '[^[:alnum:][:space:]]', ' ', 'g');
    normalized := regexp_replace(trim(normalized), '[[:space:]]+', ' ', 'g');

    LOOP
        last_token := regexp_replace(normalized, '^.* ', '');
        EXIT WHEN position(' ' IN normalized) = 0
            OR last_token <> ALL(ARRAY[
                'llc', 'inc', 'incorporated', 'corp', 'corporation',
                'co', 'company', 'ltd', 'lp', 'llp', 'pc'
            ]);
        normalized := regexp_replace(normalized, ' [^ ]+$', '');
    END LOOP;
    RETURN normalized;
END;
$$;
REVOKE ALL ON FUNCTION public.normalize_nj_brc_business_name(TEXT) FROM PUBLIC, anon, authenticated;

ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS nj_brc_request_id UUID
        REFERENCES public.nj_brc_search_requests(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS brc_evidence JSONB,
    ADD COLUMN IF NOT EXISTS federal_tax_id_masked TEXT,
    ADD COLUMN IF NOT EXISTS taxpayer_id_submission_masked TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS compliance_sync_review_nj_brc_request
    ON public.compliance_sync_review_queue(nj_brc_request_id)
    WHERE nj_brc_request_id IS NOT NULL;

ALTER TABLE public.compliance_sync_review_queue
    DROP CONSTRAINT IF EXISTS chk_compliance_sync_review_queue_result_status;
ALTER TABLE public.compliance_sync_review_queue
    ADD CONSTRAINT chk_compliance_sync_review_queue_result_status
    CHECK (result_status IS NULL OR result_status IN (
        'Match Found', 'No Match Found', 'Multiple Matches', 'Invalid Search',
        'Website Error', 'RPA Error', 'Successful Certificate', 'Identity Mismatch',
        'Ambiguous Result', 'Failed'
    ));

-- Browser users may review masked evidence, but NJ BRC insert/decision
-- writes go through the transactional RPCs below. Existing PWC policies
-- remain in place and continue to govern their workflow.
CREATE POLICY compliance_sync_review_queue_nj_brc_select
    ON public.compliance_sync_review_queue FOR SELECT TO authenticated
    USING (public.user_has_module_permission('compliance_sync', 'view'));
DROP POLICY IF EXISTS compliance_sync_review_queue_nj_brc_insert_only_rpc
    ON public.compliance_sync_review_queue;
CREATE POLICY compliance_sync_review_queue_nj_brc_insert_only_rpc
    ON public.compliance_sync_review_queue AS RESTRICTIVE FOR INSERT TO authenticated
    WITH CHECK (compliance_name <> 'NJ BRC');
DROP POLICY IF EXISTS compliance_sync_review_queue_nj_brc_update_only_rpc
    ON public.compliance_sync_review_queue;
CREATE POLICY compliance_sync_review_queue_nj_brc_update_only_rpc
    ON public.compliance_sync_review_queue AS RESTRICTIVE FOR UPDATE TO authenticated
    USING (compliance_name <> 'NJ BRC')
    WITH CHECK (compliance_name <> 'NJ BRC');

CREATE FUNCTION public.guard_nj_brc_review_queue_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    table_owner TEXT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.compliance_name = 'NJ BRC' THEN
            RAISE EXCEPTION 'NJ BRC review items are append-only' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'UPDATE' AND OLD.compliance_name <> 'NJ BRC'
       AND NEW.compliance_name <> 'NJ BRC' THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' AND NEW.compliance_name <> 'NJ BRC' THEN
        RETURN NEW;
    END IF;

    SELECT pg_get_userbyid(c.relowner) INTO table_owner
    FROM pg_class c WHERE c.oid = 'public.compliance_sync_review_queue'::regclass;
    IF current_user IS DISTINCT FROM table_owner THEN
        RAISE EXCEPTION 'NJ BRC review writes must use the transactional RPCs' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.compliance_name <> 'NJ BRC'
           OR NEW.status <> 'pending'
           OR nullif(current_setting('subtracker.nj_brc_result_request', true), '')
                IS DISTINCT FROM NEW.nj_brc_request_id::TEXT THEN
            RAISE EXCEPTION 'NJ BRC review items must be created by result ingestion' USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.compliance_name = 'NJ BRC' OR NEW.compliance_name = 'NJ BRC' THEN
        IF NEW.nj_brc_request_id IS DISTINCT FROM OLD.nj_brc_request_id
           OR NEW.brc_evidence IS DISTINCT FROM OLD.brc_evidence
           OR NEW.federal_tax_id_masked IS DISTINCT FROM OLD.federal_tax_id_masked
           OR NEW.taxpayer_id_submission_masked IS DISTINCT FROM OLD.taxpayer_id_submission_masked
           OR NEW.certificate_number IS DISTINCT FROM OLD.certificate_number
           OR NEW.proposed_registration_number IS DISTINCT FROM OLD.proposed_registration_number
           OR NEW.synced_effective_date_proposed IS DISTINCT FROM OLD.synced_effective_date_proposed
           OR nullif(current_setting('subtracker.nj_brc_review_decision', true), '')
                IS DISTINCT FROM OLD.nj_brc_request_id::TEXT THEN
            RAISE EXCEPTION 'NJ BRC evidence is immutable and decisions require the approval RPC' USING ERRCODE = 'insufficient_privilege';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_nj_brc_review_queue_write() FROM PUBLIC, anon, authenticated;
CREATE TRIGGER compliance_sync_review_queue_nj_brc_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.compliance_sync_review_queue
FOR EACH ROW EXECUTE FUNCTION public.guard_nj_brc_review_queue_write();

-- Separate typed worker identity and lifecycle states; existing PWC/NY rows
-- and the existing telemetry reporter remain supported.
ALTER TABLE public.compliance_sync_workers
    DROP CONSTRAINT IF EXISTS compliance_sync_workers_worker_key_check,
    DROP CONSTRAINT IF EXISTS compliance_sync_workers_lifecycle_check;
ALTER TABLE public.compliance_sync_workers
    ADD CONSTRAINT compliance_sync_workers_worker_key_check
        CHECK (worker_key IN ('nj-pwc', 'nj-brc', 'ny')),
    ADD CONSTRAINT compliance_sync_workers_lifecycle_check
        CHECK (lifecycle IS NULL OR lifecycle IN (
            'starting', 'ready', 'busy', 'stopped',
            'human_verification_required', 'website_error'
        ));
ALTER TABLE public.compliance_sync_workers
    ADD COLUMN IF NOT EXISTS current_request_key UUID,
    ADD COLUMN IF NOT EXISTS last_search_request_key UUID;

ALTER TABLE public.compliance_sync_worker_events
    DROP CONSTRAINT IF EXISTS compliance_sync_worker_events_event_check;
ALTER TABLE public.compliance_sync_worker_events
    ADD CONSTRAINT compliance_sync_worker_events_event_check
        CHECK (event IN (
            'start', 'stop', 'search', 'error', 'test', 'heartbeat',
            'queue_poll', 'request_claimed', 'request_processing',
            'human_verification_required', 'human_verification_completed',
            'request_processed', 'result_posted', 'no_match', 'invalid_input',
            'identity_mismatch', 'ambiguous_result', 'website_error',
            'extraction_error', 'failed'
        ));
ALTER TABLE public.compliance_sync_worker_events
    ADD COLUMN IF NOT EXISTS request_key UUID;

INSERT INTO public.compliance_sync_workers(worker_key, display_name, enabled)
VALUES ('nj-brc', 'NJ BRC Worker', TRUE)
ON CONFLICT (worker_key) DO UPDATE
SET display_name = EXCLUDED.display_name, enabled = TRUE;

CREATE OR REPLACE FUNCTION public.report_compliance_worker(p_report JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    worker public.compliance_sync_workers%ROWTYPE;
    incoming_start TIMESTAMPTZ := (p_report->>'started_at')::timestamptz;
    incoming_instance UUID := (p_report->>'instance_id')::uuid;
    incoming_sequence BIGINT := (p_report->>'sequence')::bigint;
    incoming_poll TIMESTAMPTZ := (p_report->>'last_poll_at')::timestamptz;
    incoming_request_id BIGINT := nullif(p_report->>'current_request_id', '')::bigint;
    incoming_request_key UUID := nullif(p_report->>'current_request_key', '')::uuid;
    incoming_search_id BIGINT := nullif(p_report->>'request_id', '')::bigint;
    incoming_search_key UUID := nullif(p_report->>'request_key', '')::uuid;
BEGIN
    SELECT * INTO worker FROM public.compliance_sync_workers
    WHERE worker_key = p_report->>'worker_key' FOR UPDATE;
    IF NOT FOUND OR NOT worker.enabled THEN RETURN false; END IF;
    IF worker.instance_id IS DISTINCT FROM incoming_instance THEN
        IF worker.started_at IS NOT NULL AND incoming_start <= worker.started_at THEN RETURN false; END IF;
    ELSIF incoming_start IS DISTINCT FROM worker.started_at OR incoming_sequence <= worker.report_sequence THEN
        RETURN false;
    END IF;

    UPDATE public.compliance_sync_workers SET
        instance_id = incoming_instance,
        started_at = incoming_start,
        last_heartbeat_at = now(),
        lifecycle = p_report->>'lifecycle',
        last_poll_at = CASE WHEN incoming_poll IS NULL THEN NULL
            WHEN worker.instance_id IS DISTINCT FROM incoming_instance
                OR incoming_poll IS DISTINCT FROM worker.last_poll_reported_at THEN now()
            ELSE worker.last_poll_at END,
        last_poll_reported_at = incoming_poll,
        browser_connected = (p_report->>'browser_connected')::boolean,
        file_modified_at = (p_report->>'file_modified_at')::timestamptz,
        loaded_hash = p_report->>'loaded_hash',
        current_hash = p_report->>'current_hash',
        report_sequence = incoming_sequence,
        current_request_id = incoming_request_id,
        current_request_key = incoming_request_key,
        last_search_at = CASE WHEN p_report->>'event' = 'search' THEN now() ELSE last_search_at END,
        last_search_request_id = CASE WHEN p_report->>'event' = 'search' THEN incoming_search_id ELSE last_search_request_id END,
        last_search_request_key = CASE WHEN p_report->>'event' = 'search' THEN incoming_search_key ELSE last_search_request_key END,
        last_search_result = CASE WHEN p_report->>'event' = 'search' THEN p_report->>'result_status' ELSE last_search_result END,
        last_error_at = CASE
            WHEN p_report->>'event' IN ('error', 'website_error', 'extraction_error', 'failed')
                THEN now() ELSE last_error_at END,
        last_error = CASE
            WHEN p_report->>'event' IN ('error', 'website_error', 'extraction_error', 'failed')
                THEN p_report->>'message' ELSE last_error END,
        test_acknowledged_at = CASE
            WHEN test_id::text = p_report->>'test_id'
                AND test_requested_at > now() - interval '30 seconds'
                AND (p_report->>'browser_connected')::boolean
                AND (
                    p_report->>'lifecycle' IN ('ready', 'busy')
                    OR (
                        worker.worker_key = 'nj-brc'
                        AND p_report->>'lifecycle' = 'human_verification_required'
                        AND incoming_poll > now() - interval '2 minutes'
                    )
                ) THEN now()
            ELSE test_acknowledged_at END
    WHERE worker_key = worker.worker_key;

    IF p_report->>'event' IS NOT NULL THEN
        INSERT INTO public.compliance_sync_worker_events(worker_key, event, message, request_id, request_key)
        VALUES(worker.worker_key, p_report->>'event', p_report->>'message', incoming_search_id, incoming_search_key);
        DELETE FROM public.compliance_sync_worker_events
        WHERE worker_key = worker.worker_key AND id IN (
            SELECT id FROM public.compliance_sync_worker_events
            WHERE worker_key = worker.worker_key ORDER BY id DESC OFFSET 200
        );
    END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.report_compliance_worker(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_compliance_worker(JSONB) TO service_role;

CREATE FUNCTION public.create_nj_brc_search_request(
    p_contractor_id INTEGER,
    p_taxpayer_id_submission TEXT
)
RETURNS TABLE (
    id UUID,
    contractor_id INTEGER,
    company_name TEXT,
    nj_brc_number TEXT,
    brc_name_control TEXT,
    federal_tax_id_masked TEXT,
    taxpayer_id_submission_masked TEXT,
    status TEXT,
    created_at TIMESTAMPTZ,
    existing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    contractor public.contractors%ROWTYPE;
    request public.nj_brc_search_requests%ROWTYPE;
    normalized_fein TEXT;
BEGIN
    IF NOT coalesce(public.user_has_module_permission('contractors', 'manage'), false) THEN
        RAISE EXCEPTION 'Contractors manage permission required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO contractor FROM public.contractors c
    WHERE c.id = p_contractor_id AND c.active FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active contractor not found' USING ERRCODE = 'no_data_found';
    END IF;

    SELECT * INTO request FROM public.nj_brc_search_requests r
    WHERE r.contractor_id = p_contractor_id
      AND r.status IN ('pending', 'claimed', 'processing', 'human_verification_required', 'review_required')
    ORDER BY r.created_at DESC LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        RETURN QUERY SELECT request.id, request.contractor_id, request.company_name::TEXT,
            request.nj_brc_number::TEXT, request.brc_name_control::TEXT,
            '***-**-' || right(regexp_replace(request.federal_tax_id, '[^0-9]', '', 'g'), 4),
            '********' || right(request.taxpayer_id_submission, 4),
            request.status, request.created_at, TRUE;
        RETURN;
    END IF;

    normalized_fein := regexp_replace(coalesce(contractor.federal_tax_id, ''), '[^0-9]', '', 'g');
    IF contractor.federal_tax_id !~ '^[0-9[:space:]().-]+$'
       OR length(normalized_fein) <> 9
       OR p_taxpayer_id_submission IS DISTINCT FROM normalized_fein || '000' THEN
        RAISE EXCEPTION 'Invalid Taxpayer ID (FEIN): expected 9 digits before NJ BRC formatting.' USING ERRCODE = 'check_violation';
    END IF;
    IF nullif(trim(contractor.company_name), '') IS NULL
       OR coalesce(contractor.brc_name_control, '') !~ '^[A-Za-z0-9&-]{4}$' THEN
        RAISE EXCEPTION 'Invalid NJ BRC company name or Name Control.' USING ERRCODE = 'check_violation';
    END IF;

    INSERT INTO public.nj_brc_search_requests(
        contractor_id, company_name, nj_brc_number, brc_name_control,
        federal_tax_id, taxpayer_id_submission
    )
    VALUES (
        contractor.id, contractor.company_name, contractor.nj_brc_number,
        contractor.brc_name_control, contractor.federal_tax_id, p_taxpayer_id_submission
    )
    RETURNING * INTO request;

    RETURN QUERY SELECT request.id, request.contractor_id, request.company_name::TEXT,
        request.nj_brc_number::TEXT, request.brc_name_control::TEXT,
        '***-**-' || right(normalized_fein, 4),
        '********' || right(request.taxpayer_id_submission, 4),
        request.status, request.created_at, FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.create_nj_brc_search_request(INTEGER, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_nj_brc_search_request(INTEGER, TEXT) TO authenticated;

CREATE FUNCTION public.claim_nj_brc_search_request(p_worker_instance_id UUID)
RETURNS TABLE (
    id UUID,
    contractor_id INTEGER,
    company_name TEXT,
    nj_brc_number TEXT,
    brc_name_control TEXT,
    taxpayer_id_submission TEXT,
    status TEXT,
    created_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    request public.nj_brc_search_requests%ROWTYPE;
BEGIN
    IF p_worker_instance_id IS NULL THEN
        RAISE EXCEPTION 'Worker instance ID is required' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO request FROM public.nj_brc_search_requests r
    WHERE r.worker_instance_id = p_worker_instance_id
      AND r.status IN ('claimed', 'processing', 'human_verification_required')
    ORDER BY r.claimed_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
        SELECT * INTO request FROM public.nj_brc_search_requests r
        WHERE r.status = 'pending'
        ORDER BY r.created_at, r.id
        LIMIT 1 FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN RETURN; END IF;
        UPDATE public.nj_brc_search_requests r SET
            status = 'claimed', claim_worker_key = 'nj-brc',
            worker_instance_id = p_worker_instance_id,
            claimed_at = now(), updated_at = now()
        WHERE r.id = request.id
        RETURNING * INTO request;
    END IF;

    RETURN QUERY SELECT request.id, request.contractor_id, request.company_name::TEXT,
        request.nj_brc_number::TEXT, request.brc_name_control::TEXT,
        request.taxpayer_id_submission::TEXT, request.status, request.created_at,
        request.claimed_at, request.processing_started_at;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_nj_brc_search_request(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_nj_brc_search_request(UUID) TO service_role;

CREATE FUNCTION public.set_nj_brc_search_request_state(
    p_request_id UUID,
    p_worker_instance_id UUID,
    p_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    updated_count INTEGER;
BEGIN
    IF p_status NOT IN ('processing', 'human_verification_required') THEN
        RAISE EXCEPTION 'Unsupported NJ BRC intermediate state' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    UPDATE public.nj_brc_search_requests SET
        status = p_status,
        processing_started_at = CASE
            WHEN p_status = 'processing' THEN coalesce(processing_started_at, now())
            ELSE processing_started_at END,
        updated_at = now()
    WHERE id = p_request_id
      AND worker_instance_id = p_worker_instance_id
      AND claim_worker_key = 'nj-brc'
      AND status IN ('claimed', 'processing', 'human_verification_required');
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    IF updated_count <> 1 THEN
        RAISE EXCEPTION 'NJ BRC request is not owned by this worker instance' USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.set_nj_brc_search_request_state(UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_nj_brc_search_request_state(UUID, UUID, TEXT) TO service_role;

CREATE FUNCTION public.report_nj_brc_search_result(
    p_request_id UUID,
    p_worker_instance_id UUID,
    p_result_type TEXT,
    p_evidence JSONB,
    p_error_code TEXT DEFAULT NULL
)
RETURNS TABLE (request_id UUID, status TEXT, review_queue_id INTEGER, idempotent BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    request public.nj_brc_search_requests%ROWTYPE;
    review_id INTEGER;
    current_record public.compliance_records%ROWTYPE;
    evidence JSONB;
    review_result TEXT;
    final_status TEXT;
    result_type_to_store TEXT;
    warnings JSONB;
BEGIN
    IF p_result_type NOT IN (
        'successful_certificate', 'no_match', 'invalid_input', 'identity_mismatch',
        'ambiguous_result', 'website_error', 'failed'
    ) THEN
        RAISE EXCEPTION 'Unsupported NJ BRC result type' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO request FROM public.nj_brc_search_requests r
    WHERE r.id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ BRC request not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF request.worker_instance_id IS DISTINCT FROM p_worker_instance_id
       OR request.claim_worker_key IS DISTINCT FROM 'nj-brc' THEN
        RAISE EXCEPTION 'NJ BRC request is not owned by this worker instance' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF request.result_type IS NOT NULL THEN
        IF request.result_type <> p_result_type
           AND NOT (request.result_type = 'identity_mismatch' AND p_result_type = 'successful_certificate') THEN
            RAISE EXCEPTION 'NJ BRC result already recorded with a different classification' USING ERRCODE = 'check_violation';
        END IF;
        RETURN QUERY SELECT request.id, request.status, request.review_queue_id, TRUE;
        RETURN;
    END IF;
    IF request.status NOT IN ('claimed', 'processing', 'human_verification_required') THEN
        RAISE EXCEPTION 'NJ BRC request cannot accept a result in its current state' USING ERRCODE = 'check_violation';
    END IF;
    result_type_to_store := p_result_type;

    warnings := CASE WHEN jsonb_typeof(p_evidence->'discrepancy_warnings') = 'array'
        THEN (SELECT coalesce(jsonb_agg(left(public.redact_nj_brc_sensitive_text(
                    value, request.federal_tax_id, request.taxpayer_id_submission), 500)), '[]'::jsonb)
              FROM jsonb_array_elements_text(p_evidence->'discrepancy_warnings') AS item(value))
        ELSE '[]'::jsonb END;
    evidence := jsonb_strip_nulls(jsonb_build_object(
        'taxpayer_name', nullif(left(trim(public.redact_nj_brc_sensitive_text(p_evidence->>'taxpayer_name', request.federal_tax_id, request.taxpayer_id_submission)), 300), ''),
        'trade_name', nullif(left(trim(public.redact_nj_brc_sensitive_text(p_evidence->>'trade_name', request.federal_tax_id, request.taxpayer_id_submission)), 300), ''),
        'address', nullif(left(trim(public.redact_nj_brc_sensitive_text(p_evidence->>'address', request.federal_tax_id, request.taxpayer_id_submission)), 800), ''),
        'certificate_number', nullif(left(trim(public.redact_nj_brc_sensitive_text(p_evidence->>'certificate_number', request.federal_tax_id, request.taxpayer_id_submission)), 100), ''),
        'effective_date', nullif(p_evidence->>'effective_date', ''),
        'date_of_issuance', nullif(left(trim(public.redact_nj_brc_sensitive_text(
            p_evidence->>'date_of_issuance', request.federal_tax_id, request.taxpayer_id_submission)), 50), ''),
        'office_use_only', nullif(left(trim(public.redact_nj_brc_sensitive_text(p_evidence->>'office_use_only', request.federal_tax_id, request.taxpayer_id_submission)), 300), ''),
        'source_url', nullif(left(trim(public.redact_nj_brc_sensitive_text(p_evidence->>'source_url', request.federal_tax_id, request.taxpayer_id_submission)), 1000), ''),
        'verified_at', coalesce(nullif(p_evidence->>'verified_at', ''), now()::TEXT),
        'match_rationale', nullif(left(trim(public.redact_nj_brc_sensitive_text(p_evidence->>'match_rationale', request.federal_tax_id, request.taxpayer_id_submission)), 2000), ''),
        'discrepancy_warnings', warnings
    ));

    IF p_result_type = 'successful_certificate' THEN
        IF coalesce(evidence->>'taxpayer_name', '') = ''
           OR coalesce(evidence->>'certificate_number', '') = ''
           OR coalesce(evidence->>'effective_date', '') !~ '^\d{4}-\d{2}-\d{2}$'
           OR coalesce(evidence->>'source_url', '') = ''
           OR coalesce(evidence->>'match_rationale', '') = '' THEN
            RAISE EXCEPTION 'Successful NJ BRC result is missing required certificate evidence' USING ERRCODE = 'check_violation';
        END IF;
        PERFORM (evidence->>'effective_date')::DATE;
        IF public.normalize_nj_brc_business_name(request.company_name) = ''
           OR public.normalize_nj_brc_business_name(evidence->>'taxpayer_name') = ''
           OR public.normalize_nj_brc_business_name(request.company_name)
                IS DISTINCT FROM public.normalize_nj_brc_business_name(evidence->>'taxpayer_name') THEN
            result_type_to_store := 'identity_mismatch';
            review_result := 'Identity Mismatch';
            final_status := 'identity_mismatch';
        ELSE
            review_result := 'Successful Certificate';
            final_status := 'review_required';
            PERFORM set_config('subtracker.nj_brc_result_request', request.id::TEXT, TRUE);

            SELECT cr.* INTO current_record
            FROM public.compliance_records cr
            JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
            WHERE cr.contractor_id = request.contractor_id
              AND ct.compliance_name = 'NJ BRC'
              AND cr.active AND cr.is_current
            ORDER BY cr.updated_at DESC, cr.id DESC
            LIMIT 1;

            INSERT INTO public.compliance_sync_review_queue(
            contractor_id, compliance_record_id, compliance_name,
            proposed_registration_number, proposed_status, proposed_expiration_date,
            current_registration_number, current_expiration_date,
            current_effective_date, status, sync_source,
            searched_registration_number, matched_registration_number, matched_company_name,
            synced_effective_date, synced_effective_date_proposed,
            last_verified, source_url, result_status, raw_result_summary, approval_source,
            brc_name_control_used, business_entity_id_used, certificate_number,
            brc_evidence, federal_tax_id_masked, taxpayer_id_submission_masked,
            nj_brc_request_id
            )
            VALUES (
            request.contractor_id, current_record.id, 'NJ BRC',
            evidence->>'certificate_number', 'Registered', NULL,
            current_record.registration_number, current_record.expiration_date,
            current_record.effective_date, 'pending', 'RPA',
            request.nj_brc_number, evidence->>'certificate_number', request.company_name,
            (evidence->>'effective_date')::DATE, (evidence->>'effective_date')::DATE,
            (evidence->>'verified_at')::TIMESTAMPTZ, evidence->>'source_url',
            review_result, 'NJ BRC certificate captured; approval required.', 'nj-brc-review',
            request.brc_name_control, request.nj_brc_number, evidence->>'certificate_number',
            evidence,
            '***-**-' || right(regexp_replace(request.federal_tax_id, '[^0-9]', '', 'g'), 4),
            '********' || right(request.taxpayer_id_submission, 4),
            request.id
            )
            RETURNING id INTO review_id;

            UPDATE public.contractors
            SET nj_brc_number = evidence->>'certificate_number', updated_at = now()
            WHERE id = request.contractor_id;
        END IF;
    ELSE
        final_status := p_result_type;
        review_result := CASE p_result_type
            WHEN 'no_match' THEN 'No Match Found'
            WHEN 'invalid_input' THEN 'Invalid Search'
            WHEN 'identity_mismatch' THEN 'Identity Mismatch'
            WHEN 'ambiguous_result' THEN 'Ambiguous Result'
            WHEN 'website_error' THEN 'Website Error'
            ELSE 'Failed' END;
    END IF;

    UPDATE public.nj_brc_search_requests SET
        status = final_status,
        result_type = result_type_to_store,
        result_evidence = evidence,
        error_code = CASE WHEN result_type_to_store <> 'successful_certificate'
            THEN CASE
                WHEN coalesce(p_error_code, result_type_to_store) ~ '^[A-Za-z0-9_-]{1,100}$'
                    THEN coalesce(p_error_code, result_type_to_store)
                ELSE result_type_to_store
            END
            ELSE NULL END,
        review_queue_id = review_id,
        completed_at = CASE WHEN final_status <> 'review_required' THEN now() ELSE NULL END,
        updated_at = now()
    WHERE id = request.id
    RETURNING * INTO request;

    IF result_type_to_store <> 'successful_certificate' THEN
        INSERT INTO public.compliance_sync_exceptions(
            contractor_id, compliance_name, exception_type, message,
            resolved, source_url, company_name, result_status
        )
        VALUES (
            request.contractor_id, 'NJ BRC', review_result,
            'NJ BRC lookup ended as ' || review_result || '.',
            FALSE, evidence->>'source_url', request.company_name, review_result
        );
    END IF;

    RETURN QUERY SELECT request.id, request.status, request.review_queue_id, FALSE;
END;
$$;
REVOKE ALL ON FUNCTION public.report_nj_brc_search_result(UUID, UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_nj_brc_search_result(UUID, UUID, TEXT, JSONB, TEXT) TO service_role;

CREATE FUNCTION public.approve_nj_brc_search_request(
    p_request_id UUID,
    p_decision_notes TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    request public.nj_brc_search_requests%ROWTYPE;
    review public.compliance_sync_review_queue%ROWTYPE;
    contractor public.contractors%ROWTYPE;
    compliance_type INTEGER;
    requires_expiration_flag BOOLEAN;
    new_record_id INTEGER;
    actor public.user_profiles%ROWTYPE;
    normalized_fein TEXT;
    safe_notes TEXT;
BEGIN
    IF NOT coalesce(public.user_has_module_permission('compliance_sync', 'manage'), false) THEN
        RAISE EXCEPTION 'Compliance Sync manage permission required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT * INTO request FROM public.nj_brc_search_requests r
    WHERE r.id = p_request_id FOR UPDATE;
    IF NOT FOUND OR request.status <> 'review_required'
       OR request.result_type <> 'successful_certificate' OR request.review_queue_id IS NULL THEN
        RAISE EXCEPTION 'NJ BRC request is not awaiting approval' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO review FROM public.compliance_sync_review_queue q
    WHERE q.id = request.review_queue_id FOR UPDATE;
    IF NOT FOUND OR review.nj_brc_request_id IS DISTINCT FROM request.id
       OR review.contractor_id <> request.contractor_id
       OR review.compliance_name <> 'NJ BRC' OR review.status <> 'pending' THEN
        RAISE EXCEPTION 'NJ BRC review item is not pending for this contractor' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO contractor FROM public.contractors c WHERE c.id = request.contractor_id FOR UPDATE;
    normalized_fein := regexp_replace(coalesce(contractor.federal_tax_id, ''), '[^0-9]', '', 'g');
    IF contractor.company_name IS DISTINCT FROM request.company_name
       OR contractor.brc_name_control IS DISTINCT FROM request.brc_name_control
       OR contractor.federal_tax_id IS DISTINCT FROM request.federal_tax_id
       OR request.taxpayer_id_submission IS DISTINCT FROM normalized_fein || '000' THEN
        RAISE EXCEPTION 'Contractor lookup identifiers changed after request creation' USING ERRCODE = 'check_violation';
    END IF;
    IF coalesce(review.brc_evidence->>'taxpayer_name', '') = ''
       OR coalesce(review.brc_evidence->>'match_rationale', '') = ''
       OR coalesce(review.certificate_number, '') = ''
       OR coalesce(review.synced_effective_date_proposed::TEXT, '') = '' THEN
        RAISE EXCEPTION 'NJ BRC identity or certificate evidence is incomplete' USING ERRCODE = 'check_violation';
    END IF;
    IF public.normalize_nj_brc_business_name(request.company_name)
       IS DISTINCT FROM public.normalize_nj_brc_business_name(review.brc_evidence->>'taxpayer_name') THEN
        RAISE EXCEPTION 'Returned NJ BRC taxpayer identity does not match the contractor' USING ERRCODE = 'check_violation';
    END IF;
    IF review.certificate_number IS DISTINCT FROM review.brc_evidence->>'certificate_number'
       OR review.synced_effective_date_proposed IS DISTINCT FROM (review.brc_evidence->>'effective_date')::DATE
       OR review.brc_evidence IS DISTINCT FROM request.result_evidence THEN
        RAISE EXCEPTION 'NJ BRC review fields no longer match extracted evidence' USING ERRCODE = 'check_violation';
    END IF;
    SELECT id, requires_expiration INTO compliance_type, requires_expiration_flag
    FROM public.compliance_types WHERE compliance_name = 'NJ BRC' AND active;
    IF compliance_type IS NULL OR requires_expiration_flag IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'NJ BRC must be configured as non-expiring before approval' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO actor FROM public.user_profiles WHERE auth_user_id = auth.uid() AND status = 'Active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active user profile required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    safe_notes := public.redact_nj_brc_sensitive_text(
        nullif(left(p_decision_notes, 2000), ''), request.federal_tax_id, request.taxpayer_id_submission
    );

    UPDATE public.compliance_records
    SET active = FALSE, is_current = FALSE, updated_at = now()
    WHERE contractor_id = request.contractor_id
      AND compliance_type_id = compliance_type
      AND (active OR is_current);

    INSERT INTO public.compliance_records(
        contractor_id, compliance_type_id, registration_number, effective_date,
        expiration_date, verified_date, verified_by, verification_source,
        is_current, active, notes
    )
    VALUES (
        request.contractor_id, compliance_type, review.certificate_number,
        review.synced_effective_date_proposed, NULL, current_date,
        actor.email, 'NJ BRC Website',
        TRUE, TRUE, safe_notes
    )
    RETURNING id INTO new_record_id;

    PERFORM set_config('subtracker.nj_brc_review_decision', request.id::TEXT, TRUE);
    UPDATE public.compliance_sync_review_queue
    SET status = 'approved',
        compliance_record_id = new_record_id,
        reviewed_by = actor.email,
        reviewed_at = now(),
        review_notes = safe_notes,
        approval_source = 'nj-brc-manual',
        updated_at = now()
    WHERE id = review.id;
    UPDATE public.contractors
    SET nj_brc_number = review.certificate_number, updated_at = now()
    WHERE id = request.contractor_id;
    UPDATE public.nj_brc_search_requests
    SET status = 'completed', completed_at = now(), updated_at = now()
    WHERE id = request.id;

    INSERT INTO public.administration_audit_log(
        user_id, user_name, user_email, action, object_type,
        object_id, object_label, details
    )
    VALUES (
        actor.auth_user_id, actor.name, actor.email, 'APPROVE',
        'nj_brc_search_requests', request.id::TEXT,
        request.company_name || ' NJ BRC',
        jsonb_build_object(
            'contractor_id', request.contractor_id,
            'review_queue_id', review.id,
            'compliance_record_id', new_record_id,
            'registration_number', review.certificate_number,
            'effective_date', review.synced_effective_date_proposed,
            'expiration_date', NULL,
            'decision_notes', safe_notes
        )
    );
    RETURN new_record_id;
END;
$$;
REVOKE ALL ON FUNCTION public.approve_nj_brc_search_request(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_nj_brc_search_request(UUID, TEXT) TO authenticated;

CREATE FUNCTION public.reject_nj_brc_search_request(
    p_request_id UUID,
    p_decision_notes TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    request public.nj_brc_search_requests%ROWTYPE;
    review public.compliance_sync_review_queue%ROWTYPE;
    actor public.user_profiles%ROWTYPE;
    safe_notes TEXT;
BEGIN
    IF NOT coalesce(public.user_has_module_permission('compliance_sync', 'manage'), false) THEN
        RAISE EXCEPTION 'Compliance Sync manage permission required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF nullif(trim(p_decision_notes), '') IS NULL THEN
        RAISE EXCEPTION 'A rejection reason is required' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO request FROM public.nj_brc_search_requests r
    WHERE r.id = p_request_id FOR UPDATE;
    IF NOT FOUND OR request.status <> 'review_required'
       OR request.result_type <> 'successful_certificate' OR request.review_queue_id IS NULL THEN
        RAISE EXCEPTION 'NJ BRC request is not awaiting rejection' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO review FROM public.compliance_sync_review_queue q
    WHERE q.id = request.review_queue_id FOR UPDATE;
    IF NOT FOUND OR review.nj_brc_request_id IS DISTINCT FROM request.id
       OR review.contractor_id <> request.contractor_id
       OR review.compliance_name <> 'NJ BRC' OR review.status <> 'pending' THEN
        RAISE EXCEPTION 'NJ BRC review item is not pending for this contractor' USING ERRCODE = 'check_violation';
    END IF;
    SELECT * INTO actor FROM public.user_profiles WHERE auth_user_id = auth.uid() AND status = 'Active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active user profile required' USING ERRCODE = 'insufficient_privilege';
    END IF;
    safe_notes := public.redact_nj_brc_sensitive_text(
        left(p_decision_notes, 2000), request.federal_tax_id, request.taxpayer_id_submission
    );

    PERFORM set_config('subtracker.nj_brc_review_decision', request.id::TEXT, TRUE);
    UPDATE public.compliance_sync_review_queue
    SET status = 'rejected',
        reviewed_by = actor.email,
        reviewed_at = now(),
        review_notes = safe_notes,
        rejection_reason = safe_notes,
        approval_source = 'nj-brc-manual',
        updated_at = now()
    WHERE id = review.id;
    UPDATE public.nj_brc_search_requests
    SET status = 'completed', completed_at = now(), updated_at = now()
    WHERE id = request.id;
    INSERT INTO public.administration_audit_log(
        user_id, user_name, user_email, action, object_type,
        object_id, object_label, details
    )
    VALUES (
        actor.auth_user_id, actor.name, actor.email, 'REJECT',
        'nj_brc_search_requests', request.id::TEXT,
        request.company_name || ' NJ BRC',
        jsonb_build_object(
            'contractor_id', request.contractor_id,
            'review_queue_id', review.id,
            'rejection_reason', safe_notes
        )
    );
    RETURN TRUE;
END;
$$;
REVOKE ALL ON FUNCTION public.reject_nj_brc_search_request(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_nj_brc_search_request(UUID, TEXT) TO authenticated;

COMMIT;
