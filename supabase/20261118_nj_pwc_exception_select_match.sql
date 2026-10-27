-- Manual stored-result selection only; no worker, retry or nightly policy changes.
-- Apply after the existing NJ PWC registry sync / atomic queue / retry lifecycle
-- migrations. Does not require the separate Add Contractor approval migration.
BEGIN;

CREATE OR REPLACE FUNCTION public.get_nj_pwc_exception_candidates(p_exception_id INTEGER)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    e public.nj_pwc_sync_exceptions;
    r public.compliance_sync_search_requests;
    c public.contractors;
    records JSONB;
    settings JSONB;
    candidates JSONB;
BEGIN
    SELECT * INTO STRICT e FROM nj_pwc_sync_exceptions WHERE id=p_exception_id;
    IF e.status<>'open' OR e.reason<>'Multiple Matches' THEN
        RAISE EXCEPTION 'Exception is no longer an open Multiple Matches exception.' USING ERRCODE='55000';
    END IF;
    SELECT * INTO STRICT c FROM contractors WHERE id=e.contractor_id;
    IF NOT c.active THEN
        RAISE EXCEPTION 'Contractor is inactive.' USING ERRCODE='55000';
    END IF;
    SELECT * INTO STRICT r FROM compliance_sync_search_requests WHERE id=e.last_search_request_id;
    IF r.contractor_id IS DISTINCT FROM c.id OR r.compliance_name<>'NJ PWC'
        OR r.is_test IS DISTINCT FROM e.is_test OR r.status<>'completed' OR r.completed_at IS NULL
        OR r.result_status NOT IN ('Match Found','Multiple Matches') OR r.imported_at IS NOT NULL
        OR EXISTS(SELECT 1 FROM compliance_sync_search_requests newer
            WHERE newer.contractor_id=c.id AND newer.compliance_name='NJ PWC' AND newer.is_test=e.is_test
                AND newer.origin<>'user' AND newer.id>r.id
                AND newer.status IN ('pending','claimed','processing','completed','no_match','failed')) THEN
        RAISE EXCEPTION 'Latest registry request changed, is still running, or has already been imported. Refresh exceptions.' USING ERRCODE='55000';
    END IF;
    SELECT jsonb_build_object('enabled',enabled,'mode',mode) INTO settings
        FROM compliance_sync_settings WHERE compliance_name='NJ PWC';
    SELECT coalesce(jsonb_agg(to_jsonb(cr) ORDER BY cr.id),'[]') INTO records
        FROM compliance_records cr WHERE cr.contractor_id=c.id
            AND cr.compliance_type_id=nj_pwc_compliance_type_id() AND cr.active AND cr.is_current;
    SELECT coalesce(jsonb_agg(jsonb_build_object('identity',md5(value::text),
        'business_name',value->>'business_name','certificate_number',value->>'certificate_number',
        'address',value->>'address','city',value->>'city','state',value->>'state',
        'zip_code',value->>'zip_code','county',value->>'county',
        'registration_date',value->>'registration_date','expiration_date',value->>'expiration_date',
        'source_url',coalesce(value->>'source_url',r.source_url)) ORDER BY ordinal),'[]') INTO candidates
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.candidates)='array' THEN r.candidates ELSE '[]' END)
        WITH ORDINALITY AS stored(value,ordinal)
    WHERE nullif(btrim(value->>'business_name'),'') IS NOT NULL
        AND nj_pwc_normalize_certificate(value->>'certificate_number') IS NOT NULL;
    RETURN jsonb_build_object('exception_id',e.id,'contractor_id',c.id,'company_name',c.company_name,
        'search_request_id',r.id,'is_test',e.is_test,'candidates',candidates,
        'snapshot',md5(jsonb_build_object('exception',to_jsonb(e),'request',to_jsonb(r),
            'contractor',to_jsonb(c),'records',records,'settings',settings)::text));
END $$;

CREATE OR REPLACE FUNCTION public.select_nj_pwc_exception_match(
    p_exception_id INTEGER,p_request_id INTEGER,p_candidate_identity TEXT,p_snapshot TEXT,p_confirmed BOOLEAN,
    p_actor_id UUID,p_actor_name TEXT,p_actor_email TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    e public.nj_pwc_sync_exceptions;
    r public.compliance_sync_search_requests;
    preview JSONB;
    candidate JSONB;
    matches INTEGER;
    result RECORD;
    response JSONB;
    receipt JSONB;
BEGIN
    IF p_confirmed IS DISTINCT FROM TRUE OR p_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated explicit confirmation is required.' USING ERRCODE='22023';
    END IF;
    SELECT * INTO STRICT e FROM nj_pwc_sync_exceptions WHERE id=p_exception_id;
    PERFORM 1 FROM compliance_sync_settings WHERE compliance_name='NJ PWC' FOR SHARE;
    PERFORM 1 FROM contractors WHERE id=e.contractor_id FOR UPDATE;
    SELECT * INTO STRICT e FROM nj_pwc_sync_exceptions WHERE id=p_exception_id FOR UPDATE;
    IF e.last_search_request_id IS DISTINCT FROM p_request_id OR e.reason<>'Multiple Matches' THEN
        RAISE EXCEPTION 'Exception or latest request changed. Refresh exceptions.' USING ERRCODE='55000';
    END IF;
    SELECT * INTO STRICT r FROM compliance_sync_search_requests WHERE id=p_request_id FOR UPDATE;
    PERFORM 1 FROM compliance_records WHERE contractor_id=e.contractor_id
        AND compliance_type_id=nj_pwc_compliance_type_id() AND active AND is_current FOR UPDATE;
    SELECT count(*),(array_agg(value))[1] INTO matches,candidate
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.candidates)='array' THEN r.candidates ELSE '[]' END)
        WHERE md5(value::text)=p_candidate_identity;
    IF matches<>1 THEN
        RAISE EXCEPTION 'Selected registry candidate is missing or duplicated. Refresh the stored results.' USING ERRCODE='22023';
    END IF;
    IF nullif(btrim(candidate->>'business_name'),'') IS NULL THEN
        RAISE EXCEPTION 'Selected registry candidate has no company name.' USING ERRCODE='22023';
    END IF;
    IF (SELECT count(*) FROM jsonb_array_elements(r.candidates) value
        WHERE nj_pwc_normalize_certificate(value->>'certificate_number')=
            nj_pwc_normalize_certificate(candidate->>'certificate_number'))<>1 THEN
        RAISE EXCEPTION 'Selected certificate is not unique in the stored results; manual investigation is required.' USING ERRCODE='22023';
    END IF;
    -- A receipt permits only exact same-actor replay, with no second application.
    SELECT details->'result' INTO receipt FROM administration_audit_log
        WHERE action='NJ_PWC_EXCEPTION_MATCH_SELECTED' AND object_type='contractor'
            AND object_id=e.contractor_id::text AND user_id=p_actor_id
            AND details->>'exception_id'=p_exception_id::text
            AND details->>'search_request_id'=p_request_id::text
            AND details->>'candidate_identity'=p_candidate_identity AND details->>'snapshot'=p_snapshot
        ORDER BY id DESC LIMIT 1;
    IF receipt IS NOT NULL AND r.imported_at IS NOT NULL THEN
        RETURN receipt || jsonb_build_object('already_processed',true);
    END IF;
    preview:=get_nj_pwc_exception_candidates(p_exception_id);
    IF p_snapshot IS NULL OR preview->>'snapshot' IS DISTINCT FROM p_snapshot THEN
        RAISE EXCEPTION 'Registry selection changed. Refresh and confirm the current results.' USING ERRCODE='55000';
    END IF;
    SELECT * INTO STRICT result FROM import_nj_pwc_candidate(p_request_id,e.contractor_id,
        candidate->>'certificate_number',p_actor_id,p_actor_name,p_actor_email);
    IF result.approval='review_required' AND result.review_queue_id IS NOT NULL THEN
        PERFORM nj_pwc_lock_state(e.contractor_id,FALSE);
        UPDATE nj_pwc_sync_exceptions SET review_queue_id=result.review_queue_id,
            resolution_note='Registry candidate selected; awaiting PWC Review.',updated_at=now() WHERE id=e.id;
        UPDATE nj_pwc_sync_state SET state='Review Required',updated_at=now()
            WHERE contractor_id=e.contractor_id AND (NOT is_test OR is_test=e.is_test);
    ELSIF result.approval IN ('auto_approved','refreshed') AND result.compliance_record_id IS NOT NULL THEN
        -- The importer uses nj_pwc_mark_sync_success to close exceptions.
        IF e.is_test THEN
            PERFORM nj_pwc_mark_sync_success(e.contractor_id,TRUE,p_request_id,NULL,p_actor_name);
        END IF;
    ELSE
        RAISE EXCEPTION 'Selected registry result returned no application or review outcome.' USING ERRCODE='55000';
    END IF;
    response:=jsonb_build_object('approval',result.approval,'review_reason',result.review_reason,
        'review_queue_id',result.review_queue_id,'compliance_record_id',result.compliance_record_id,
        'record_action',result.record_action,'search_request_id',p_request_id,'exception_id',e.id);
    PERFORM nj_pwc_write_audit(p_actor_id,p_actor_name,p_actor_email,'NJ_PWC_EXCEPTION_MATCH_SELECTED',
        'contractor',e.contractor_id::text,preview->>'company_name',
        jsonb_build_object('exception_id',e.id,'search_request_id',p_request_id,
            'candidate_identity',p_candidate_identity,'certificate_number',candidate->>'certificate_number',
            'snapshot',p_snapshot,'result',response));
    RETURN response;
END $$;

REVOKE ALL ON FUNCTION public.get_nj_pwc_exception_candidates(INTEGER),
    public.select_nj_pwc_exception_match(INTEGER,INTEGER,TEXT,TEXT,BOOLEAN,UUID,TEXT,TEXT)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_nj_pwc_exception_candidates(INTEGER),
    public.select_nj_pwc_exception_match(INTEGER,INTEGER,TEXT,TEXT,BOOLEAN,UUID,TEXT,TEXT) TO service_role;
COMMIT;
