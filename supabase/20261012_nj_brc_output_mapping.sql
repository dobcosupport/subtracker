-- Migration: Make NJ BRC # (Business Entity ID) an output populated from Certificate Number, not a search input.
-- Requires: BRC Name Control and Taxpayer ID (FEIN) only.
-- Removes required 10-digit check on nj_brc_number.

BEGIN;

-- 1. Make nj_brc_number nullable and relax constraint on nj_brc_search_requests
ALTER TABLE public.nj_brc_search_requests
    ALTER COLUMN nj_brc_number DROP NOT NULL;

ALTER TABLE public.nj_brc_search_requests
    DROP CONSTRAINT IF EXISTS nj_brc_submission_matches_fein;

ALTER TABLE public.nj_brc_search_requests
    ADD CONSTRAINT nj_brc_submission_matches_fein CHECK (
        federal_tax_id ~ '^[0-9[:space:]().-]+$'
        AND taxpayer_id_submission =
            regexp_replace(coalesce(federal_tax_id, ''), '[^0-9]', '', 'g') || '000'
        AND length(regexp_replace(coalesce(federal_tax_id, ''), '[^0-9]', '', 'g')) = 9
        AND brc_name_control ~ '^[A-Za-z0-9&-]{4}$'
        AND (nj_brc_number IS NULL OR length(nj_brc_number) <= 100)
    );

-- 2. Update create_nj_brc_search_request to require only FEIN and BRC Name Control
CREATE OR REPLACE FUNCTION public.create_nj_brc_search_request(
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
        '***-**-' || right(regexp_replace(request.federal_tax_id, '[^0-9]', '', 'g'), 4),
        '********' || right(request.taxpayer_id_submission, 4),
        request.status, request.created_at, FALSE;
END;
$$;

-- 3. Update report_nj_brc_search_result to populate contractors.nj_brc_number on successful certificate
CREATE OR REPLACE FUNCTION public.report_nj_brc_search_result(
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

-- 4. Update approve_nj_brc_search_request to populate contractors.nj_brc_number and remove static nj_brc_number match check
CREATE OR REPLACE FUNCTION public.approve_nj_brc_search_request(
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
        contractor_id, compliance_type_id, registration_number,
        effective_date, expiration_date, verified_date, verified_by,
        verification_source, is_current, active, notes
    )
    VALUES (
        request.contractor_id, compliance_type, review.certificate_number,
        review.synced_effective_date_proposed, NULL,
        coalesce(review.last_verified, now()), actor.name,
        'NJ BRC Website', TRUE, TRUE, safe_notes
    )
    RETURNING id INTO new_record_id;

    UPDATE public.compliance_sync_review_queue SET
        status = 'approved',
        compliance_record_id = new_record_id,
        reviewed_by = actor.name,
        reviewed_at = now(),
        review_notes = safe_notes,
        updated_at = now()
    WHERE id = review.id;

    UPDATE public.contractors
    SET nj_brc_number = review.certificate_number, updated_at = now()
    WHERE id = request.contractor_id;

    UPDATE public.nj_brc_search_requests SET
        status = 'completed',
        completed_at = now(),
        updated_at = now()
    WHERE id = request.id;

    INSERT INTO public.administration_audit_log(
        user_id, user_email, user_name, action,
        object_type, object_id, details
    )
    VALUES (
        actor.auth_user_id, actor.email, actor.name, 'APPROVE',
        'nj_brc_search_requests', request.id::TEXT,
        jsonb_build_object(
            'contractor_id', request.contractor_id,
            'compliance_record_id', new_record_id,
            'review_queue_id', review.id,
            'certificate_number', review.certificate_number,
            'effective_date', review.synced_effective_date_proposed,
            'decision_notes', safe_notes
        )
    );

    RETURN new_record_id;
END;
$$;

COMMIT;
