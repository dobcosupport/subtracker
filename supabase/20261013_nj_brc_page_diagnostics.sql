-- Attach sanitized post-submission page diagnostics (URL, title, text excerpt,
-- screenshot, HTML snapshot) to an NJ BRC request already stored as website_error.
-- Diagnostics are supplemental: the terminal result is persisted first by
-- report_nj_brc_search_result or store_nj_brc_terminal_error.
BEGIN;

CREATE OR REPLACE FUNCTION public.attach_nj_brc_page_diagnostics(
    p_request_id UUID,
    p_worker_instance_id UUID,
    p_diagnostics JSONB
)
RETURNS TABLE (request_id UUID, attached BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    request public.nj_brc_search_requests%ROWTYPE;
    diagnostics JSONB;
    screenshot JSONB;
    safe_screenshot JSONB;
BEGIN
    IF p_diagnostics IS NULL OR jsonb_typeof(p_diagnostics) <> 'object' THEN
        RAISE EXCEPTION 'NJ BRC page diagnostics must be an object' USING ERRCODE = 'invalid_parameter_value';
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
    IF request.status IS DISTINCT FROM 'website_error' OR request.result_type IS DISTINCT FROM 'website_error' THEN
        RAISE EXCEPTION 'NJ BRC page diagnostics require a stored website_error result' USING ERRCODE = 'object_not_in_prerequisite_state';
    END IF;
    IF request.result_evidence ? 'page_diagnostics' THEN
        RETURN QUERY SELECT request.id, FALSE;
        RETURN;
    END IF;

    screenshot := p_diagnostics->'screenshot';
    IF jsonb_typeof(screenshot) = 'object'
       AND screenshot->>'content_type' IN ('image/jpeg', 'image/png')
       AND length(coalesce(screenshot->>'data_base64', '')) BETWEEN 1 AND 1048576
       AND screenshot->>'data_base64' ~ '^[A-Za-z0-9+/]+={0,2}$' THEN
        safe_screenshot := jsonb_build_object(
            'content_type', screenshot->>'content_type',
            'data_base64', screenshot->>'data_base64'
        );
    END IF;

    diagnostics := jsonb_strip_nulls(jsonb_build_object(
        'page_url', nullif(left(public.redact_nj_brc_sensitive_text(
            regexp_replace(p_diagnostics->>'page_url', '[?#].*$', ''), request.federal_tax_id, request.taxpayer_id_submission), 1000), ''),
        'page_title', nullif(left(trim(public.redact_nj_brc_sensitive_text(
            p_diagnostics->>'page_title', request.federal_tax_id, request.taxpayer_id_submission)), 300), ''),
        'page_text', nullif(left(trim(public.redact_nj_brc_sensitive_text(
            p_diagnostics->>'page_text', request.federal_tax_id, request.taxpayer_id_submission)), 3072), ''),
        'html_snapshot', nullif(left(public.redact_nj_brc_sensitive_text(
            p_diagnostics->>'html_snapshot', request.federal_tax_id, request.taxpayer_id_submission), 262144), ''),
        'html_truncated', CASE WHEN p_diagnostics->>'html_truncated' = 'true' THEN TRUE END,
        'capture_error', nullif(left(trim(public.redact_nj_brc_sensitive_text(
            p_diagnostics->>'capture_error', request.federal_tax_id, request.taxpayer_id_submission)), 500), ''),
        'captured_at', CASE WHEN p_diagnostics->>'captured_at' ~ '^\d{4}-\d{2}-\d{2}T'
            THEN p_diagnostics->>'captured_at' END,
        'screenshot', safe_screenshot
    ));

    UPDATE public.nj_brc_search_requests r SET
        result_evidence = coalesce(r.result_evidence, '{}'::jsonb) || jsonb_build_object('page_diagnostics', diagnostics),
        updated_at = now()
    WHERE r.id = request.id;

    RETURN QUERY SELECT request.id, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_nj_brc_page_diagnostics(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_nj_brc_page_diagnostics(UUID, UUID, JSONB) TO service_role;

COMMIT;
