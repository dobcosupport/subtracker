-- Fresh, current-contractor snapshot for exception retries.
-- Apply after 20261015_nj_pwc_atomic_queue.sql and 20261016 registry acceptance.
BEGIN;

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
    v_retry_of_request_id INTEGER;
    v_company_name TEXT;
    v_city TEXT;
    v_state TEXT;
    v_zip TEXT;
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

    v_retry_of_request_id := v_exception.last_search_request_id;
    v_company_name := left(upper(btrim(regexp_replace(v_contractor.company_name, '\s+', ' ', 'g'))), 200);
    v_city := left(nullif(btrim(v_contractor.city), ''), 150);
    v_state := left(nullif(btrim(v_contractor.state), ''), 100);
    v_zip := left(nullif(btrim(v_contractor.zip_code), ''), 20);

    INSERT INTO public.compliance_sync_search_requests(
        compliance_name, searched_company_name, searched_city, searched_state, searched_zip_code,
        status, candidates, is_test, requested_by, contractor_id, origin, priority, retry_of_request_id
    )
    VALUES (
        'NJ PWC', v_company_name, v_city, v_state, v_zip,
        'pending', '[]'::JSONB, v_exception.is_test, left(v_actor, 200), v_contractor.id,
        'exception_retry', 10, v_retry_of_request_id
    )
    RETURNING id INTO v_request_id;

    UPDATE public.nj_pwc_sync_exceptions SET last_search_request_id = v_request_id, updated_at = now()
    WHERE id = p_exception_id AND status = 'open';

    PERFORM public.nj_pwc_write_audit(
        p_actor_id, v_actor, p_actor_email,
        public.nj_pwc_audit_action('NJ_PWC_SYNC_EXCEPTION_RETRY', v_exception.is_test),
        'contractor', v_contractor.id::TEXT,
        public.nj_pwc_audit_label(v_contractor.company_name, v_exception.is_test),
        jsonb_build_object(
            'exception_id', p_exception_id,
            'reason', v_exception.reason,
            'search_request_id', v_request_id,
            'retry_of_request_id', v_retry_of_request_id,
            'searched_company_name', v_company_name,
            'searched_city', v_city,
            'searched_state', v_state,
            'searched_zip_code', v_zip,
            'is_test', v_exception.is_test
        )
    );

    RETURN QUERY SELECT p_exception_id, v_request_id, TRUE;
END;
$$;

COMMIT;