-- Forward-only NJ BRC repair. Apply only after review, with the BRC worker stopped.
BEGIN;

CREATE TABLE public.nj_brc_worker_lease (
    worker_key TEXT PRIMARY KEY CHECK (worker_key = 'nj-brc'),
    instance_id UUID NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);
ALTER TABLE public.nj_brc_worker_lease ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nj_brc_worker_lease FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.nj_brc_worker_lease TO service_role;

CREATE FUNCTION public.assert_nj_brc_worker_lease(p_instance UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM 1 FROM public.nj_brc_worker_lease l
    JOIN public.compliance_sync_workers w ON w.worker_key = l.worker_key
    WHERE l.worker_key = 'nj-brc' AND l.instance_id = p_instance
      AND l.expires_at > clock_timestamp() AND w.enabled
    FOR UPDATE OF l;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ BRC worker lease is absent, expired, disabled, or owned by another instance'
            USING ERRCODE = '55000';
    END IF;
END;
$$;

-- An interrupted source submission is never automatically replayed. Retain the
-- snapshot and evidence, close it explicitly, and allow a fresh user-requested search.
CREATE FUNCTION public.close_interrupted_nj_brc_requests(p_instance UUID, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE;
BEGIN
    FOR r IN SELECT * FROM public.nj_brc_search_requests q
        WHERE q.worker_instance_id = p_instance
          AND q.status IN ('claimed', 'processing', 'human_verification_required')
          AND q.result_type IS NULL FOR UPDATE
    LOOP
        UPDATE public.nj_brc_search_requests SET
            status = 'failed', result_type = 'failed', error_code = p_reason,
            result_evidence = coalesce(r.result_evidence, '{}'::jsonb) || jsonb_build_object(
                'match_rationale', 'Worker ownership ended; source submission outcome is uncertain. Explicit review and a new search are required.',
                'interruption', p_reason),
            completed_at = now(), updated_at = now()
        WHERE id = r.id;
        INSERT INTO public.compliance_sync_exceptions(
            contractor_id, compliance_name, exception_type, message, company_name, resolved)
        VALUES (r.contractor_id, 'NJ BRC', 'Failed',
            'NJ BRC worker interrupted; source outcome is uncertain (' || p_reason || ').', r.company_name, FALSE);
        INSERT INTO public.administration_audit_log(
            user_name, user_email, action, object_type, object_id, object_label, details)
        VALUES ('NJ BRC Worker', '', 'NJ_BRC_REQUEST_INTERRUPTED', 'nj_brc_search_requests',
            r.id::text, r.company_name || ' NJ BRC', jsonb_build_object('reason', p_reason, 'instance_id', p_instance));
    END LOOP;
END;
$$;

CREATE FUNCTION public.manage_nj_brc_worker_lease(
    p_instance UUID, p_action TEXT, p_ttl_seconds INTEGER DEFAULT 90
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE l public.nj_brc_worker_lease%ROWTYPE;
BEGIN
    IF p_instance IS NULL OR p_action IS NULL OR p_action NOT IN ('acquire', 'renew', 'release')
       OR p_ttl_seconds IS NULL OR p_ttl_seconds NOT BETWEEN 60 AND 300 THEN
        RAISE EXCEPTION 'Invalid NJ BRC lease request' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(61130, 1);
    SELECT * INTO l FROM public.nj_brc_worker_lease WHERE worker_key = 'nj-brc' FOR UPDATE;
    IF p_action = 'release' THEN
        IF l.instance_id IS DISTINCT FROM p_instance THEN
            RAISE EXCEPTION 'NJ BRC lease is not owned by this instance' USING ERRCODE = '55000';
        END IF;
        PERFORM public.close_interrupted_nj_brc_requests(p_instance, 'worker_shutdown');
        DELETE FROM public.nj_brc_worker_lease WHERE worker_key = 'nj-brc';
        RETURN jsonb_build_object('released', TRUE);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.compliance_sync_workers WHERE worker_key = 'nj-brc' AND enabled) THEN
        RAISE EXCEPTION 'NJ BRC worker is disabled' USING ERRCODE = '55000';
    END IF;
    IF p_action = 'renew' THEN
        PERFORM public.assert_nj_brc_worker_lease(p_instance);
    ELSIF l.expires_at > clock_timestamp() AND l.instance_id IS DISTINCT FROM p_instance THEN
        RAISE EXCEPTION 'NJ BRC worker lease is already held' USING ERRCODE = '55000';
    ELSIF l.expires_at <= clock_timestamp() OR l.instance_id IS NULL THEN
        -- Includes legacy in-flight requests left by a pre-lease worker.
        PERFORM public.close_interrupted_nj_brc_requests(q.worker_instance_id, 'worker_lease_expired')
        FROM (SELECT DISTINCT worker_instance_id FROM public.nj_brc_search_requests
              WHERE status IN ('claimed','processing','human_verification_required')
                AND worker_instance_id IS NOT NULL) q;
    END IF;
    INSERT INTO public.nj_brc_worker_lease VALUES ('nj-brc', p_instance, clock_timestamp() + make_interval(secs => p_ttl_seconds))
    ON CONFLICT (worker_key) DO UPDATE SET instance_id = EXCLUDED.instance_id, expires_at = EXCLUDED.expires_at;
    RETURN jsonb_build_object('owned', TRUE, 'ttl_seconds', p_ttl_seconds);
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_nj_brc_search_request(p_worker_instance_id UUID)
RETURNS TABLE(id UUID, contractor_id INTEGER, company_name TEXT, nj_brc_number TEXT,
    brc_name_control TEXT, taxpayer_id_submission TEXT, status TEXT, created_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ, processing_started_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    SELECT * INTO r FROM public.nj_brc_search_requests q
    WHERE q.worker_instance_id = p_worker_instance_id
      AND q.status IN ('claimed','processing','human_verification_required')
    ORDER BY q.claimed_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
        SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.status = 'pending'
        ORDER BY q.created_at, q.id LIMIT 1 FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN RETURN; END IF;
        UPDATE public.nj_brc_search_requests q SET status = 'claimed', claim_worker_key = 'nj-brc',
            worker_instance_id = p_worker_instance_id, claimed_at = now(), updated_at = now()
        WHERE q.id = r.id RETURNING * INTO r;
    END IF;
    RETURN QUERY SELECT r.id,r.contractor_id,r.company_name::text,r.nj_brc_number::text,
        r.brc_name_control::text,r.taxpayer_id_submission::text,r.status,r.created_at,r.claimed_at,r.processing_started_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_nj_brc_search_request_state(
    p_request_id UUID, p_worker_instance_id UUID, p_status TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    IF p_status IS NULL OR p_status NOT IN ('processing','human_verification_required') THEN
        RAISE EXCEPTION 'Invalid NJ BRC transition' USING ERRCODE = '22023';
    END IF;
    UPDATE public.nj_brc_search_requests q SET status = p_status, updated_at = now(),
        processing_started_at = CASE WHEN p_status = 'processing' THEN coalesce(q.processing_started_at,now())
            ELSE q.processing_started_at END
    WHERE q.id = p_request_id AND q.worker_instance_id = p_worker_instance_id AND q.claim_worker_key = 'nj-brc'
      AND q.status IN ('claimed','processing','human_verification_required') AND q.result_type IS NULL
    RETURNING * INTO r;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ BRC request state or ownership changed' USING ERRCODE = '55000'; END IF;
    RETURN TRUE;
END;
$$;

CREATE FUNCTION public.sanitize_nj_brc_result_evidence(p_evidence JSONB,p_fein TEXT,p_submission TEXT)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path = public,pg_temp AS $$
DECLARE evidence JSONB := '{}'; field TEXT;
BEGIN
    IF jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'NJ BRC evidence must be an object' USING ERRCODE = '22023';
    END IF;
    FOREACH field IN ARRAY ARRAY['taxpayer_name','trade_name','address','certificate_number','effective_date',
        'date_of_issuance','office_use_only','source_url','verified_at','match_rationale']
    LOOP
        evidence := evidence || jsonb_build_object(field,nullif(left(trim(
            CASE WHEN field = 'certificate_number' THEN p_evidence->>field
                 ELSE public.redact_nj_brc_sensitive_text(p_evidence->>field,p_fein,p_submission) END),
            CASE WHEN field = 'match_rationale' THEN 2000 WHEN field = 'source_url' THEN 1000 ELSE 800 END),''));
    END LOOP;
    RETURN jsonb_strip_nulls(evidence) || jsonb_build_object('discrepancy_warnings',
        CASE WHEN jsonb_typeof(p_evidence->'discrepancy_warnings') = 'array'
            THEN (SELECT coalesce(jsonb_agg(left(public.redact_nj_brc_sensitive_text(value,p_fein,p_submission),500)),'[]')
                  FROM (SELECT value FROM jsonb_array_elements_text(p_evidence->'discrepancy_warnings') LIMIT 50) warnings)
            ELSE '[]'::jsonb END);
END;
$$;
REVOKE ALL ON FUNCTION public.sanitize_nj_brc_result_evidence(JSONB,TEXT,TEXT) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.report_nj_brc_search_result(
    p_request_id UUID, p_worker_instance_id UUID, p_result_type TEXT, p_evidence JSONB, p_error_code TEXT DEFAULT NULL
)
RETURNS TABLE(request_id UUID, status TEXT, review_queue_id INTEGER, idempotent BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r public.nj_brc_search_requests%ROWTYPE;
    current_record public.compliance_records%ROWTYPE;
    evidence JSONB := '{}'::jsonb;
    kind TEXT := p_result_type;
    final_status TEXT;
    review_result TEXT;
    review_id INTEGER;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    IF kind IS NULL OR kind NOT IN ('successful_certificate','no_match','invalid_input',
        'identity_mismatch','ambiguous_result','website_error','failed')
        OR p_evidence IS NULL OR jsonb_typeof(p_evidence) <> 'object' THEN
        RAISE EXCEPTION 'Unsupported NJ BRC result' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ BRC request not found' USING ERRCODE = 'P0002'; END IF;
    IF r.worker_instance_id IS DISTINCT FROM p_worker_instance_id OR r.claim_worker_key IS DISTINCT FROM 'nj-brc' THEN
        RAISE EXCEPTION 'NJ BRC request is not owned by this worker instance' USING ERRCODE = '42501';
    END IF;
    IF r.result_type IS NOT NULL THEN
        IF r.result_type <> kind AND NOT (r.result_type = 'identity_mismatch' AND kind = 'successful_certificate')
           AND NOT (r.result_type = 'failed' AND (r.result_evidence->>'attempted_result_type') IS NOT DISTINCT FROM kind) THEN
            RAISE EXCEPTION 'NJ BRC result already recorded with a different classification' USING ERRCODE = '23514';
        END IF;
        RETURN QUERY SELECT r.id,r.status,r.review_queue_id,TRUE; RETURN;
    END IF;
    IF r.status NOT IN ('claimed','processing','human_verification_required') THEN
        RAISE EXCEPTION 'NJ BRC request cannot accept a result in its current state' USING ERRCODE = '23514';
    END IF;
    evidence := public.sanitize_nj_brc_result_evidence(p_evidence,r.federal_tax_id,r.taxpayer_id_submission);
    IF kind = 'successful_certificate' THEN
        IF coalesce(evidence->>'taxpayer_name','') = '' OR coalesce(evidence->>'certificate_number','') = ''
           OR coalesce(evidence->>'effective_date','') !~ '^\d{4}-\d{2}-\d{2}$'
           OR coalesce(evidence->>'source_url','') !~ '^https://www1\.state\.nj\.us/TYTR_BRC/[^?#]*$'
           OR coalesce(evidence->>'verified_at','') = '' OR coalesce(evidence->>'match_rationale','') = '' THEN
            RAISE EXCEPTION 'Successful NJ BRC result is missing required certificate evidence' USING ERRCODE = '23514';
        END IF;
        PERFORM (evidence->>'effective_date')::date, (evidence->>'verified_at')::timestamptz;
        IF public.normalize_nj_brc_business_name(r.company_name) = ''
           OR public.normalize_nj_brc_business_name(r.company_name)
                IS DISTINCT FROM public.normalize_nj_brc_business_name(evidence->>'taxpayer_name') THEN
            kind := 'identity_mismatch';
        END IF;
    END IF;
    IF kind = 'successful_certificate' THEN
        final_status := 'review_required';
        PERFORM set_config('subtracker.nj_brc_result_request',r.id::text,TRUE);
        SELECT cr.* INTO current_record FROM public.compliance_records cr
        JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
        WHERE cr.contractor_id = r.contractor_id AND ct.compliance_name = 'NJ BRC' AND cr.active AND cr.is_current
        ORDER BY cr.updated_at DESC, cr.id DESC LIMIT 1;
        INSERT INTO public.compliance_sync_review_queue(
            contractor_id,compliance_record_id,compliance_name,proposed_registration_number,proposed_status,
            proposed_expiration_date,current_registration_number,current_expiration_date,current_effective_date,
            status,sync_source,searched_registration_number,matched_registration_number,matched_company_name,
            synced_effective_date,synced_effective_date_proposed,last_verified,source_url,result_status,
            raw_result_summary,approval_source,brc_name_control_used,business_entity_id_used,certificate_number,
            brc_evidence,federal_tax_id_masked,taxpayer_id_submission_masked,nj_brc_request_id)
        VALUES (r.contractor_id,current_record.id,'NJ BRC',evidence->>'certificate_number','Registered',
            NULL,current_record.registration_number,current_record.expiration_date,current_record.effective_date,
            'pending','RPA',r.nj_brc_number,evidence->>'certificate_number',r.company_name,
            (evidence->>'effective_date')::date,(evidence->>'effective_date')::date,
            (evidence->>'verified_at')::timestamptz,evidence->>'source_url','Successful Certificate',
            'NJ BRC certificate captured; approval required.','nj-brc-review',r.brc_name_control,r.nj_brc_number,
            evidence->>'certificate_number',evidence,'***-**-' || right(regexp_replace(r.federal_tax_id,'[^0-9]','','g'),4),
            '********' || right(r.taxpayer_id_submission,4),r.id)
        RETURNING id INTO review_id;
        -- Preserve the installed output mapping; current-record authority triggers still apply.
        UPDATE public.contractors SET nj_brc_number = evidence->>'certificate_number',updated_at = now() WHERE id = r.contractor_id;
    ELSE
        final_status := kind;
        review_result := CASE kind WHEN 'no_match' THEN 'No Match Found' WHEN 'invalid_input' THEN 'Invalid Search'
            WHEN 'identity_mismatch' THEN 'Identity Mismatch' WHEN 'ambiguous_result' THEN 'Ambiguous Result'
            WHEN 'website_error' THEN 'Website Error' ELSE 'Failed' END;
        INSERT INTO public.compliance_sync_exceptions(
            contractor_id,compliance_name,exception_type,message,resolved,source_url,company_name)
        VALUES (r.contractor_id,'NJ BRC',review_result,
            'NJ BRC lookup ended as ' || review_result || '. ' || coalesce(evidence->>'match_rationale',''),
            FALSE,evidence->>'source_url',r.company_name);
    END IF;
    UPDATE public.nj_brc_search_requests q SET status = final_status,result_type = kind,result_evidence = evidence,
        error_code = CASE WHEN kind = 'successful_certificate' THEN NULL
            WHEN p_error_code ~ '^[A-Za-z0-9_-]{1,100}$' THEN p_error_code ELSE kind END,
        review_queue_id = review_id,completed_at = CASE WHEN final_status <> 'review_required' THEN now() END,updated_at = now()
    WHERE q.id = r.id;
    RETURN QUERY SELECT r.id,final_status,review_id,FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.approve_nj_brc_search_request(p_request_id UUID, p_decision_notes TEXT DEFAULT NULL)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    r public.nj_brc_search_requests%ROWTYPE;
    review public.compliance_sync_review_queue%ROWTYPE;
    contractor public.contractors%ROWTYPE;
    actor public.user_profiles%ROWTYPE;
    compliance_type INTEGER;
    requires_expiration_flag BOOLEAN;
    record_id INTEGER;
    safe_notes TEXT;
BEGIN
    IF NOT coalesce(public.user_has_module_permission('compliance_sync','manage'),FALSE) THEN
        RAISE EXCEPTION 'Compliance Sync manage permission required' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.id = p_request_id FOR UPDATE;
    IF NOT FOUND OR r.status <> 'review_required' OR r.result_type <> 'successful_certificate' OR r.review_queue_id IS NULL THEN
        RAISE EXCEPTION 'NJ BRC request is not awaiting approval' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO review FROM public.compliance_sync_review_queue q WHERE q.id = r.review_queue_id FOR UPDATE;
    IF NOT FOUND OR review.nj_brc_request_id IS DISTINCT FROM r.id OR review.contractor_id <> r.contractor_id
       OR review.compliance_name <> 'NJ BRC' OR review.status <> 'pending'
       OR review.approval_source IS DISTINCT FROM 'nj-brc-review' OR review.is_test THEN
        RAISE EXCEPTION 'NJ BRC review item is not pending for this contractor' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO contractor FROM public.contractors c WHERE c.id = r.contractor_id FOR UPDATE;
    IF NOT FOUND OR contractor.active IS DISTINCT FROM TRUE OR contractor.company_name IS DISTINCT FROM r.company_name
       OR contractor.brc_name_control IS DISTINCT FROM r.brc_name_control OR contractor.federal_tax_id IS DISTINCT FROM r.federal_tax_id
       OR r.taxpayer_id_submission IS DISTINCT FROM regexp_replace(coalesce(contractor.federal_tax_id,''),'[^0-9]','','g') || '000' THEN
        RAISE EXCEPTION 'Contractor lookup identifiers changed after request creation' USING ERRCODE = '23514';
    END IF;
    IF coalesce(review.brc_evidence->>'taxpayer_name','') = '' OR coalesce(review.brc_evidence->>'match_rationale','') = ''
       OR coalesce(review.certificate_number,'') = '' OR review.synced_effective_date_proposed IS NULL
       OR coalesce(review.brc_evidence->>'source_url','') !~ '^https://www1\.state\.nj\.us/TYTR_BRC/[^?#]*$'
       OR coalesce(review.brc_evidence->>'verified_at','') = '' THEN
        RAISE EXCEPTION 'NJ BRC identity or certificate evidence is incomplete' USING ERRCODE = '23514';
    END IF;
    IF public.normalize_nj_brc_business_name(r.company_name) = ''
       OR public.normalize_nj_brc_business_name(r.company_name)
          IS DISTINCT FROM public.normalize_nj_brc_business_name(review.brc_evidence->>'taxpayer_name')
       OR review.certificate_number IS DISTINCT FROM review.brc_evidence->>'certificate_number'
       OR review.proposed_registration_number IS DISTINCT FROM review.certificate_number
       OR review.synced_effective_date_proposed IS DISTINCT FROM (review.brc_evidence->>'effective_date')::date
       OR review.last_verified IS DISTINCT FROM (review.brc_evidence->>'verified_at')::timestamptz
       OR review.brc_evidence IS DISTINCT FROM r.result_evidence OR review.proposed_expiration_date IS NOT NULL THEN
        RAISE EXCEPTION 'NJ BRC review fields no longer match extracted evidence' USING ERRCODE = '23514';
    END IF;
    SELECT id,requires_expiration INTO compliance_type,requires_expiration_flag
    FROM public.compliance_types WHERE compliance_name = 'NJ BRC' AND active;
    IF compliance_type IS NULL OR requires_expiration_flag IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION 'NJ BRC must be configured as non-expiring before approval' USING ERRCODE = '23514';
    END IF;
    SELECT * INTO actor FROM public.user_profiles WHERE auth_user_id = auth.uid() AND status = 'Active';
    IF NOT FOUND THEN RAISE EXCEPTION 'Active user profile required' USING ERRCODE = '42501'; END IF;
    safe_notes := public.redact_nj_brc_sensitive_text(nullif(left(p_decision_notes,2000),''),r.federal_tax_id,r.taxpayer_id_submission);
    UPDATE public.compliance_records SET active = FALSE,is_current = FALSE,updated_at = now()
    WHERE contractor_id = r.contractor_id AND compliance_type_id = compliance_type AND (active OR is_current);
    INSERT INTO public.compliance_records(contractor_id,compliance_type_id,registration_number,effective_date,expiration_date,
        verified_date,verified_by,verification_source,is_current,active,notes)
    VALUES (r.contractor_id,compliance_type,review.certificate_number,review.synced_effective_date_proposed,NULL,
        coalesce(review.last_verified,now()),actor.name,'NJ BRC Website',TRUE,TRUE,safe_notes) RETURNING id INTO record_id;
    PERFORM set_config('subtracker.nj_brc_review_decision',r.id::text,TRUE);
    UPDATE public.compliance_sync_review_queue SET status = 'approved',compliance_record_id = record_id,
        reviewed_by = actor.email,reviewed_at = now(),review_notes = safe_notes,approval_source = 'nj-brc-manual',updated_at = now()
    WHERE id = review.id;
    UPDATE public.contractors SET nj_brc_number = review.certificate_number,updated_at = now() WHERE id = r.contractor_id;
    UPDATE public.nj_brc_search_requests SET status = 'completed',completed_at = now(),updated_at = now() WHERE id = r.id;
    INSERT INTO public.administration_audit_log(user_id,user_email,user_name,action,object_type,object_id,object_label,details)
    VALUES (actor.auth_user_id,actor.email,actor.name,'APPROVE','nj_brc_search_requests',r.id::text,r.company_name || ' NJ BRC',
        jsonb_build_object('contractor_id',r.contractor_id,'compliance_record_id',record_id,'review_queue_id',review.id,
            'certificate_number',review.certificate_number,'effective_date',review.synced_effective_date_proposed,
            'expiration_date',NULL,'decision_notes',safe_notes));
    RETURN record_id;
END;
$$;

-- Keep the existing view identity, columns, dependencies and other-type rules.
DO $$
DECLARE columns TEXT;
BEGIN
    SELECT string_agg(format('status.%I',attname),', ' ORDER BY attnum) INTO columns
    FROM pg_attribute WHERE attrelid = 'public.contractor_compliance_status'::regclass
      AND attnum > 0 AND NOT attisdropped;
    EXECUTE 'CREATE OR REPLACE VIEW public.contractor_compliance_status WITH (security_invoker = true) AS SELECT '
        || columns || ' FROM (' || $view$
SELECT c.id AS contractor_id,c.company_name,c.active AS contractor_active,
    cr.active AS compliance_active,cr.is_current AS compliance_current,
    CASE WHEN ct.id IS NULL THEN NULL ELSE cr.id END AS compliance_record_id,
    ct.id AS compliance_type_id,ct.compliance_name,cr.registration_number,
    CASE WHEN ct.compliance_name = 'NJ BRC' THEN NULL::date ELSE cr.expiration_date END AS expiration_date,
    CASE WHEN cr.id IS NULL OR cr.expiration_date IS NULL OR ct.compliance_name = 'NJ BRC' THEN NULL
        ELSE (cr.expiration_date - CURRENT_DATE)::integer END AS days_remaining,
    CASE WHEN cr.id IS NULL THEN 'Missing Information'
        WHEN ct.compliance_name = 'NJ BRC' THEN
            CASE WHEN nullif(trim(cr.registration_number),'') IS NULL THEN 'Missing Information' ELSE 'Active' END
        WHEN ct.requires_expiration = TRUE AND cr.expiration_date IS NULL THEN 'Missing Information'
        WHEN ct.compliance_name IN ('NJ PWC','NY PWC') AND nullif(trim(cr.registration_number),'') IS NULL THEN 'Missing Information'
        WHEN cr.registry_status = 'Expired - Not Found in Registry' THEN 'Expired'
        WHEN cr.expiration_date <= CURRENT_DATE THEN 'Expired'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 1 AND 30 THEN '30 Day'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 31 AND 60 THEN '60 Day'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 61 AND 90 THEN '90 Day'
        WHEN cr.expiration_date IS NULL AND ct.requires_expiration = FALSE THEN 'Active'
        WHEN (cr.expiration_date - CURRENT_DATE) > 90 THEN 'Active'
        ELSE 'Active' END AS calculated_status
FROM public.contractors c
LEFT JOIN public.compliance_records cr ON cr.contractor_id = c.id AND cr.active AND cr.is_current
LEFT JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id AND ct.active
WHERE c.active
$view$ || ') status';
END;
$$;

-- Each health renewal is authoritative ownership confirmation. Keep the actual
-- claim timestamp intact; the BRC health UI allows its configured idle backoff.
CREATE FUNCTION public.report_nj_brc_worker(p_report JSONB, p_ttl_seconds INTEGER DEFAULT 90)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE w public.compliance_sync_workers%ROWTYPE; accepted BOOLEAN;
BEGIN
    IF p_report->>'worker_key' IS DISTINCT FROM 'nj-brc' THEN
        RAISE EXCEPTION 'Invalid BRC worker report' USING ERRCODE = '22023';
    END IF;
    PERFORM public.manage_nj_brc_worker_lease((p_report->>'instance_id')::uuid,'renew',p_ttl_seconds);
    accepted := public.report_compliance_worker(p_report);
    IF NOT accepted THEN RAISE EXCEPTION 'NJ BRC worker report rejected' USING ERRCODE = '55000'; END IF;
    SELECT * INTO w FROM public.compliance_sync_workers WHERE worker_key = 'nj-brc';
    RETURN jsonb_build_object('ok',TRUE,'test_id',
        CASE WHEN w.test_acknowledged_at IS NULL AND w.test_requested_at > now() - interval '30 seconds' THEN w.test_id END);
END;
$$;

CREATE FUNCTION public.store_nj_brc_reporting_failure(
    p_request_id UUID, p_worker_instance_id UUID, p_result_type TEXT, p_evidence JSONB
)
RETURNS TABLE(request_id UUID, status TEXT, review_queue_id INTEGER, idempotent BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE; evidence JSONB;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    IF p_result_type IS NULL OR p_result_type NOT IN ('successful_certificate','no_match','invalid_input',
        'identity_mismatch','ambiguous_result','website_error','failed') OR jsonb_typeof(p_evidence) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid NJ BRC reporting failure' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ BRC request not found' USING ERRCODE = 'P0002'; END IF;
    IF r.worker_instance_id IS DISTINCT FROM p_worker_instance_id OR r.claim_worker_key IS DISTINCT FROM 'nj-brc' THEN
        RAISE EXCEPTION 'NJ BRC request is not owned by this worker instance' USING ERRCODE = '42501';
    END IF;
    IF r.result_type IS NOT NULL THEN
        IF r.result_type <> p_result_type
           AND NOT (r.result_type = 'failed' AND (r.result_evidence->>'attempted_result_type') IS NOT DISTINCT FROM p_result_type)
           AND NOT (r.result_type = 'identity_mismatch' AND p_result_type = 'successful_certificate') THEN
            RAISE EXCEPTION 'NJ BRC result already recorded with a different classification' USING ERRCODE = '23514';
        END IF;
        RETURN QUERY SELECT r.id,r.status,r.review_queue_id,TRUE; RETURN;
    END IF;
    IF r.status NOT IN ('claimed','processing','human_verification_required') THEN
        RAISE EXCEPTION 'NJ BRC request cannot accept a result in its current state' USING ERRCODE = '23514';
    END IF;
    evidence := public.sanitize_nj_brc_result_evidence(p_evidence,r.federal_tax_id,r.taxpayer_id_submission);
    evidence := evidence || jsonb_build_object('attempted_result_type',p_result_type,
        'reporting_failure',TRUE,'reporting_failure_message','Result ingestion failed; original evidence retained for explicit review.');
    UPDATE public.nj_brc_search_requests SET status = 'failed',result_type = 'failed',
        result_evidence = evidence,error_code = 'reporting_failure',completed_at = now(),updated_at = now() WHERE id = r.id;
    INSERT INTO public.compliance_sync_exceptions(contractor_id,compliance_name,exception_type,message,resolved,company_name)
    VALUES (r.contractor_id,'NJ BRC','Failed','NJ BRC result reporting failed; retained evidence requires review.',FALSE,r.company_name);
    RETURN QUERY SELECT r.id,'failed'::text,NULL::integer,FALSE;
END;
$$;

-- Retain the website-error fallback contract, now fenced by the same lease.
ALTER FUNCTION public.store_nj_brc_terminal_error(UUID,UUID,TEXT,TEXT) RENAME TO store_nj_brc_terminal_error_before_lease;
REVOKE ALL ON FUNCTION public.store_nj_brc_terminal_error_before_lease(UUID,UUID,TEXT,TEXT) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.store_nj_brc_terminal_error(
    p_request_id UUID,p_worker_instance_id UUID,p_error_code TEXT,p_error_message TEXT,p_evidence JSONB DEFAULT '{}')
RETURNS TABLE(request_id UUID,status TEXT,error_code TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.id=p_request_id FOR UPDATE;
    PERFORM public.store_nj_brc_terminal_error_before_lease(p_request_id,p_worker_instance_id,p_error_code,p_error_message);
    IF r.result_type IS NULL THEN
        UPDATE public.nj_brc_search_requests q SET result_evidence = q.result_evidence ||
            public.sanitize_nj_brc_result_evidence(p_evidence,r.federal_tax_id,r.taxpayer_id_submission)
            WHERE q.id=r.id;
    END IF;
    SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.id=p_request_id;
    RETURN QUERY SELECT r.id,r.status,r.error_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.attach_nj_brc_page_diagnostics(
    p_request_id UUID,p_worker_instance_id UUID,p_diagnostics JSONB
)
RETURNS TABLE(request_id UUID,attached BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE; d JSONB; field TEXT; f JSONB; frames JSONB := '[]';
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ BRC request not found' USING ERRCODE = 'P0002'; END IF;
    IF r.worker_instance_id IS DISTINCT FROM p_worker_instance_id OR r.claim_worker_key IS DISTINCT FROM 'nj-brc' THEN
        RAISE EXCEPTION 'NJ BRC request is not owned by this worker instance' USING ERRCODE = '42501';
    END IF;
    IF r.status NOT IN ('website_error','failed') OR r.result_type IS NULL THEN
        RAISE EXCEPTION 'NJ BRC diagnostics require a stored failure' USING ERRCODE = '55000';
    END IF;
    IF jsonb_typeof(p_diagnostics) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'NJ BRC page diagnostics must be an object' USING ERRCODE = '22023';
    END IF;
    d := '{}'::jsonb;
    FOREACH field IN ARRAY ARRAY['page_url','page_title','page_text','capture_error','captured_at',
        'classification','stage']
    LOOP
        d := d || jsonb_build_object(field,left(public.redact_nj_brc_sensitive_text(
            CASE WHEN field = 'page_url' THEN regexp_replace(p_diagnostics->>field,'[?#].*$','')
                 ELSE p_diagnostics->>field END,r.federal_tax_id,r.taxpayer_id_submission),
            CASE WHEN field = 'page_text' THEN 3072 ELSE 1000 END));
    END LOOP;
    IF jsonb_typeof(p_diagnostics->'iframes') = 'array' THEN
        FOR f IN SELECT value FROM jsonb_array_elements(p_diagnostics->'iframes') LIMIT 20 LOOP
            frames := frames || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
                'url',left(public.redact_nj_brc_sensitive_text(regexp_replace(f->>'url','[?#].*$',''),
                    r.federal_tax_id,r.taxpayer_id_submission),500),
                'title',left(public.redact_nj_brc_sensitive_text(f->>'title',r.federal_tax_id,r.taxpayer_id_submission),200),
                'visible',f->'visible')));
        END LOOP;
    END IF;
    d := d || jsonb_build_object('iframes',frames,'iframe_count',p_diagnostics->'iframe_count',
        'response_status',p_diagnostics->'response_status','protection_detected',p_diagnostics->'protection_detected',
        'human_verification_detected',p_diagnostics->'human_verification_detected');
    UPDATE public.nj_brc_search_requests SET result_evidence = coalesce(r.result_evidence,'{}') ||
        jsonb_build_object('page_diagnostics',jsonb_strip_nulls(d)),updated_at = now() WHERE id = r.id;
    RETURN QUERY SELECT r.id,TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.recover_orphaned_nj_brc_request(
    p_request_id UUID,p_min_age_minutes INTEGER,p_actor_id UUID,p_actor_name TEXT,p_actor_email TEXT,p_error_message TEXT
)
RETURNS TABLE(request_id UUID,status TEXT,completed_at TIMESTAMPTZ,error_code TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public,pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE;
BEGIN
    IF p_min_age_minutes IS NULL OR p_min_age_minutes NOT BETWEEN 1 AND 1440 THEN
        RAISE EXCEPTION 'Invalid orphan age' USING ERRCODE = '22023';
    END IF;
    PERFORM pg_advisory_xact_lock(61130,1);
    PERFORM 1 FROM public.nj_brc_worker_lease WHERE worker_key = 'nj-brc' FOR UPDATE;
    SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.id = p_request_id FOR UPDATE;
    IF NOT FOUND OR r.status NOT IN ('claimed','processing','human_verification_required')
       OR r.result_type IS NOT NULL OR r.review_queue_id IS NOT NULL OR r.worker_instance_id IS NULL
       OR r.claimed_at IS NULL OR r.claimed_at > now() - make_interval(mins => p_min_age_minutes)
       OR EXISTS(SELECT 1 FROM public.nj_brc_worker_lease l WHERE l.instance_id = r.worker_instance_id
           AND l.expires_at > clock_timestamp()) THEN
        RAISE EXCEPTION 'NJ BRC request no longer meets orphan recovery criteria' USING ERRCODE = '55000';
    END IF;
    PERFORM public.store_nj_brc_terminal_error_before_lease(r.id,r.worker_instance_id,'website_error',p_error_message);
    INSERT INTO public.administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
    VALUES(p_actor_id,coalesce(nullif(p_actor_name,''),'Administrator'),coalesce(p_actor_email,''),
        'NJ_BRC_ORPHANED_REQUEST_RECOVERED','nj_brc_search_requests',r.id::text,r.company_name || ' NJ BRC',
        jsonb_build_object('previous_status',r.status,'instance_id',r.worker_instance_id));
    RETURN QUERY SELECT q.id,q.status,q.completed_at,q.error_code FROM public.nj_brc_search_requests q WHERE q.id = r.id;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_nj_brc_worker_lease(UUID),
    public.close_interrupted_nj_brc_requests(UUID,TEXT),
    public.manage_nj_brc_worker_lease(UUID,TEXT,INTEGER),
    public.report_nj_brc_worker(JSONB,INTEGER) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.manage_nj_brc_worker_lease(UUID,TEXT,INTEGER),
    public.report_nj_brc_worker(JSONB,INTEGER) TO service_role;
REVOKE ALL ON FUNCTION public.claim_nj_brc_search_request(UUID),
    public.set_nj_brc_search_request_state(UUID,UUID,TEXT),
    public.report_nj_brc_search_result(UUID,UUID,TEXT,JSONB,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.claim_nj_brc_search_request(UUID),
    public.set_nj_brc_search_request_state(UUID,UUID,TEXT),
    public.report_nj_brc_search_result(UUID,UUID,TEXT,JSONB,TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.approve_nj_brc_search_request(UUID,TEXT) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.approve_nj_brc_search_request(UUID,TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.store_nj_brc_reporting_failure(UUID,UUID,TEXT,JSONB),
    public.store_nj_brc_terminal_error(UUID,UUID,TEXT,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.store_nj_brc_reporting_failure(UUID,UUID,TEXT,JSONB),
    public.store_nj_brc_terminal_error(UUID,UUID,TEXT,TEXT,JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
