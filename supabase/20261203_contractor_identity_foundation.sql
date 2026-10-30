-- Contractor identity foundation (duplicate prevention, Phase 1).
--
-- Additive only. This migration creates new tables and functions; it does not
-- replace any existing function, add any trigger, or modify any existing row.
-- No current workflow calls these objects until later phases are deployed.
--
-- Matching hierarchy (deterministic; nothing here merges or updates contractors):
--   use_existing     existing Procore/myCOI vendor binding or exact External ID
--   hard_block       exact NJ PWC number held by another active, non-merged contractor
--   review_required  NJ PWC held by an inactive contractor / merged predecessor,
--                    exact normalized name, FEIN or NJ BRC match,
--                    deterministic name variant (+ phone/address = strong_possible)
--   informational    phone and/or address only; displayed but never blocks creation
--
-- The new tables intentionally have no foreign key to contractors so that
-- company_merge_preview's dependency catalogue is unaffected.
BEGIN;

CREATE TABLE public.contractor_name_token_aliases (
    token TEXT PRIMARY KEY CHECK (token ~ '^[a-z0-9]+$'),
    replacement TEXT NOT NULL CHECK (replacement ~ '^[a-z0-9]+( [a-z0-9]+)*$' AND replacement<>token),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.contractor_name_token_aliases(token,replacement) VALUES
    ('mfg','manufacturing'),('mfr','manufacturing'),('mfrs','manufacturers'),
    ('const','construction'),('constr','construction'),('constn','construction'),
    ('bldg','building'),('bldgs','buildings'),('bldrs','builders'),
    ('nj','new jersey'),('ny','new york'),
    ('bros','brothers'),('mech','mechanical'),('intl','international'),
    ('assoc','associates'),('assocs','associates'),
    ('svc','service'),('svcs','services'),('elec','electric'),('sys','systems'),
    ('ent','enterprises'),('ents','enterprises'),('enterp','enterprises'),
    ('mgmt','management'),('plbg','plumbing'),('htg','heating'),('mtl','metal'),('genl','general'),
    ('corportation','corporation'),('specialities','specialties'),('speciality','specialty');

CREATE TABLE public.contractor_identity_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source TEXT NOT NULL CHECK (source IN ('PROCORE','SPREADSHEET','MANUAL','MYCOI','NJ_PWC')),
    source_reference TEXT,
    candidate_fingerprint TEXT NOT NULL,
    candidate_summary JSONB NOT NULL,
    reviewed_contractor_ids INTEGER[] NOT NULL CHECK (cardinality(reviewed_contractor_ids)>0),
    decision TEXT NOT NULL CHECK (decision='create_separate'),
    reason TEXT NOT NULL CHECK (length(btrim(reason)) BETWEEN 3 AND 1000),
    decided_by UUID NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at TIMESTAMPTZ,
    consumed_contractor_id INTEGER,
    CHECK ((consumed_at IS NULL)=(consumed_contractor_id IS NULL))
);

CREATE TABLE public.contractor_identity_conflicts (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    conflict_type TEXT NOT NULL CHECK (conflict_type IN ('PWC_ASSIGNMENT','CREATION')),
    source TEXT NOT NULL CHECK (length(btrim(source)) BETWEEN 1 AND 100),
    source_reference TEXT,
    pwc_key TEXT,
    attempted_contractor_id INTEGER,
    existing_contractor_ids INTEGER[] NOT NULL CHECK (cardinality(existing_contractor_ids)>0),
    candidate_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
    detected_by UUID,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dismissed_at TIMESTAMPTZ,
    dismissed_by UUID,
    dismissal_reason TEXT,
    CHECK (conflict_type<>'PWC_ASSIGNMENT' OR (pwc_key IS NOT NULL AND attempted_contractor_id IS NOT NULL)),
    CHECK ((dismissed_at IS NULL)=(dismissed_by IS NULL) AND (dismissed_at IS NULL)=(dismissal_reason IS NULL))
);
CREATE INDEX contractor_identity_conflicts_open ON public.contractor_identity_conflicts(detected_at DESC)
    WHERE dismissed_at IS NULL;

ALTER TABLE public.contractor_name_token_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_identity_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contractor_identity_conflicts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contractor_name_token_aliases,public.contractor_identity_decisions,
    public.contractor_identity_conflicts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.contractor_name_token_aliases,public.contractor_identity_decisions,
    public.contractor_identity_conflicts TO service_role;

-- ---------------------------------------------------------------------------
-- Normalizers
-- ---------------------------------------------------------------------------

-- Same rule as normalizeNjPwcNumberForMatch (letters and digits only, uppercase).
CREATE FUNCTION public.contractor_identity_pwc_key(p_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT nullif(upper(regexp_replace(coalesce(p_value,''),'[^[:alnum:]]','','g')),'');
$$;

CREATE FUNCTION public.contractor_identity_fein_key(p_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT CASE WHEN d ~ '^[0-9]{9}$' AND d !~ '^(.)\1{8}$' AND d<>'123456789' THEN d END
    FROM (SELECT regexp_replace(coalesce(p_value,''),'[^0-9]','','g') d) x;
$$;

CREATE FUNCTION public.contractor_identity_brc_key(p_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT CASE WHEN length(v)>=4 AND v !~ '^0+$' THEN v END
    FROM (SELECT upper(regexp_replace(coalesce(p_value,''),'[^[:alnum:]]','','g')) v) x;
$$;

-- Ten-digit NANP number; extensions are ignored. Multiple numbers in one field yield NULL.
CREATE FUNCTION public.contractor_identity_phone_key(p_value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT CASE WHEN n ~ '^[2-9][0-9]{9}$' AND n !~ '^(.)\1{9}$' THEN n END
    FROM (SELECT CASE WHEN d ~ '^1[0-9]{10}$' THEN right(d,10) ELSE d END n
          FROM (SELECT regexp_replace(regexp_replace(lower(coalesce(p_value,'')),
                    '\s*(x|ext|extension)\.?\s*[0-9]+\s*$',''),'[^0-9]','','g') d) a) b;
$$;

-- Street line (without suite/unit/floor detail) plus five-digit ZIP; NULL unless both exist.
CREATE FUNCTION public.contractor_identity_address_key(p_address_1 TEXT,p_zip_code TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE
    zip TEXT := regexp_replace(split_part(btrim(coalesce(p_zip_code,'')),'-',1),'[^0-9]','','g');
    street TEXT;
    tokens TEXT[];
BEGIN
    IF length(zip)=4 THEN zip:='0'||zip; ELSIF length(zip)=9 THEN zip:=left(zip,5); END IF;
    IF zip !~ '^[0-9]{5}$' OR zip='00000' THEN RETURN NULL; END IF;
    street := lower(coalesce(p_address_1,''));
    street := regexp_replace(street,'\m(p\s*\.?\s*o\s*\.?|post\s+office)\s*box\M','po box','g');
    street := regexp_replace(street,'\s*(#\s*[[:alnum:]-]+|\m(suite|ste|unit|apt|apartment|fl|flr|floor|rm|room)\M\.?\s*#?\s*([[:alnum:]-]*[0-9][[:alnum:]-]*|[a-z]\M)).*$','');
    street := regexp_replace(street,'\s*\m[0-9]+(st|nd|rd|th)\s+(fl|flr|floor)\M.*$','');
    street := regexp_replace(street,'[.'']','','g');
    street := btrim(regexp_replace(regexp_replace(street,'[^[:alnum:][:space:]]',' ','g'),'[[:space:]]+',' ','g'));
    IF street !~ '[0-9]' THEN RETURN NULL; END IF;
    SELECT array_agg(CASE t
        WHEN 'street' THEN 'st' WHEN 'avenue' THEN 'ave' WHEN 'av' THEN 'ave' WHEN 'road' THEN 'rd'
        WHEN 'drive' THEN 'dr' WHEN 'boulevard' THEN 'blvd' WHEN 'lane' THEN 'ln' WHEN 'highway' THEN 'hwy'
        WHEN 'route' THEN 'rte' WHEN 'rt' THEN 'rte' WHEN 'place' THEN 'pl' WHEN 'court' THEN 'ct'
        WHEN 'parkway' THEN 'pkwy' WHEN 'turnpike' THEN 'tpke' WHEN 'terrace' THEN 'ter'
        WHEN 'circle' THEN 'cir' WHEN 'square' THEN 'sq' WHEN 'plaza' THEN 'plz' WHEN 'mount' THEN 'mt'
        WHEN 'north' THEN 'n' WHEN 'south' THEN 's' WHEN 'east' THEN 'e' WHEN 'west' THEN 'w'
        ELSE t END ORDER BY o) INTO tokens
    FROM unnest(string_to_array(street,' ')) WITH ORDINALITY u(t,o);
    RETURN array_to_string(tokens,' ')||' '||zip;
END;
$$;

-- Deterministic company-name variant. Extends contractor_import_name_key; never similarity-based.
CREATE FUNCTION public.contractor_identity_name_variant_key(p_value TEXT) RETURNS TEXT
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    base TEXT;
    t TEXT;
    mapped TEXT;
    words TEXT[] := ARRAY[]::TEXT[];
    suffixes CONSTANT TEXT[] := ARRAY['llc','inc','incorporated','corp','corporation','co','company','ltd','lp','llp','pc'];
BEGIN
    base := contractor_import_name_key(regexp_replace(coalesce(p_value,''),'\([^)]*\)',' ','g'));
    IF base IS NULL OR base='' THEN RETURN NULL; END IF;
    FOREACH t IN ARRAY string_to_array(base,' ') LOOP
        SELECT a.replacement INTO mapped FROM contractor_name_token_aliases a WHERE a.token=t;
        words := words||string_to_array(coalesce(mapped,t),' ');
    END LOOP;
    IF cardinality(words)>1 AND words[1]='the' THEN words := words[2:]; END IF;
    IF cardinality(array_remove(words,'and'))>0 THEN words := array_remove(words,'and'); END IF;
    WHILE cardinality(words)>1 AND words[cardinality(words)]=ANY(suffixes) LOOP
        words := words[1:cardinality(words)-1];
    END LOOP;
    SELECT array_agg(CASE
        WHEN w ~ '^[a-z]{2,}ies$' THEN left(w,-3)||'y'
        WHEN w ~ '^[a-z]{3,}s$' AND w !~ '(ss|us|is)$' THEN left(w,-1)
        ELSE w END ORDER BY o) INTO words
    FROM unnest(words) WITH ORDINALITY u(w,o);
    RETURN nullif(array_to_string(words,' '),'');
END;
$$;

-- Stable, non-sensitive fingerprint of the identity fields a review decision covered.
-- FEIN is intentionally excluded; FEIN-driven matches are covered by reviewed_contractor_ids.
CREATE FUNCTION public.contractor_identity_fingerprint(p_candidate JSONB) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT md5(jsonb_build_array(
        upper(coalesce(p_candidate->>'source','')),
        contractor_import_name_key(nullif(btrim(p_candidate->>'company_name'),'')),
        contractor_identity_name_variant_key(p_candidate->>'company_name'),
        contractor_identity_pwc_key(p_candidate->>'nj_pwc_number'),
        contractor_identity_phone_key(p_candidate->>'phone'),
        contractor_identity_address_key(p_candidate->>'address_1',p_candidate->>'zip_code'),
        contractor_identity_brc_key(p_candidate->>'nj_brc_number'),
        lower(btrim(nullif(p_candidate->>'external_id','')))
    )::text);
$$;

CREATE FUNCTION public.contractor_identity_candidate_summary(p_candidate JSONB) RETURNS JSONB
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object(
        'source',upper(nullif(p_candidate->>'source','')),
        'company_name',nullif(btrim(p_candidate->>'company_name'),''),
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

-- ---------------------------------------------------------------------------
-- Matcher: the single definition of "existing contractor identity".
-- p_candidates: JSON array of candidate objects. Recognised keys:
--   candidate_key, exclude_contractor_id, source (PROCORE|MYCOI|SPREADSHEET|MANUAL|NJ_PWC),
--   company_name, nj_pwc_number, nj_brc_number, federal_tax_id, phone,
--   address_1, city, state, zip_code, external_id, procore_vendor_key, mycoi_vendor_name
-- Merged predecessors are never returned; their matches are attributed to the final successor.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.contractor_identity_match_batch(p_candidates JSONB)
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
        contractor_identity_pwc_key(c.nj_pwc_number) AS pwc_key,
        contractor_identity_phone_key(c.phone) AS phone_key,
        contractor_identity_address_key(c.address_1,c.zip_code) AS address_key,
        contractor_identity_fein_key(c.federal_tax_id) AS fein_key,
        contractor_identity_brc_key(c.nj_brc_number) AS brc_key,
        lower(btrim(nullif(c.external_id,''))) AS external_key
    FROM contractors c JOIN lineage l ON l.id=c.id
),
-- Keys are computed once per call and compared by equality (hash-joinable), never pairwise.
cand_keys AS MATERIALIZED (
    SELECT cd.ckey,cd.exclude_id,k.signal,k.val
    FROM cand cd CROSS JOIN LATERAL (VALUES
        ('external_id',cd.external_key),('pwc',cd.pwc_key),('exact_name',cd.name_key),
        ('name_variant',cd.variant_key),('fein',cd.fein_key),('nj_brc',cd.brc_key),
        ('phone',cd.phone_key),('address',cd.address_key)) k(signal,val)
    WHERE coalesce(k.val,'')<>''
),
existing_keys AS MATERIALIZED (
    SELECT ex.id,ex.terminal,k.signal,k.val
    FROM existing ex CROSS JOIN LATERAL (VALUES
        ('external_id',ex.external_key),('pwc',ex.pwc_key),('exact_name',ex.name_key),
        ('name_variant',ex.variant_key),('fein',ex.fein_key),('nj_brc',ex.brc_key),
        ('phone',ex.phone_key),('address',ex.address_key)) k(signal,val)
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
    SELECT h.ckey,h.terminal,
        array_agg(DISTINCT h.signal ORDER BY h.signal) AS sigs,
        coalesce(array_agg(DISTINCT h.source_id ORDER BY h.source_id) FILTER (WHERE h.source_id<>h.terminal),
            ARRAY[]::INTEGER[]) AS via,
        bool_or(h.signal='pwc' AND h.source_id=h.terminal) AS direct_pwc
    FROM hits h GROUP BY h.ckey,h.terminal
),
classified AS (
    SELECT a.*,c.company_name::TEXT AS cname,c.active AS cactive,
        CASE WHEN 'exact_name'=ANY(a.sigs) THEN array_remove(a.sigs,'name_variant') ELSE a.sigs END AS final_sigs,
        CASE
            WHEN a.sigs && ARRAY['procore_binding','mycoi_binding','external_id'] THEN 'source_binding'
            WHEN a.direct_pwc AND c.active THEN 'pwc'
            WHEN 'pwc'=ANY(a.sigs) THEN 'pwc_review'
            WHEN 'exact_name'=ANY(a.sigs) THEN 'exact_name'
            WHEN a.sigs && ARRAY['fein','nj_brc'] THEN 'high_confidence'
            WHEN 'name_variant'=ANY(a.sigs) AND a.sigs && ARRAY['phone','address'] THEN 'strong_possible'
            WHEN 'name_variant'=ANY(a.sigs) THEN 'possible'
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

CREATE FUNCTION public.contractor_identity_matches(p_candidate JSONB,p_exclude_contractor_id INTEGER DEFAULT NULL)
RETURNS TABLE(
    candidate_key TEXT, contractor_id INTEGER, company_name TEXT, active BOOLEAN,
    nj_pwc_number TEXT, phone TEXT, address_1 TEXT, city TEXT, state TEXT, zip_code TEXT,
    signals TEXT[], via_merged_contractor_ids INTEGER[],
    match_class TEXT, disposition TEXT, match_rank INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT * FROM contractor_identity_match_batch(jsonb_build_array(
        coalesce(p_candidate,'{}'::jsonb)||jsonb_build_object('candidate_key','candidate',
            'exclude_contractor_id',p_exclude_contractor_id)))
    ORDER BY match_rank,contractor_id;
$$;

CREATE FUNCTION public.contractor_identity_matches_json(p_candidate JSONB,p_exclude_contractor_id INTEGER DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT coalesce(jsonb_agg(to_jsonb(m)-'candidate_key' ORDER BY m.match_rank,m.contractor_id),'[]'::jsonb)
    FROM contractor_identity_matches(p_candidate,p_exclude_contractor_id) m;
$$;

-- Active, non-merged contractors that currently hold the NJ PWC number.
CREATE FUNCTION public.contractor_identity_pwc_owners(p_nj_pwc_number TEXT,p_exclude_contractor_id INTEGER DEFAULT NULL)
RETURNS TABLE(contractor_id INTEGER,company_name TEXT,nj_pwc_number TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT c.id,c.company_name::TEXT,c.nj_pwc_number::TEXT FROM contractors c
    WHERE contractor_identity_pwc_key(p_nj_pwc_number) IS NOT NULL
      AND contractor_identity_pwc_key(c.nj_pwc_number)=contractor_identity_pwc_key(p_nj_pwc_number)
      AND c.active AND c.merged_into_contractor_id IS NULL
      AND c.id IS DISTINCT FROM p_exclude_contractor_id
    ORDER BY c.id;
$$;

-- ---------------------------------------------------------------------------
-- Review decisions and the creation gate
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.contractor_identity_raise(p_message TEXT,p_code TEXT,p_candidate JSONB,p_matches JSONB)
RETURNS VOID
LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
BEGIN
    RAISE EXCEPTION '%',p_message USING ERRCODE='SI409',
        DETAIL=jsonb_build_object('code',p_code,'candidate',contractor_identity_candidate_summary(p_candidate),
            'matches',coalesce(p_matches,'[]'::jsonb))::text;
END;
$$;

CREATE FUNCTION public.contractor_identity_record_decision(
    p_candidate JSONB,p_reviewed_contractor_ids INTEGER[],p_reason TEXT,p_actor UUID,
    p_source_reference TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    v_source TEXT := upper(coalesce(p_candidate->>'source',''));
    v_matches JSONB := contractor_identity_matches_json(p_candidate,NULL);
    v_required INTEGER[];
    v_all INTEGER[];
    v_reviewed INTEGER[];
    v_id UUID;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM user_profiles WHERE auth_user_id=p_actor AND status='Active') THEN
        RAISE EXCEPTION 'An active SubTracker user is required to record an identity decision' USING ERRCODE='42501';
    END IF;
    IF v_source NOT IN ('PROCORE','SPREADSHEET','MANUAL','MYCOI','NJ_PWC') THEN
        RAISE EXCEPTION 'Unsupported identity decision source' USING ERRCODE='22023';
    END IF;
    IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN
        RAISE EXCEPTION 'A reason of 3 to 1000 characters is required' USING ERRCODE='22023';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_matches) m WHERE m->>'disposition' IN ('use_existing','hard_block')) THEN
        PERFORM contractor_identity_raise('An existing contractor identity cannot be overridden by a review decision',
            'identity_conflict',p_candidate,v_matches);
    END IF;
    SELECT coalesce(array_agg((m->>'contractor_id')::integer) FILTER (WHERE m->>'disposition'='review_required'),ARRAY[]::INTEGER[]),
           coalesce(array_agg((m->>'contractor_id')::integer),ARRAY[]::INTEGER[])
      INTO v_required,v_all FROM jsonb_array_elements(v_matches) m;
    SELECT coalesce(array_agg(DISTINCT x ORDER BY x),ARRAY[]::INTEGER[]) INTO v_reviewed
      FROM unnest(coalesce(p_reviewed_contractor_ids,ARRAY[]::INTEGER[])) x WHERE x IS NOT NULL;
    IF cardinality(v_required)=0 THEN
        RAISE EXCEPTION 'No possible existing contractor requires review' USING ERRCODE='22023';
    END IF;
    IF NOT (v_reviewed @> v_required) OR NOT (v_all @> v_reviewed) THEN
        PERFORM contractor_identity_raise('The reviewed contractors do not match the current possible matches',
            'identity_review_stale',p_candidate,v_matches);
    END IF;
    INSERT INTO contractor_identity_decisions(source,source_reference,candidate_fingerprint,candidate_summary,
        reviewed_contractor_ids,decision,reason,decided_by)
    VALUES(v_source,nullif(btrim(p_source_reference),''),contractor_identity_fingerprint(p_candidate),
        contractor_identity_candidate_summary(p_candidate),v_reviewed,'create_separate',btrim(p_reason),p_actor)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

-- Raises SQLSTATE SI409 (JSON DETAIL) unless the candidate may be created as a new contractor.
-- use_existing / hard_block can never be overridden. review_required needs a matching, unconsumed decision.
-- Informational matches are returned but never block.
CREATE FUNCTION public.contractor_identity_assert_creatable(p_candidate JSONB,p_decision_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    v_matches JSONB := contractor_identity_matches_json(p_candidate,NULL);
    v_required INTEGER[];
    v_decision contractor_identity_decisions;
BEGIN
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_matches) m WHERE m->>'disposition' IN ('use_existing','hard_block')) THEN
        PERFORM contractor_identity_raise('SubTracker found an existing contractor for this company',
            'identity_conflict',p_candidate,v_matches);
    END IF;
    SELECT coalesce(array_agg((m->>'contractor_id')::integer) FILTER (WHERE m->>'disposition'='review_required'),ARRAY[]::INTEGER[])
      INTO v_required FROM jsonb_array_elements(v_matches) m;
    IF cardinality(v_required)>0 THEN
        IF p_decision_id IS NULL THEN
            PERFORM contractor_identity_raise('Possible existing contractor requires review before creating a new contractor',
                'identity_review_required',p_candidate,v_matches);
        END IF;
        SELECT * INTO v_decision FROM contractor_identity_decisions WHERE id=p_decision_id;
        IF v_decision.id IS NULL OR v_decision.consumed_at IS NOT NULL
           OR v_decision.source<>upper(coalesce(p_candidate->>'source',''))
           OR v_decision.candidate_fingerprint<>contractor_identity_fingerprint(p_candidate)
           OR NOT (v_decision.reviewed_contractor_ids @> v_required) THEN
            PERFORM contractor_identity_raise('The identity review is missing, already used, or out of date',
                'identity_review_stale',p_candidate,v_matches);
        END IF;
    END IF;
    RETURN jsonb_build_object('status','creatable',
        'decision_id',CASE WHEN cardinality(v_required)>0 THEN p_decision_id END,
        'matches',v_matches);
END;
$$;

CREATE FUNCTION public.contractor_identity_consume_decision(p_decision_id UUID,p_contractor_id INTEGER)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    UPDATE contractor_identity_decisions SET consumed_at=now(),consumed_contractor_id=p_contractor_id
    WHERE id=p_decision_id AND consumed_at IS NULL
      AND EXISTS(SELECT 1 FROM contractors WHERE id=p_contractor_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Identity decision is missing or already used' USING ERRCODE='SI409';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Conflict log and review report
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.contractor_identity_record_conflict(
    p_conflict_type TEXT,p_source TEXT,p_existing_contractor_ids INTEGER[],
    p_attempted_contractor_id INTEGER DEFAULT NULL,p_nj_pwc_number TEXT DEFAULT NULL,
    p_candidate JSONB DEFAULT '{}'::jsonb,p_source_reference TEXT DEFAULT NULL,p_actor UUID DEFAULT NULL)
RETURNS BIGINT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_id BIGINT;
BEGIN
    INSERT INTO contractor_identity_conflicts(conflict_type,source,source_reference,pwc_key,
        attempted_contractor_id,existing_contractor_ids,candidate_summary,detected_by)
    VALUES(upper(p_conflict_type),btrim(p_source),nullif(btrim(p_source_reference),''),
        contractor_identity_pwc_key(p_nj_pwc_number),p_attempted_contractor_id,
        (SELECT array_agg(DISTINCT x ORDER BY x) FROM unnest(p_existing_contractor_ids) x WHERE x IS NOT NULL),
        contractor_identity_candidate_summary(coalesce(p_candidate,'{}'::jsonb)),p_actor)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$$;

CREATE FUNCTION public.contractor_identity_dismiss_conflict(p_conflict_id BIGINT,p_actor UUID,p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM user_profiles WHERE auth_user_id=p_actor AND status='Active') THEN
        RAISE EXCEPTION 'An active SubTracker user is required' USING ERRCODE='42501';
    END IF;
    IF length(btrim(coalesce(p_reason,''))) NOT BETWEEN 3 AND 1000 THEN
        RAISE EXCEPTION 'A reason of 3 to 1000 characters is required' USING ERRCODE='22023';
    END IF;
    UPDATE contractor_identity_conflicts SET dismissed_at=now(),dismissed_by=p_actor,dismissal_reason=btrim(p_reason)
    WHERE id=p_conflict_id AND dismissed_at IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Open identity conflict not found' USING ERRCODE='P0002'; END IF;
END;
$$;

-- Live PWC conflicts are computed from contractors, so Company Merge or a registration
-- correction resolves them without touching identity tables.
CREATE FUNCTION public.contractor_identity_conflict_report() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
WITH holders AS (
    SELECT contractor_identity_pwc_key(c.nj_pwc_number) AS pwc_key,c.id,c.company_name::TEXT AS company_name
    FROM contractors c
    WHERE c.active AND c.merged_into_contractor_id IS NULL AND contractor_identity_pwc_key(c.nj_pwc_number) IS NOT NULL
),
live AS (
    SELECT pwc_key,jsonb_agg(jsonb_build_object('contractor_id',id,'company_name',company_name) ORDER BY id) AS contractors
    FROM holders GROUP BY pwc_key HAVING count(*)>1
),
attempts AS (
    SELECT x.*,
        CASE
            WHEN x.dismissed_at IS NOT NULL THEN true
            WHEN x.conflict_type='PWC_ASSIGNMENT' THEN
                NOT EXISTS(SELECT 1 FROM contractors a WHERE a.id=x.attempted_contractor_id AND a.active
                    AND a.merged_into_contractor_id IS NULL)
                OR NOT EXISTS(SELECT 1 FROM holders h WHERE h.pwc_key=x.pwc_key AND h.id=ANY(x.existing_contractor_ids)
                    AND h.id<>x.attempted_contractor_id)
            ELSE NOT EXISTS(SELECT 1 FROM contractors e WHERE e.id=ANY(x.existing_contractor_ids) AND e.active
                AND e.merged_into_contractor_id IS NULL)
        END AS resolved
    FROM contractor_identity_conflicts x
)
SELECT jsonb_build_object(
    'pwc_conflicts',coalesce((SELECT jsonb_agg(jsonb_build_object('nj_pwc_number',pwc_key,'contractors',contractors)
        ORDER BY pwc_key) FROM live),'[]'::jsonb),
    'recorded_conflicts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',id,'conflict_type',conflict_type,
        'source',source,'source_reference',source_reference,'nj_pwc_number',pwc_key,
        'attempted_contractor_id',attempted_contractor_id,'existing_contractor_ids',existing_contractor_ids,
        'candidate',candidate_summary,'detected_at',detected_at,'resolved',resolved) ORDER BY detected_at DESC,id DESC)
        FROM attempts WHERE NOT resolved),'[]'::jsonb));
$$;

REVOKE ALL ON FUNCTION
    public.contractor_identity_pwc_key(TEXT),public.contractor_identity_fein_key(TEXT),
    public.contractor_identity_brc_key(TEXT),public.contractor_identity_phone_key(TEXT),
    public.contractor_identity_address_key(TEXT,TEXT),public.contractor_identity_name_variant_key(TEXT),
    public.contractor_identity_fingerprint(JSONB),public.contractor_identity_candidate_summary(JSONB),
    public.contractor_identity_match_batch(JSONB),public.contractor_identity_matches(JSONB,INTEGER),
    public.contractor_identity_matches_json(JSONB,INTEGER),public.contractor_identity_pwc_owners(TEXT,INTEGER),
    public.contractor_identity_raise(TEXT,TEXT,JSONB,JSONB),
    public.contractor_identity_record_decision(JSONB,INTEGER[],TEXT,UUID,TEXT),
    public.contractor_identity_assert_creatable(JSONB,UUID),
    public.contractor_identity_consume_decision(UUID,INTEGER),
    public.contractor_identity_record_conflict(TEXT,TEXT,INTEGER[],INTEGER,TEXT,JSONB,TEXT,UUID),
    public.contractor_identity_dismiss_conflict(BIGINT,UUID,TEXT),
    public.contractor_identity_conflict_report()
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION
    public.contractor_identity_pwc_key(TEXT),public.contractor_identity_phone_key(TEXT),
    public.contractor_identity_address_key(TEXT,TEXT),public.contractor_identity_name_variant_key(TEXT),
    public.contractor_identity_fingerprint(JSONB),
    public.contractor_identity_match_batch(JSONB),public.contractor_identity_matches(JSONB,INTEGER),
    public.contractor_identity_matches_json(JSONB,INTEGER),public.contractor_identity_pwc_owners(TEXT,INTEGER),
    public.contractor_identity_record_decision(JSONB,INTEGER[],TEXT,UUID,TEXT),
    public.contractor_identity_assert_creatable(JSONB,UUID),
    public.contractor_identity_consume_decision(UUID,INTEGER),
    public.contractor_identity_record_conflict(TEXT,TEXT,INTEGER[],INTEGER,TEXT,JSONB,TEXT,UUID),
    public.contractor_identity_dismiss_conflict(BIGINT,UUID,TEXT),
    public.contractor_identity_conflict_report()
    TO service_role;
COMMIT;
