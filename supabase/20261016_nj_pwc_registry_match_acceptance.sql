-- User-confirmed data correction only. Daily automatic matching is unchanged.
-- Apply after the 20261014 NJ PWC schema/functions migrations.
BEGIN;

-- The registry-match workflow delegates compliance processing to the
-- deployed import entry point without rewriting its implementation.
DO $preflight$
DECLARE
    v_import_oid OID;
    v_argument_types TEXT[];
    v_result_type TEXT;
    v_language TEXT;
    v_security_definer BOOLEAN;
    v_returns_set BOOLEAN;
    v_owner_name NAME;
    v_owner_superuser BOOLEAN;
BEGIN
    v_import_oid := to_regprocedure(
        'public.import_nj_pwc_candidate(integer,integer,text,uuid,text,text)'
    );
    IF v_import_oid IS NULL THEN
        RAISE EXCEPTION 'Expected public.import_nj_pwc_candidate(integer, integer, text, uuid, text, text) was not found.';
    END IF;

    SELECT l.lanname, p.prosecdef, p.proretset, pg_get_function_result(p.oid),
        r.rolname, r.rolsuper
    INTO v_language, v_security_definer, v_returns_set, v_result_type,
        v_owner_name, v_owner_superuser
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.oid = v_import_oid;

    SELECT array_agg(format_type(argument.type_oid, NULL) ORDER BY argument.ordinality)
    INTO v_argument_types
    FROM pg_proc p
    CROSS JOIN LATERAL unnest(p.proargtypes) WITH ORDINALITY AS argument(type_oid, ordinality)
    WHERE p.oid = v_import_oid;

    IF v_argument_types IS DISTINCT FROM ARRAY['integer','integer','text','uuid','text','text']::TEXT[] THEN
        RAISE EXCEPTION 'NJ PWC import argument types/order are incompatible: %.', v_argument_types;
    END IF;
    IF v_result_type IS DISTINCT FROM
       'TABLE(sync_run_id integer, review_queue_id integer, approval text, review_reason text, compliance_record_id integer, record_action text)'
       OR NOT v_returns_set THEN
        RAISE EXCEPTION 'NJ PWC import result structure is incompatible: %.', v_result_type;
    END IF;
    IF v_language <> 'plpgsql' OR NOT v_security_definer THEN
        RAISE EXCEPTION 'NJ PWC import must remain a PL/pgSQL SECURITY DEFINER function.';
    END IF;
    IF v_owner_name IS NULL OR v_owner_name IN ('anon','authenticated','service_role')
       OR (NOT v_owner_superuser AND v_owner_name <> current_user) THEN
        RAISE EXCEPTION 'NJ PWC import has an untrusted or unexpected owner: %.', v_owner_name;
    END IF;
    IF NOT has_function_privilege('service_role', v_import_oid, 'EXECUTE')
       OR has_function_privilege('anon', v_import_oid, 'EXECUTE')
       OR has_function_privilege('authenticated', v_import_oid, 'EXECUTE') THEN
        RAISE EXCEPTION 'NJ PWC import must be executable only by the trusted server role.';
    END IF;
END $preflight$;

CREATE OR REPLACE FUNCTION public.nj_pwc_comparison_text(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT nullif(btrim(regexp_replace(regexp_replace(
        regexp_replace(upper(coalesce(p_value,'')), '[,.]', '', 'g'),
        '\s*&\s*', '&', 'g'), '\s+', ' ', 'g')), '');
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_comparison_street(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT public.nj_pwc_comparison_text(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
        public.nj_pwc_comparison_text(p_value),
        '\mSTREET\M','ST','g'), '\mAVENUE\M','AVE','g'), '\mBOULEVARD\M','BLVD','g'), '\mROAD\M','RD','g'));
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_comparison_zip(p_value TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT CASE WHEN btrim(p_value) ~ '^\d{5}(-?\d{4})?$' THEN left(btrim(p_value),5) ELSE NULL END;
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_registry_match_evidence(
    p_contractor JSONB,p_known TEXT[],p_candidate JSONB,p_certificate_matches INTEGER,p_plausible INTEGER
)
RETURNS JSONB LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
    v_cert BOOLEAN := coalesce(public.nj_pwc_normalize_certificate(p_candidate->>'certificate_number') = ANY(p_known),FALSE);
    v_street TEXT := public.nj_pwc_comparison_street(concat_ws(' ',nullif(p_contractor->>'address_1',''),nullif(p_contractor->>'address_2','')));
    v_registry_street TEXT := public.nj_pwc_comparison_street(p_candidate->>'address');
    v_street_match BOOLEAN;
    v_city BOOLEAN := coalesce(public.nj_pwc_comparison_text(p_contractor->>'city') = public.nj_pwc_comparison_text(p_candidate->>'city'),FALSE);
    v_state BOOLEAN := coalesce(public.nj_pwc_comparison_text(p_contractor->>'state') = public.nj_pwc_comparison_text(p_candidate->>'state'),FALSE);
    v_zip BOOLEAN := coalesce(public.nj_pwc_comparison_zip(p_contractor->>'zip_code') = public.nj_pwc_comparison_zip(p_candidate->>'zip_code'),FALSE);
    v_unit TEXT;
    v_registry_unit TEXT;
    v_unit_conflict BOOLEAN;
    v_expiration DATE := public.nj_pwc_try_date(p_candidate->>'expiration_date');
    v_registration DATE := public.nj_pwc_try_date(p_candidate->>'registration_date');
    v_anomaly BOOLEAN := public.nj_pwc_candidate_is_anomalous(p_candidate) OR coalesce(v_registration > CURRENT_DATE,FALSE);
    v_active BOOLEAN;
    v_confidence TEXT := 'Low';
BEGIN
    -- Unit markers and all following text remain part of the street comparison.
    v_unit := substring(v_street FROM '\m(?:APT|APARTMENT|SUITE|STE|UNIT|FLOOR|FL|BUILDING|BLDG)(?:\M|(?=[0-9])).*|#.*');
    v_registry_unit := substring(v_registry_street FROM '\m(?:APT|APARTMENT|SUITE|STE|UNIT|FLOOR|FL|BUILDING|BLDG)(?:\M|(?=[0-9])).*|#.*');
    v_unit_conflict := v_unit IS DISTINCT FROM v_registry_unit;
    v_street_match := coalesce(v_street = v_registry_street,FALSE);
    v_unit_conflict := v_unit_conflict OR
        (public.nj_pwc_comparison_text(p_contractor->>'address_2') IS NOT NULL AND NOT v_street_match);
    v_active := coalesce(v_expiration >= CURRENT_DATE AND NOT coalesce(v_anomaly,TRUE),FALSE);
    IF p_candidate IS NOT NULL AND v_active AND NOT v_unit_conflict AND p_plausible = 1
       AND coalesce(cardinality(p_known),0) <= 1 THEN
        IF v_cert AND p_certificate_matches = 1 AND v_street_match AND v_city AND v_state AND v_zip THEN
            v_confidence := 'High';
        ELSIF (v_cert AND v_city AND v_state AND v_zip)
           OR (coalesce(cardinality(p_known),0)=0 AND v_street_match AND v_city AND v_state AND v_zip) THEN
            v_confidence := 'Medium';
        END IF;
    END IF;
    RETURN jsonb_build_object('confidence',v_confidence,'certificate_match',v_cert,
        'certificate_matches',p_certificate_matches,'plausible_candidates',p_plausible,
        'street_address_match',v_street_match,'city_match',v_city,'state_match',v_state,'zip_match',v_zip,
        'unit_conflict',v_unit_conflict,'registration_active',v_active,
        'expired',coalesce(v_expiration < CURRENT_DATE,FALSE),        'registry_anomaly',coalesce(v_anomaly,TRUE) OR coalesce(cardinality(p_known),0)>1,
        'name_match',coalesce(public.nj_pwc_comparison_text(p_contractor->>'company_name') =
            public.nj_pwc_comparison_text(p_candidate->>'business_name'),FALSE));
END $$;

CREATE OR REPLACE FUNCTION public.get_nj_pwc_registry_match(p_exception_id INTEGER)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_exception public.nj_pwc_sync_exceptions%ROWTYPE;
    v_request public.compliance_sync_search_requests%ROWTYPE;
    v_contractor public.contractors%ROWTYPE;
    v_current JSONB;
    v_known TEXT[];
    v_records JSONB;
    v_candidate JSONB;
    v_candidates JSONB;
    v_matches INTEGER;
    v_total INTEGER;
    v_duplicate BOOLEAN;
    v_evidence JSONB;
    v_settings JSONB;
    v_snapshot TEXT;
BEGIN
    SELECT * INTO v_exception FROM public.nj_pwc_sync_exceptions WHERE id=p_exception_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ PWC exception not found.' USING ERRCODE='P0002'; END IF;
    IF v_exception.status <> 'open' OR v_exception.reason <> 'Name Mismatch' THEN
        RAISE EXCEPTION 'Exception is resolved or is not a Name Mismatch.' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_contractor FROM public.contractors WHERE id=v_exception.contractor_id;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests WHERE id=v_exception.last_search_request_id;
    v_current := jsonb_build_object('company_name',v_contractor.company_name,'address_1',v_contractor.address_1,
        'address_2',v_contractor.address_2,'city',v_contractor.city,'state',v_contractor.state,
        'zip_code',v_contractor.zip_code,'county',v_contractor.county,'nj_pwc_number',v_contractor.nj_pwc_number);
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',cr.id,'certificate',cr.registration_number,
        'updated_at',cr.updated_at) ORDER BY cr.id),'[]') INTO v_records
    FROM public.compliance_records cr JOIN public.compliance_types ct ON ct.id=cr.compliance_type_id
    WHERE cr.contractor_id=v_contractor.id AND cr.active AND cr.is_current AND ct.compliance_name='NJ PWC';
    SELECT coalesce(array_agg(DISTINCT cert) FILTER(WHERE cert IS NOT NULL),ARRAY[]::TEXT[]) INTO v_known
    FROM (
        SELECT public.nj_pwc_normalize_certificate(v_contractor.nj_pwc_number) AS cert
        UNION ALL SELECT public.nj_pwc_normalize_certificate(r->>'certificate') FROM jsonb_array_elements(v_records) r
    ) k;
    v_candidates := CASE WHEN v_request.compliance_name='NJ PWC' AND v_request.status='completed'
        AND v_request.result_status IN ('Match Found','Multiple Matches')
        AND v_request.contractor_id=v_contractor.id
        AND v_request.is_test=v_exception.is_test AND v_request.imported_at IS NULL
        AND jsonb_typeof(v_request.candidates)='array' THEN v_request.candidates ELSE '[]'::JSONB END;
    v_total := jsonb_array_length(v_candidates);
    SELECT count(*)::INTEGER,(array_agg(c))[1] INTO v_matches,v_candidate
    FROM jsonb_array_elements(v_candidates) c
    WHERE public.nj_pwc_normalize_certificate(c->>'certificate_number')=ANY(v_known);
    IF v_matches <> 1 THEN
        v_candidate := CASE WHEN v_total=1 THEN v_candidates->0 ELSE NULL END;
    END IF;
    -- Only safe registry-supported fields are returned and fingerprinted.
    IF v_candidate IS NOT NULL THEN
        v_candidate := jsonb_build_object('business_name',v_candidate->>'business_name',
            'address',v_candidate->>'address','city',v_candidate->>'city','state',v_candidate->>'state',
            'zip_code',v_candidate->>'zip_code','county',v_candidate->>'county',
            'certificate_number',v_candidate->>'certificate_number',
            'registration_date',v_candidate->>'registration_date','expiration_date',v_candidate->>'expiration_date');
        IF nullif(btrim(v_candidate->>'business_name'),'') IS NULL
           OR public.nj_pwc_normalize_certificate(v_candidate->>'certificate_number') IS NULL THEN
            v_candidate := NULL;
        END IF;
    END IF;
    SELECT EXISTS(
        SELECT 1 FROM public.contractors c WHERE c.id<>v_contractor.id AND (
            public.nj_pwc_normalize_name(c.company_name)=public.nj_pwc_normalize_name(v_candidate->>'business_name')
            OR public.nj_pwc_normalize_certificate(c.nj_pwc_number)=public.nj_pwc_normalize_certificate(v_candidate->>'certificate_number')
            OR EXISTS(SELECT 1 FROM public.compliance_records cr JOIN public.compliance_types ct ON ct.id=cr.compliance_type_id
                WHERE cr.contractor_id=c.id AND cr.active AND cr.is_current AND ct.compliance_name='NJ PWC'
                AND public.nj_pwc_normalize_certificate(cr.registration_number)=public.nj_pwc_normalize_certificate(v_candidate->>'certificate_number'))
        )
    ) INTO v_duplicate;
    v_evidence := public.nj_pwc_registry_match_evidence(v_current,v_known,v_candidate,v_matches,
        CASE WHEN v_matches=1 THEN 1 ELSE v_total END);
    SELECT jsonb_build_object('enabled',enabled,'mode',mode) INTO v_settings
    FROM public.compliance_sync_settings WHERE compliance_name='NJ PWC';
    v_snapshot := md5(jsonb_build_object('exception_id',v_exception.id,'exception_updated_at',v_exception.updated_at,
        'request_id',v_request.id,'request_updated_at',v_request.updated_at,
        'candidates_hash',md5(v_request.candidates::TEXT),'candidate',v_candidate,
        'contractor',v_current,'contractor_updated_at',v_contractor.updated_at,'records',v_records,
        'evidence',v_evidence,'duplicate',v_duplicate,'settings',v_settings)::TEXT);
    RETURN jsonb_build_object('exception_id',v_exception.id,'contractor_id',v_contractor.id,
        'search_request_id',v_request.id,'is_test',v_exception.is_test,'current',v_current,
        'known_certificates',v_known,'candidate',v_candidate,'evidence',v_evidence,'snapshot',v_snapshot,
        'duplicate_target',v_duplicate,'can_accept',v_candidate IS NOT NULL AND NOT v_duplicate,
        'mode',v_settings->>'mode');
END $$;

CREATE OR REPLACE FUNCTION public.get_nj_pwc_registry_matches(p_exception_ids INTEGER[])
RETURNS TABLE(exception_id INTEGER,comparison JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT e.id,public.get_nj_pwc_registry_match(e.id) FROM public.nj_pwc_sync_exceptions e
    WHERE e.id=ANY(p_exception_ids) AND e.status='open' AND e.reason='Name Mismatch';
$$;

CREATE OR REPLACE FUNCTION public.accept_nj_pwc_registry_match(
    p_exception_id INTEGER,p_snapshot TEXT,p_selected_fields TEXT[],p_confirmed BOOLEAN,
    p_actor_id UUID,p_actor_name TEXT,p_actor_email TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_exception public.nj_pwc_sync_exceptions%ROWTYPE;
    v_preview JSONB;
    v_candidate JSONB;
    v_old JSONB;
    v_new JSONB;
    v_changes JSONB := '{}'::JSONB;
    v_key TEXT;
    v_value TEXT;
    v_result RECORD;
    v_defer_name BOOLEAN;
BEGIN
    IF p_confirmed IS DISTINCT FROM TRUE THEN RAISE EXCEPTION 'Explicit confirmation is required.' USING ERRCODE='22023'; END IF;
    IF p_selected_fields IS NULL OR NOT ('company_name'=ANY(p_selected_fields))
       OR EXISTS(SELECT 1 FROM unnest(p_selected_fields) f WHERE f IS NULL OR f NOT IN
            ('company_name','address_1','city','state','zip_code','county','nj_pwc_number')) THEN
        RAISE EXCEPTION 'Select Company Name and only supported registry fields.' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_exception FROM public.nj_pwc_sync_exceptions WHERE id=p_exception_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ PWC exception not found.' USING ERRCODE='P0002'; END IF;
    PERFORM 1 FROM public.compliance_sync_settings WHERE compliance_name='NJ PWC' FOR SHARE;
    -- Serialize duplicate-target checks between acceptance transactions.
    PERFORM pg_advisory_xact_lock(61016,1);
    PERFORM 1 FROM public.contractors WHERE id=v_exception.contractor_id FOR UPDATE;
    PERFORM 1 FROM public.compliance_sync_search_requests WHERE id=v_exception.last_search_request_id FOR UPDATE;
    PERFORM 1 FROM public.nj_pwc_sync_exceptions WHERE id=p_exception_id FOR UPDATE;
    PERFORM 1 FROM public.compliance_records cr JOIN public.compliance_types ct ON ct.id=cr.compliance_type_id
    WHERE cr.contractor_id=v_exception.contractor_id AND cr.active AND cr.is_current AND ct.compliance_name='NJ PWC' FOR UPDATE OF cr;
    v_preview := public.get_nj_pwc_registry_match(p_exception_id);
    IF p_snapshot IS NULL OR v_preview->>'snapshot' IS DISTINCT FROM p_snapshot THEN
        RAISE EXCEPTION 'Registry comparison changed. Refresh and confirm the current values.' USING ERRCODE='55000';
    END IF;
    IF (v_preview->>'duplicate_target')::BOOLEAN THEN
        RAISE EXCEPTION 'Another contractor may be the same entity. Use manual contractor merge review.' USING ERRCODE='55000';
    END IF;
    IF NOT (v_preview->>'can_accept')::BOOLEAN THEN
        RAISE EXCEPTION 'No specific importable registry candidate is available.' USING ERRCODE='55000';
    END IF;
    v_candidate := v_preview->'candidate';
    v_old := v_preview->'current';
    v_new := v_old;
    FOREACH v_key IN ARRAY p_selected_fields LOOP
        v_value := nullif(btrim(v_candidate->>CASE v_key WHEN 'company_name' THEN 'business_name'
            WHEN 'address_1' THEN 'address' WHEN 'nj_pwc_number' THEN 'certificate_number' ELSE v_key END),'');
        IF v_value IS NULL THEN RAISE EXCEPTION 'Selected registry field % is unavailable.',v_key USING ERRCODE='22023'; END IF;
        v_new := jsonb_set(v_new,ARRAY[v_key],to_jsonb(v_value));
        IF v_old->>v_key IS DISTINCT FROM v_value THEN
            v_changes := v_changes || jsonb_build_object(v_key,jsonb_build_object('old',v_old->v_key,'new',v_value));
        END IF;
    END LOOP;
    v_defer_name := v_preview->'evidence'->>'confidence' <> 'High'
        AND v_preview->>'mode' = 'auto_approve';
    IF v_defer_name AND public.nj_pwc_normalize_name(v_old->>'company_name')
        IS NOT DISTINCT FROM public.nj_pwc_normalize_name(v_new->>'company_name') THEN
        RAISE EXCEPTION 'Contractor name changed since this Name Mismatch was recorded. Refresh the exception before accepting.' USING ERRCODE='55000';
    END IF;
    UPDATE public.contractors SET company_name=CASE WHEN v_defer_name THEN company_name ELSE v_new->>'company_name' END,
        address_1=v_new->>'address_1',
        city=v_new->>'city',state=v_new->>'state',zip_code=v_new->>'zip_code',
        county=v_new->>'county',nj_pwc_number=v_new->>'nj_pwc_number',updated_at=now()
    WHERE id=v_exception.contractor_id;
    -- Explicit user-selected import is deliberate live processing even when
    -- its source exception was produced by a Test Mode daily search.
    SELECT * INTO v_result FROM public.import_nj_pwc_candidate(
        (v_preview->>'search_request_id')::INTEGER,v_exception.contractor_id,
        v_candidate->>'certificate_number',p_actor_id,p_actor_name,p_actor_email);
    IF v_result.approval IS NULL OR v_result.record_action='already_imported' THEN
        RAISE EXCEPTION 'Registry candidate was already processed or returned no result.' USING ERRCODE='55000';
    END IF;
    IF v_defer_name AND v_result.approval <> 'review_required' THEN
        RAISE EXCEPTION 'Medium and Low Confidence registry matches must remain in Review Required.' USING ERRCODE='55000';
    END IF;
    IF v_defer_name THEN
        UPDATE public.contractors SET company_name=v_new->>'company_name',updated_at=now()
        WHERE id=v_exception.contractor_id;
    ELSIF NOT ('nj_pwc_number'=ANY(p_selected_fields)) AND v_preview->>'mode'='auto_approve' THEN
        -- The established auto-approval routine updates this field as part of
        -- its normal import. Preserve the exception workflow's explicit field selection.
        UPDATE public.contractors SET nj_pwc_number=v_old->>'nj_pwc_number',updated_at=now()
        WHERE id=v_exception.contractor_id;
    END IF;
    UPDATE public.nj_pwc_sync_exceptions SET status='resolved',resolved_by=left(p_actor_name,200),
        resolved_at=now(),resolution_note='Registry match explicitly accepted; contractor data corrected.',
        consecutive_failure_count=0,updated_at=now() WHERE id=p_exception_id;
    PERFORM public.nj_pwc_lock_state(v_exception.contractor_id,FALSE);
    UPDATE public.nj_pwc_sync_state SET consecutive_failure_count=0,pending_expiration_run_id=NULL,
        updated_at=now() WHERE contractor_id=v_exception.contractor_id AND (NOT is_test OR is_test=v_exception.is_test);
    IF v_exception.is_test THEN
        UPDATE public.nj_pwc_sync_state SET dry_run_action=NULL,dry_run_action_at=now()
        WHERE contractor_id=v_exception.contractor_id AND is_test;
    END IF;
    PERFORM public.nj_pwc_write_audit(p_actor_id,p_actor_name,p_actor_email,'NJ_PWC_REGISTRY_MATCH_ACCEPTED',
        'contractor',v_exception.contractor_id::TEXT,v_new->>'company_name',
        jsonb_build_object('contractor_id',v_exception.contractor_id,'exception_id',p_exception_id,
            'search_request_id',v_preview->'search_request_id','confidence',v_preview->'evidence'->'confidence',
            'evidence',v_preview->'evidence','old_contractor_name',v_old->>'company_name',
            'new_contractor_name',v_new->>'company_name','selected_fields',p_selected_fields,'changed_fields',v_changes,
            'certificate_number',v_candidate->>'certificate_number','approval',v_result.approval,
            'record_action',v_result.record_action,'review_queue_id',v_result.review_queue_id,
            'source_is_test',v_exception.is_test,'explicit_user_import',TRUE,'new_live_failure_count',0));
    RETURN jsonb_build_object('exception_id',p_exception_id,'contractor_id',v_exception.contractor_id,
        'company_name',v_new->>'company_name','approval',v_result.approval,'record_action',v_result.record_action,
        'review_queue_id',v_result.review_queue_id,'confidence',v_preview->'evidence'->>'confidence');
END $$;

REVOKE ALL ON FUNCTION public.nj_pwc_comparison_text(TEXT),public.nj_pwc_comparison_street(TEXT),
    public.nj_pwc_comparison_zip(TEXT),public.nj_pwc_registry_match_evidence(JSONB,TEXT[],JSONB,INTEGER,INTEGER),
    public.get_nj_pwc_registry_match(INTEGER),public.get_nj_pwc_registry_matches(INTEGER[]),
    public.accept_nj_pwc_registry_match(INTEGER,TEXT,TEXT[],BOOLEAN,UUID,TEXT,TEXT)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_nj_pwc_registry_match(INTEGER),public.get_nj_pwc_registry_matches(INTEGER[]),
    public.accept_nj_pwc_registry_match(INTEGER,TEXT,TEXT[],BOOLEAN,UUID,TEXT,TEXT) TO service_role;
COMMIT;
