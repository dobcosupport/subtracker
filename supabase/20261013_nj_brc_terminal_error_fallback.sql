-- Persist terminal NJ BRC website errors even if result/exception reporting
-- fails, so a worker-side selector failure cannot leave its request processing.
BEGIN;

CREATE OR REPLACE FUNCTION public.store_nj_brc_terminal_error(
    p_request_id UUID,
    p_worker_instance_id UUID,
    p_error_code TEXT,
    p_error_message TEXT
)
RETURNS TABLE (request_id UUID, status TEXT, error_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    request public.nj_brc_search_requests%ROWTYPE;
    safe_message TEXT;
BEGIN
    IF p_error_code IS DISTINCT FROM 'website_error' THEN
        RAISE EXCEPTION 'Unsupported NJ BRC terminal error code' USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO request
    FROM public.nj_brc_search_requests r
    WHERE r.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ BRC request not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF request.worker_instance_id IS DISTINCT FROM p_worker_instance_id
       OR request.claim_worker_key IS DISTINCT FROM 'nj-brc' THEN
        RAISE EXCEPTION 'NJ BRC request is not owned by this worker instance' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF request.result_type IS NOT NULL THEN
        IF request.result_type <> 'website_error' THEN
            RAISE EXCEPTION 'NJ BRC result already recorded with a different classification' USING ERRCODE = 'check_violation';
        END IF;
        RETURN QUERY SELECT request.id, request.status, request.error_code;
        RETURN;
    END IF;
    IF request.status NOT IN ('claimed', 'processing', 'human_verification_required') THEN
        RAISE EXCEPTION 'NJ BRC request cannot accept a result in its current state' USING ERRCODE = 'check_violation';
    END IF;

    safe_message := left(trim(public.redact_nj_brc_sensitive_text(
        nullif(p_error_message, ''),
        request.federal_tax_id,
        request.taxpayer_id_submission
    )), 2000);
    IF coalesce(safe_message, '') = '' THEN
        safe_message := 'NJ BRC website lookup failed.';
    END IF;

    UPDATE public.nj_brc_search_requests r SET
        status = 'website_error',
        result_type = 'website_error',
        result_evidence = jsonb_build_object('match_rationale', safe_message),
        error_code = 'website_error',
        completed_at = now(),
        updated_at = now()
    WHERE r.id = request.id
    RETURNING r.* INTO request;

    RETURN QUERY SELECT request.id, request.status, request.error_code;
END;
$$;

REVOKE ALL ON FUNCTION public.store_nj_brc_terminal_error(UUID, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_nj_brc_terminal_error(UUID, UUID, TEXT, TEXT) TO service_role;

COMMIT;
