-- Add first-class contractor DBA identity without changing existing records.
BEGIN;

ALTER TABLE public.contractors ADD COLUMN dba_name TEXT;
ALTER TABLE public.contractors ADD CONSTRAINT contractors_dba_name_length
    CHECK (dba_name IS NULL OR length(dba_name) <= 250);

CREATE FUNCTION public.normalize_contractor_dba_name() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    NEW.dba_name := nullif(btrim(NEW.dba_name), '');
    RETURN NEW;
END;
$$;
CREATE TRIGGER contractors_normalize_dba_name
    BEFORE INSERT OR UPDATE OF dba_name ON public.contractors
    FOR EACH ROW EXECUTE FUNCTION public.normalize_contractor_dba_name();

CREATE INDEX contractors_active_dba_name_key
    ON public.contractors (public.contractor_import_name_key(dba_name))
    WHERE active AND merged_into_contractor_id IS NULL AND dba_name IS NOT NULL;

CREATE FUNCTION public.search_contractors_by_identity(p_term TEXT,p_offset INTEGER,p_limit INTEGER)
RETURNS TABLE(id INTEGER,company_name TEXT,dba_name TEXT,city TEXT,state TEXT,active BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    WITH query AS (
        SELECT contractor_import_name_key(p_term) AS name_key,
            contractor_identity_name_variant_key(p_term) AS variant_key
    )
    SELECT c.id,c.company_name::TEXT,c.dba_name::TEXT,c.city::TEXT,c.state::TEXT,c.active
    FROM contractors c CROSS JOIN query q
    WHERE c.merged_into_contractor_id IS NULL
      AND (c.company_name ILIKE '%'||btrim(p_term)||'%'
        OR c.dba_name ILIKE '%'||btrim(p_term)||'%'
        OR contractor_import_name_key(c.company_name) LIKE '%'||q.name_key||'%'
        OR contractor_import_name_key(c.dba_name) LIKE '%'||q.name_key||'%'
        OR contractor_identity_name_variant_key(c.company_name) LIKE '%'||q.variant_key||'%'
        OR contractor_identity_name_variant_key(c.dba_name) LIKE '%'||q.variant_key||'%')
    ORDER BY c.active DESC,
        CASE WHEN contractor_import_name_key(c.company_name)=q.name_key
            OR contractor_import_name_key(c.dba_name)=q.name_key THEN 0 ELSE 1 END,
        lower(c.company_name),c.id
    LIMIT greatest(0,least(coalesce(p_limit,50),100)) OFFSET greatest(coalesce(p_offset,0),0);
$$;
CREATE FUNCTION public.contractor_search_candidates(p_term TEXT)
RETURNS TABLE(id INTEGER,company_name TEXT,dba_name TEXT,city TEXT,state TEXT,active BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT * FROM public.search_contractors_by_identity(p_term,0,12);
$$;
REVOKE ALL ON FUNCTION public.contractor_search_candidates(TEXT) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.search_contractors_by_identity(TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.contractor_search_candidates(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.search_contractors_by_identity(TEXT,INTEGER,INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.contractor_identity_fingerprint(p_candidate JSONB) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT md5(jsonb_build_object(
        'source',upper(coalesce(p_candidate->>'source','')),
        'company_name',contractor_import_name_key(p_candidate->>'company_name'),
        'dba_name',contractor_import_name_key(p_candidate->>'dba_name'),
        'nj_pwc_number',contractor_identity_pwc_key(p_candidate->>'nj_pwc_number'),
        'nj_brc_number',contractor_identity_brc_key(p_candidate->>'nj_brc_number'),
        'federal_tax_id',contractor_identity_fein_key(p_candidate->>'federal_tax_id'),
        'phone',contractor_identity_phone_key(p_candidate->>'phone'),
        'address',contractor_identity_address_key(p_candidate->>'address_1',p_candidate->>'zip_code'),
        'external_id',lower(btrim(coalesce(p_candidate->>'external_id',''))),
        'procore_vendor_key',lower(btrim(coalesce(p_candidate->>'procore_vendor_key',''))),
        'mycoi_vendor_name',lower(btrim(coalesce(p_candidate->>'mycoi_vendor_name',''))))::text);
$$;

CREATE OR REPLACE FUNCTION public.contractor_identity_candidate_summary(p_candidate JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object(
        'source',upper(nullif(p_candidate->>'source','')),
        'company_name',nullif(btrim(p_candidate->>'company_name'),''),
        'dba_name',nullif(btrim(p_candidate->>'dba_name'),''),
        'nj_pwc_number',nullif(btrim(p_candidate->>'nj_pwc_number'),''),
        'nj_brc_number',nullif(btrim(p_candidate->>'nj_brc_number'),''),
        'phone',nullif(btrim(p_candidate->>'phone'),''),
        'address_1',nullif(btrim(p_candidate->>'address_1'),''),
        'city',nullif(btrim(p_candidate->>'city'),''),
        'state',nullif(btrim(p_candidate->>'state'),''),
        'zip_code',nullif(btrim(p_candidate->>'zip_code'),''),
        'external_id',nullif(btrim(p_candidate->>'external_id'),''),
        'has_federal_tax_id',CASE WHEN contractor_identity_fein_key(p_candidate->>'federal_tax_id') IS NOT NULL THEN true END));
$$;

CREATE OR REPLACE FUNCTION public.contractor_identity_match_batch(p_candidates JSONB)
RETURNS TABLE(
    candidate_key TEXT, contractor_id INTEGER, company_name TEXT, active BOOLEAN,
    nj_pwc_number TEXT, phone TEXT, address_1 TEXT, city TEXT, state TEXT, zip_code TEXT,
    signals TEXT[], via_merged_contractor_ids INTEGER[],
    match_class TEXT, disposition TEXT, match_rank INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH RECURSIVE lineage(id,terminal,depth) AS (
    SELECT c.id,c.id,0 FROM contractors c WHERE c.merged_into_contractor_id IS NULL
    UNION ALL
    SELECT p.id,l.terminal,l.depth+1 FROM contractors p JOIN lineage l ON p.merged_into_contractor_id=l.id
    WHERE l.depth<50
),
cand AS MATERIALIZED (
    SELECT coalesce(nullif(e.c->>'candidate_key',''),e.ord::text) AS ckey,
        CASE WHEN e.c->>'exclude_contractor_id' ~ '^[0-9]+$' THEN (e.c->>'exclude_contractor_id')::integer END AS exclude_id,
        contractor_import_name_key(nullif(btrim(e.c->>'company_name'),'')) AS name_key,
        contractor_identity_name_variant_key(e.c->>'company_name') AS variant_key,
        contractor_import_name_key(nullif(btrim(e.c->>'dba_name'),'')) AS dba_key,
        contractor_identity_name_variant_key(e.c->>'dba_name') AS dba_variant_key,
        contractor_identity_pwc_key(e.c->>'nj_pwc_number') AS pwc_key,
        contractor_identity_phone_key(e.c->>'phone') AS phone_key,
        contractor_identity_address_key(e.c->>'address_1',e.c->>'zip_code') AS address_key,
        contractor_identity_fein_key(e.c->>'federal_tax_id') AS fein_key,
        contractor_identity_brc_key(e.c->>'nj_brc_number') AS brc_key,
        lower(btrim(nullif(e.c->>'external_id',''))) AS external_key,
        CASE WHEN upper(coalesce(e.c->>'source',''))='PROCORE' THEN coalesce(nullif(e.c->>'procore_vendor_key',''),
            contractor_import_name_key(nullif(btrim(e.c->>'company_name'),''))) END AS procore_key,
        CASE WHEN upper(coalesce(e.c->>'source',''))='MYCOI' THEN lower(btrim(nullif(coalesce(
            e.c->>'mycoi_vendor_name',e.c->>'company_name'),''))) END AS mycoi_key
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_candidates)='array' THEN p_candidates ELSE '[]'::jsonb END)
        WITH ORDINALITY e(c,ord)
),
existing AS MATERIALIZED (
    SELECT c.id,l.terminal,
        contractor_import_name_key(c.company_name) AS name_key,
        contractor_identity_name_variant_key(c.company_name) AS variant_key,
        contractor_import_name_key(c.dba_name) AS dba_key,
        contractor_identity_name_variant_key(c.dba_name) AS dba_variant_key,
        contractor_identity_pwc_key(c.nj_pwc_number) AS pwc_key,
        contractor_identity_phone_key(c.phone) AS phone_key,
        contractor_identity_address_key(c.address_1,c.zip_code) AS address_key,
        contractor_identity_fein_key(c.federal_tax_id) AS fein_key,
        contractor_identity_brc_key(c.nj_brc_number) AS brc_key,
        lower(btrim(nullif(c.external_id,''))) AS external_key
    FROM contractors c JOIN lineage l ON l.id=c.id
),
cand_keys AS MATERIALIZED (
    SELECT cd.ckey,cd.exclude_id,k.signal,k.val
    FROM cand cd CROSS JOIN LATERAL (VALUES
        ('external_id',cd.external_key),('pwc',cd.pwc_key),('exact_name',cd.name_key),
        ('legal_name_exact',cd.name_key),('name_variant',cd.variant_key),('legal_name_variant',cd.variant_key),
        ('dba_exact',cd.name_key),('dba_variant',cd.variant_key),
        ('candidate_dba_matches_legal_name',cd.dba_key),
        ('candidate_dba_matches_existing_dba',cd.dba_key),
        ('candidate_dba_variant_matches_legal_name',cd.dba_variant_key),
        ('candidate_dba_variant_matches_existing_dba',cd.dba_variant_key),
        ('fein',cd.fein_key),('nj_brc',cd.brc_key),('phone',cd.phone_key),('address',cd.address_key)) k(signal,val)
    WHERE coalesce(k.val,'')<>''
),
existing_keys AS MATERIALIZED (
    SELECT ex.id,ex.terminal,k.signal,k.val
    FROM existing ex CROSS JOIN LATERAL (VALUES
        ('external_id',ex.external_key),('pwc',ex.pwc_key),('exact_name',ex.name_key),
        ('legal_name_exact',ex.name_key),('name_variant',ex.variant_key),('legal_name_variant',ex.variant_key),
        ('dba_exact',ex.dba_key),('dba_variant',ex.dba_variant_key),
        ('candidate_dba_matches_legal_name',ex.name_key),
        ('candidate_dba_matches_existing_dba',ex.dba_key),
        ('candidate_dba_variant_matches_legal_name',ex.variant_key),
        ('candidate_dba_variant_matches_existing_dba',ex.dba_variant_key),
        ('fein',ex.fein_key),('nj_brc',ex.brc_key),('phone',ex.phone_key),('address',ex.address_key)) k(signal,val)
    WHERE coalesce(k.val,'')<>''
),
hits AS (
    SELECT ck.ckey,ek.terminal,ek.id AS source_id,ck.signal
    FROM cand_keys ck JOIN existing_keys ek ON ek.signal=ck.signal AND ek.val=ck.val
    WHERE ek.terminal IS DISTINCT FROM ck.exclude_id AND ek.id IS DISTINCT FROM ck.exclude_id
    UNION ALL
    SELECT cd.ckey,l.terminal,m.contractor_id,'procore_binding'
    FROM cand cd JOIN procore_vendor_mappings m ON m.vendor_key=cd.procore_key
    JOIN lineage l ON l.id=m.contractor_id
    WHERE l.terminal IS DISTINCT FROM cd.exclude_id AND m.contractor_id IS DISTINCT FROM cd.exclude_id
    UNION ALL
    SELECT cd.ckey,l.terminal,m.contractor_id,'mycoi_binding'
    FROM cand cd JOIN mycoi_vendor_mappings m ON m.active AND m.vendor_name_key=cd.mycoi_key
    JOIN lineage l ON l.id=m.contractor_id
    WHERE l.terminal IS DISTINCT FROM cd.exclude_id AND m.contractor_id IS DISTINCT FROM cd.exclude_id
),
agg AS (
    SELECT h.ckey,h.terminal,array_agg(DISTINCT h.signal ORDER BY h.signal) AS sigs,
        coalesce(array_agg(DISTINCT h.source_id ORDER BY h.source_id) FILTER (WHERE h.source_id<>h.terminal),
            ARRAY[]::INTEGER[]) AS via,
        bool_or(h.signal='pwc' AND h.source_id=h.terminal) AS direct_pwc
    FROM hits h GROUP BY h.ckey,h.terminal
),
classified AS (
    SELECT a.*,c.company_name::TEXT AS cname,c.active AS cactive,
        CASE WHEN a.sigs && ARRAY['exact_name','legal_name_exact','dba_exact',
                'candidate_dba_matches_legal_name','candidate_dba_matches_existing_dba']
            THEN array_remove(array_remove(array_remove(array_remove(array_remove(a.sigs,'name_variant'),'dba_variant'),
                'legal_name_variant'),
                'candidate_dba_variant_matches_legal_name'),'candidate_dba_variant_matches_existing_dba')
            ELSE a.sigs END AS final_sigs,
        CASE
            WHEN a.sigs && ARRAY['procore_binding','mycoi_binding','external_id'] THEN 'source_binding'
            WHEN a.direct_pwc AND c.active THEN 'pwc'
            WHEN 'pwc'=ANY(a.sigs) THEN 'pwc_review'
            WHEN a.sigs && ARRAY['exact_name','legal_name_exact','dba_exact',
                'candidate_dba_matches_legal_name','candidate_dba_matches_existing_dba'] THEN 'exact_name'
            WHEN a.sigs && ARRAY['fein','nj_brc'] THEN 'high_confidence'
            WHEN (a.sigs && ARRAY['name_variant','dba_variant','legal_name_variant',
                'candidate_dba_variant_matches_legal_name','candidate_dba_variant_matches_existing_dba'])
                AND a.sigs && ARRAY['phone','address'] THEN 'strong_possible'
            WHEN a.sigs && ARRAY['name_variant','dba_variant','legal_name_variant',
                'candidate_dba_variant_matches_legal_name','candidate_dba_variant_matches_existing_dba'] THEN 'possible'
            ELSE 'informational'
        END AS mclass
    FROM agg a JOIN contractors c ON c.id=a.terminal
)
SELECT k.ckey,k.terminal,k.cname,k.cactive,c.nj_pwc_number::TEXT,c.phone::TEXT,c.address_1,
    c.city::TEXT,c.state::TEXT,c.zip_code::TEXT,k.final_sigs,k.via,k.mclass,
    CASE k.mclass WHEN 'source_binding' THEN 'use_existing' WHEN 'pwc' THEN 'hard_block'
        WHEN 'informational' THEN 'informational' ELSE 'review_required' END,
    CASE k.mclass WHEN 'source_binding' THEN 1 WHEN 'pwc' THEN 2 WHEN 'pwc_review' THEN 3
        WHEN 'exact_name' THEN 4 WHEN 'high_confidence' THEN 5 WHEN 'strong_possible' THEN 6
        WHEN 'possible' THEN 7 ELSE 8 END
FROM classified k JOIN contractors c ON c.id=k.terminal
ORDER BY 1,15,2;
$$;

-- A registry DBA match is identity evidence, never automatic proof of certificate ownership.
DO $$
DECLARE definition TEXT; changed TEXT; old_fragment TEXT; old_pattern TEXT; new_fragment TEXT;
    signature REGPROCEDURE; match_count INTEGER;
BEGIN
    signature:=to_regprocedure('public.nj_pwc_registry_match_evidence(jsonb,text[],jsonb,integer,integer)');
    IF signature IS NOT NULL THEN
        SELECT replace(pg_get_functiondef(signature),E'\r\n',E'\n') INTO definition;
        old_pattern:=$pattern$'name_match'\s*,\s*coalesce\s*\(\s*public\.nj_pwc_comparison_text\(p_contractor->>'company_name'\)\s*=\s*public\.nj_pwc_comparison_text\(p_candidate->>'business_name'\)\s*,\s*FALSE\s*\)$pattern$;
        new_fragment:=replace($new$'name_match',coalesce(public.nj_pwc_comparison_text(p_contractor->>'company_name') =
                public.nj_pwc_comparison_text(p_candidate->>'business_name')
                OR public.nj_pwc_comparison_text(p_contractor->>'dba_name') =
                    public.nj_pwc_comparison_text(p_candidate->>'business_name'),FALSE),
            'name_match_signal',CASE
                WHEN public.nj_pwc_comparison_text(p_contractor->>'company_name') =
                    public.nj_pwc_comparison_text(p_candidate->>'business_name') THEN 'legal_name'
                WHEN public.nj_pwc_comparison_text(p_contractor->>'dba_name') =
                    public.nj_pwc_comparison_text(p_candidate->>'business_name') THEN 'dba'
            END$new$,E'\r\n',E'\n');
        SELECT count(*) INTO match_count FROM regexp_matches(definition,old_pattern,'g');
        IF match_count<>1 THEN
            RAISE EXCEPTION 'NJ PWC identity evidence function expected one legal-name match expression; found %.',match_count;
        END IF;
        changed:=regexp_replace(definition,old_pattern,new_fragment);
        IF changed=definition THEN RAISE EXCEPTION 'NJ PWC identity evidence function differs from its verified extension point.'; END IF;
        EXECUTE changed;
    ELSE
        RAISE EXCEPTION 'Required NJ PWC identity evidence function is not installed.';
    END IF;

    signature:=to_regprocedure('public.get_nj_pwc_registry_match(integer)');
    IF signature IS NOT NULL THEN
        SELECT pg_get_functiondef(signature) INTO definition;
        old_fragment:=$old$v_current := jsonb_build_object('company_name',v_contractor.company_name,'address_1',v_contractor.address_1,$old$;
        IF length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) THEN
            RAISE EXCEPTION 'NJ PWC current-company snapshot extension point is missing or ambiguous.';
        END IF;
        changed:=replace(definition,
            old_fragment,
            $new$v_current := jsonb_build_object('company_name',v_contractor.company_name,'dba_name',v_contractor.dba_name,
        'address_1',v_contractor.address_1,$new$);
        IF changed=definition THEN RAISE EXCEPTION 'NJ PWC current-company snapshot differs from its verified extension point.'; END IF;
        definition:=changed;
        old_fragment:=$old$public.nj_pwc_normalize_name(c.company_name)=public.nj_pwc_normalize_name(v_candidate->>'business_name')$old$;
        IF length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) THEN
            RAISE EXCEPTION 'NJ PWC duplicate-ownership extension point is missing or ambiguous.';
        END IF;
        changed:=replace(definition,old_fragment,
            $new$(public.nj_pwc_normalize_name(c.company_name)=public.nj_pwc_normalize_name(v_candidate->>'business_name')
                OR public.nj_pwc_normalize_name(c.dba_name)=public.nj_pwc_normalize_name(v_candidate->>'business_name'))$new$);
        IF changed=definition THEN RAISE EXCEPTION 'NJ PWC duplicate-ownership check differs from its verified extension point.'; END IF;
        EXECUTE changed;
    ELSE
        RAISE EXCEPTION 'Required NJ PWC registry-match function is not installed.';
    END IF;
END $$;

-- A stale myCOI import plan cannot bypass the UI's DBA duplicate check.
DO $$
DECLARE definition TEXT; changed TEXT; old_fragment TEXT; signature REGPROCEDURE;
BEGIN
    signature:=to_regprocedure('public.mycoi_apply_import(uuid,integer,text,jsonb,jsonb,uuid,jsonb)');
    IF signature IS NOT NULL THEN
        SELECT pg_get_functiondef(signature) INTO definition;
        old_fragment:=$old$result := mycoi_apply_import_transaction(p_run,p_revision,p_token,p_plan,p_audits,p_actor,p_snapshot);$old$;
        IF length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) THEN
            RAISE EXCEPTION 'MyCOI apply wrapper extension point is missing or ambiguous.';
        END IF;
        changed:=replace(definition,old_fragment,
            $new$FOR vendor IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
        IF coalesce((vendor->>'createContractor')::BOOLEAN,FALSE) THEN
            PERFORM contractor_identity_assert_creatable(jsonb_build_object(
                'source','MYCOI','company_name',coalesce(vendor->>'raw',vendor->>'company_name'),
                'mycoi_vendor_name',coalesce(vendor->>'raw',vendor->>'company_name')),NULL);
        END IF;
    END LOOP;
    result := mycoi_apply_import_transaction(p_run,p_revision,p_token,p_plan,p_audits,p_actor,p_snapshot);$new$);
        IF changed=definition THEN
            RAISE EXCEPTION 'MyCOI apply wrapper differs from its verified extension point.';
        ELSE
            EXECUTE changed;
        END IF;
    ELSE
        RAISE EXCEPTION 'Required MyCOI apply wrapper is not installed.';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.company_merge_fields() RETURNS TEXT[]
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT ARRAY['company_name','dba_name','trade','contact_name','email','phone','address_1','address_2',
        'city','state','zip_code','county','federal_tax_id','sage_erp_id','external_id','legacy_id',
        'notes','material_vendor_only','brc_name_control','brc_name_control_is_manual',
        'nj_pwc_number','nj_brc_number','ny_pwc_number','ny_brc_number','active']::TEXT[];
$$;

-- Keep both integration reference shapes stable while exposing the DBA to preview logic.
CREATE OR REPLACE FUNCTION public.company_merge_filter_reference(p_reference JSONB) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result JSONB:=p_reference; field TEXT; data JSONB;
BEGIN
    FOREACH field IN ARRAY ARRAY['contractors','vendors','contacts'] LOOP
        IF jsonb_typeof(result->field)='array' THEN
            SELECT coalesce(jsonb_agg(
                CASE WHEN field='contractors' THEN v||jsonb_build_object('dba_name',c.dba_name) ELSE v END
                ORDER BY v::text),'[]') INTO data
            FROM jsonb_array_elements(result->field) v
            LEFT JOIN contractors c ON field='contractors' AND c.id=(v->>'id')::integer
            WHERE NOT EXISTS(SELECT 1 FROM contractors archived WHERE archived.merged_into_contractor_id IS NOT NULL
                AND archived.id=CASE WHEN field='contractors' THEN (v->>'id')::integer ELSE (v->>'contractor_id')::integer END);
            result:=jsonb_set(result,ARRAY[field],data);
        END IF;
    END LOOP;
    RETURN jsonb_set(result,'{token}',to_jsonb(md5((result-'token')::text)));
END;
$$;

CREATE OR REPLACE FUNCTION public.mycoi_import_reference() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    WITH state AS (
        SELECT jsonb_build_object(
            'contractors', COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY to_jsonb(c)::text) FROM
                (SELECT id,company_name,dba_name,active FROM contractors WHERE merged_into_contractor_id IS NULL) c), '[]'::jsonb),
            'projects', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM
                (SELECT id,project_number,project_name FROM projects) p), '[]'::jsonb),
            'vendors', COALESCE((SELECT jsonb_agg(to_jsonb(v) ORDER BY to_jsonb(v)::text) FROM mycoi_vendor_mappings v
                WHERE NOT EXISTS (SELECT 1 FROM contractors c WHERE c.merged_into_contractor_id IS NOT NULL
                    AND c.id=v.contractor_id)), '[]'::jsonb),
            'divisions', COALESCE((SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM mycoi_division_mappings d), '[]'::jsonb),
            'statuses', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM mycoi_contractor_divisions s), '[]'::jsonb),
            'policies', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM mycoi_policies p), '[]'::jsonb),
            'links', COALESCE((SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM mycoi_policy_divisions l), '[]'::jsonb)
        ) AS value
    )
    SELECT value || jsonb_build_object('token', md5(value::text)) FROM state;
$$;

DO $$
DECLARE definition TEXT; changed TEXT; columns_fragment TEXT; values_fragment TEXT;
BEGIN
    SELECT pg_get_functiondef('public.company_merge_execute(integer,integer,text,jsonb,jsonb,uuid,uuid,boolean,uuid)'::regprocedure)
      INTO definition;
    columns_fragment:='INSERT INTO contractors(company_name,trade';
    values_fragment:='VALUES(value_record.company_name,value_record.trade';
    IF length(definition)-length(replace(definition,columns_fragment,''))<>length(columns_fragment)
        OR length(definition)-length(replace(definition,values_fragment,''))<>length(values_fragment) THEN
        RAISE EXCEPTION 'Company Merge successor insert extension points are missing or ambiguous.';
    END IF;
    changed:=replace(definition,columns_fragment,
        'INSERT INTO contractors(company_name,dba_name,trade');
    changed:=replace(changed,values_fragment,
        'VALUES(value_record.company_name,value_record.dba_name,value_record.trade');
    IF changed=definition THEN RAISE EXCEPTION 'Could not safely extend Company Merge successor creation with DBA.'; END IF;
    EXECUTE changed;
END $$;

REVOKE ALL ON FUNCTION public.normalize_contractor_dba_name() FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
