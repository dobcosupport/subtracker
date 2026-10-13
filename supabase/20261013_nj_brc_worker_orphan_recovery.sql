-- Guarded administrator recovery for abandoned NJ BRC claimed/processing requests.
-- The terminal state update and its audit record commit or roll back together.
BEGIN;

CREATE OR REPLACE FUNCTION public.recover_orphaned_nj_brc_request(
    p_request_id UUID,
    p_min_age_minutes INTEGER,
    p_actor_id UUID,
    p_actor_name TEXT,
    p_actor_email TEXT,
    p_error_message TEXT
)
RETURNS TABLE (request_id UUID, status TEXT, completed_at TIMESTAMPTZ, error_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    request public.nj_brc_search_requests%ROWTYPE;
    current_worker public.compliance_sync_workers%ROWTYPE;
    terminal_result RECORD;
    audit_name TEXT;
    audit_email TEXT;
BEGIN
    IF p_min_age_minutes IS NULL OR p_min_age_minutes < 1 OR p_min_age_minutes > 1440 THEN
        RAISE EXCEPTION 'NJ BRC orphan age threshold must be between 1 and 1440 minutes'
            USING ERRCODE = 'invalid_parameter_value';
    END IF;

    SELECT * INTO request
    FROM public.nj_brc_search_requests r
    WHERE r.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ BRC request not found' USING ERRCODE = 'no_data_found';
    END IF;
    IF request.status NOT IN ('claimed', 'processing')
       OR request.completed_at IS NOT NULL
       OR request.review_queue_id IS NOT NULL
       OR request.result_type IS NOT NULL
       OR request.worker_instance_id IS NULL
       OR request.claimed_at IS NULL
       OR request.claimed_at > now() - make_interval(mins => p_min_age_minutes) THEN
        RAISE EXCEPTION 'NJ BRC request no longer meets orphan recovery criteria'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    SELECT * INTO current_worker
    FROM public.compliance_sync_workers w
    WHERE w.worker_key = 'nj-brc'
    FOR UPDATE;
    IF FOUND AND current_worker.instance_id IS NOT DISTINCT FROM request.worker_instance_id THEN
        RAISE EXCEPTION 'NJ BRC request is still assigned to the registered worker instance'
            USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;

    -- The worker registry records the sole current NJ BRC process instance.
    -- A different (or absent) registered instance means the recorded owner is no longer active.
    SELECT * INTO terminal_result
    FROM public.store_nj_brc_terminal_error(
        request.id,
        request.worker_instance_id,
        'website_error',
        coalesce(nullif(trim(p_error_message), ''), 'NJ BRC request abandoned by inactive worker.')
    );

    SELECT coalesce(nullif(trim(p_actor_name), ''), 'Unknown administrator'),
           coalesce(nullif(trim(p_actor_email), ''), '')
    INTO audit_name, audit_email;

    INSERT INTO public.administration_audit_log(
        user_id, user_name, user_email, action, object_type, object_id, object_label, details
    )
    VALUES (
        p_actor_id,
        audit_name,
        audit_email,
        'NJ_BRC_ORPHANED_REQUEST_RECOVERED',
        'nj_brc_search_requests',
        request.id::TEXT,
        request.company_name || ' NJ BRC search',
        jsonb_build_object(
            'contractor_id', request.contractor_id,
            'previous_status', request.status,
            'new_status', terminal_result.status,
            'worker_instance_id', request.worker_instance_id,
            'age_threshold_minutes', p_min_age_minutes,
            'error_code', terminal_result.error_code
        )
    );

    RETURN QUERY SELECT terminal_result.request_id, terminal_result.status,
        (SELECT r.completed_at FROM public.nj_brc_search_requests r WHERE r.id = request.id),
        terminal_result.error_code;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_orphaned_nj_brc_request(UUID, INTEGER, UUID, TEXT, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_orphaned_nj_brc_request(UUID, INTEGER, UUID, TEXT, TEXT, TEXT)
    TO service_role;

COMMIT;
