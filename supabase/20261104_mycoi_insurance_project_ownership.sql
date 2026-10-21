BEGIN;

ALTER TABLE public.contractors
    ADD COLUMN creation_source TEXT CHECK(creation_source IN ('MANUAL','MYCOI','PROCORE')),
    ADD COLUMN creation_import_history_id INTEGER REFERENCES public.import_history(id) ON DELETE RESTRICT;
-- Historical creation provenance is unknown; only future inserts default to MANUAL.
ALTER TABLE public.contractors ALTER COLUMN creation_source SET DEFAULT 'MANUAL';

CREATE FUNCTION public.contractor_import_name_key(value TEXT) RETURNS TEXT
LANGUAGE plpgsql IMMUTABLE SET search_path=public AS $$
DECLARE tokens TEXT[];
BEGIN
    tokens := string_to_array(btrim(regexp_replace(regexp_replace(
        regexp_replace(replace(replace(lower(value),chr(8217),''),'&',' and '),'[.'']','','g'),
        '[^[:alnum:][:space:]]',' ','g'),'[[:space:]]+',' ','g')), ' ');
    WHILE cardinality(tokens)>1 AND tokens[cardinality(tokens)]=ANY(
        ARRAY['llc','inc','incorporated','corp','corporation','co','company','ltd','lp','llp','pc']) LOOP
        tokens := tokens[1:cardinality(tokens)-1];
    END LOOP;
    RETURN array_to_string(tokens,' ');
END;
$$;
REVOKE ALL ON FUNCTION public.contractor_import_name_key(TEXT) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.protect_contractor_creation_source() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
    IF TG_OP='UPDATE' THEN
        IF NEW.creation_source IS DISTINCT FROM OLD.creation_source
            OR NEW.creation_import_history_id IS DISTINCT FROM OLD.creation_import_history_id THEN
            RAISE EXCEPTION 'Contractor creation provenance is immutable';
        END IF;
    ELSIF current_user IN ('authenticated','anon') THEN
        NEW.creation_source := 'MANUAL';
        NEW.creation_import_history_id := NULL;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_contractor_creation_source BEFORE INSERT OR UPDATE ON public.contractors
    FOR EACH ROW EXECUTE FUNCTION public.protect_contractor_creation_source();

CREATE TABLE public.relationship_sources (source TEXT PRIMARY KEY);
ALTER TABLE public.relationship_sources ENABLE ROW LEVEL SECURITY;
INSERT INTO public.relationship_sources VALUES ('MANUAL'),('MYCOI'),('PROCORE');
REVOKE ALL ON public.relationship_sources FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.relationship_sources TO authenticated,service_role;
CREATE POLICY relationship_sources_read ON public.relationship_sources FOR SELECT TO authenticated,service_role USING (true);

ALTER TABLE public.contractor_projects
    ADD COLUMN ownership_sources TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN manual_owned BOOLEAN GENERATED ALWAYS AS ('MANUAL'=ANY(ownership_sources)) STORED,
    ADD COLUMN mycoi_owned BOOLEAN GENERATED ALWAYS AS ('MYCOI'=ANY(ownership_sources)) STORED,
    ADD COLUMN procore_owned BOOLEAN GENERATED ALWAYS AS ('PROCORE'=ANY(ownership_sources)) STORED;

-- Unknown pre-existing provenance is protected, never inferred to be myCOI.
UPDATE public.contractor_projects SET ownership_sources = ARRAY['MANUAL'] WHERE active;
ALTER TABLE public.contractor_projects
    ADD CONSTRAINT contractor_project_effective_ownership CHECK (active = (cardinality(ownership_sources)>0));

CREATE TABLE public.project_source_snapshots (
    source TEXT NOT NULL REFERENCES public.relationship_sources(source),
    import_run_id TEXT NOT NULL,
    import_history_id INTEGER NOT NULL REFERENCES public.import_history(id) ON DELETE RESTRICT,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    accepted_by UUID NOT NULL,
    pairs JSONB NOT NULL CHECK (jsonb_typeof(pairs) = 'array'),
    PRIMARY KEY(source,import_run_id)
);
ALTER TABLE public.project_source_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.project_source_snapshots FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.project_source_snapshots TO service_role;

CREATE FUNCTION public.audit_project_ownership() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    source TEXT;
    previous BOOLEAN;
    owned BOOLEAN;
    actor UUID := nullif(current_setting('subtracker.assignment_actor', true), '')::uuid;
    history_id INTEGER := nullif(current_setting('subtracker.assignment_import', true), '')::integer;
    actor_name TEXT;
    actor_email TEXT;
    change TEXT;
BEGIN
    SELECT name, email INTO actor_name, actor_email FROM user_profiles WHERE auth_user_id = actor;
    FOR source IN SELECT DISTINCT unnest(NEW.ownership_sources ||
        CASE WHEN TG_OP='INSERT' THEN '{}'::text[] ELSE OLD.ownership_sources END) LOOP
        previous := CASE WHEN TG_OP = 'INSERT' THEN false
            ELSE source=ANY(OLD.ownership_sources) END;
        owned := source=ANY(NEW.ownership_sources);
        IF previous IS DISTINCT FROM owned THEN
            change := CASE WHEN owned THEN 'ADDED' ELSE 'REMOVED' END;
            INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
            VALUES(actor,COALESCE(actor_name,'Migration'),COALESCE(actor_email,'Migration'),'PROJECT_SOURCE_' || change,'contractor_project',NEW.id::text,
                source || ' project ownership',
                jsonb_build_object('contractor_id',NEW.contractor_id,'project_id',NEW.project_id,
                    'source',source,'change',change,'timestamp',clock_timestamp(),'import_history_id',history_id));
            INSERT INTO activity_log(contractor_id,project_id,activity_type,notes,created_by)
            VALUES(NEW.contractor_id,NEW.project_id,'Project Source ' || change,
                source || ' ownership ' || lower(change) ||
                CASE WHEN history_id IS NULL THEN '' ELSE ' | import_history #' || history_id END,
                COALESCE(actor_email,'Migration'));
        END IF;
    END LOOP;
    RETURN NEW;
END;
$$;
CREATE TRIGGER audit_project_source_changes AFTER INSERT OR UPDATE OF ownership_sources
    ON public.contractor_projects FOR EACH ROW EXECUTE FUNCTION public.audit_project_ownership();

INSERT INTO administration_audit_log(user_name,user_email,action,object_type,object_id,object_label,details)
SELECT 'Migration','Migration','PROJECT_SOURCE_ADDED','contractor_project',id::text,'Protected pre-existing assignment',
    jsonb_build_object('contractor_id',contractor_id,'project_id',project_id,'source','MANUAL',
        'change','ADDED','timestamp',now(),'reason','Unknown pre-existing provenance protected; no MYCOI ownership inferred')
FROM public.contractor_projects WHERE manual_owned;
INSERT INTO activity_log(contractor_id,project_id,activity_type,notes,created_by)
SELECT contractor_id,project_id,'Project Source ADDED',
    'MANUAL ownership added | Unknown pre-existing provenance protected; not inferred MYCOI','Migration'
FROM public.contractor_projects WHERE manual_owned;

CREATE FUNCTION public.set_project_assignment_source(
    p_contractor INTEGER, p_project INTEGER, p_source TEXT, p_owned BOOLEAN, p_assigned DATE DEFAULT CURRENT_DATE
) RETURNS public.contractor_projects
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    assignment public.contractor_projects;
    sources TEXT[];
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('contractor_project_ownership'));
    IF p_source IS NULL OR NOT EXISTS(SELECT 1 FROM relationship_sources WHERE source=p_source)
        OR p_owned IS NULL OR p_assigned IS NULL THEN
        RAISE EXCEPTION 'Invalid project ownership request';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM contractors WHERE id=p_contractor)
        OR NOT EXISTS(SELECT 1 FROM projects WHERE id=p_project) THEN
        RAISE EXCEPTION 'Contractor or project is unavailable';
    END IF;
    SELECT * INTO assignment FROM contractor_projects
        WHERE contractor_id=p_contractor AND project_id=p_project AND active FOR UPDATE;
    IF assignment.id IS NULL THEN
        IF NOT p_owned THEN RETURN NULL; END IF;
        INSERT INTO contractor_projects(contractor_id,project_id,assigned_date,active,ownership_sources)
        VALUES(p_contractor,p_project,p_assigned,true,ARRAY[p_source]) RETURNING * INTO assignment;
    ELSE
        sources := array_remove(assignment.ownership_sources,p_source);
        IF p_owned THEN sources := sources || ARRAY[p_source]; END IF;
        UPDATE contractor_projects SET
            ownership_sources=sources,
            active=cardinality(sources)>0,
            removed_date=CASE WHEN cardinality(sources)>0
                THEN NULL ELSE greatest(CURRENT_DATE,assigned_date) END
        WHERE id=assignment.id RETURNING * INTO assignment;
    END IF;
    RETURN assignment;
END;
$$;
REVOKE ALL ON FUNCTION public.set_project_assignment_source(INTEGER,INTEGER,TEXT,BOOLEAN,DATE) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.set_manual_project_assignment(
    p_contractor INTEGER, p_project INTEGER, p_owned BOOLEAN, p_assigned DATE DEFAULT CURRENT_DATE
) RETURNS SETOF public.contractor_projects
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE assignment public.contractor_projects;
BEGIN
    IF NOT (public.user_has_module_permission('projects',CASE WHEN p_owned THEN 'add' ELSE 'edit' END)
        OR EXISTS (SELECT 1 FROM user_profiles WHERE auth_user_id=auth.uid() AND status='Active' AND system_administrator)) THEN
        RAISE EXCEPTION 'Project assignment permission required' USING ERRCODE='42501';
    END IF;
    PERFORM set_config('subtracker.assignment_actor',auth.uid()::text,true);
    PERFORM set_config('subtracker.assignment_import','',true);
    assignment := set_project_assignment_source(p_contractor,p_project,'MANUAL',p_owned,p_assigned);
    IF assignment.id IS NOT NULL THEN RETURN NEXT assignment; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.set_manual_project_assignment(INTEGER,INTEGER,BOOLEAN,DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_manual_project_assignment(INTEGER,INTEGER,BOOLEAN,DATE) TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.contractor_projects FROM authenticated, anon;

-- Preserve the existing atomic policy/mapping import; the public entry point also accepts an explicitly confirmed full snapshot.
ALTER FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID) RENAME TO mycoi_apply_import_data;
REVOKE ALL ON FUNCTION public.mycoi_apply_import_data(UUID,INTEGER,TEXT,JSONB,JSONB,UUID) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.mycoi_apply_import(
    p_run UUID, p_revision INTEGER, p_token TEXT, p_plan JSONB, p_audits JSONB, p_actor UUID,
    p_snapshot JSONB DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    result JSONB;
    run public.mycoi_import_runs;
    pair RECORD;
    pairs JSONB;
    vendor JSONB;
    resolved_plan JSONB := '[]';
    new_id INTEGER;
    history_id INTEGER;
    audit JSONB;
    mappings JSONB;
    resolved_audits JSONB := '[]';
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mycoi_manual_import'));
    PERFORM pg_advisory_xact_lock(hashtext('contractor_project_ownership'));
    SELECT * INTO STRICT run FROM mycoi_import_runs WHERE id=p_run FOR UPDATE;
    IF run.revision<>p_revision OR (mycoi_import_reference()->>'token') IS DISTINCT FROM p_token THEN
        RAISE EXCEPTION 'Source or review changed; refresh preview' USING ERRCODE='40001';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_plan) v WHERE v->>'createContractor'='true') THEN
        IF NOT EXISTS(SELECT 1 FROM user_profiles u WHERE auth_user_id=p_actor AND status='Active'
            AND (system_administrator OR EXISTS(SELECT 1 FROM role_permissions p WHERE p.role=u.role
                AND p.module='contractors' AND p.can_view AND p.can_add))) THEN
            RAISE EXCEPTION 'Contractors Add permission required' USING ERRCODE='42501';
        END IF;
        -- Serialize against manual/imported company writes, then recheck normalized duplicates.
        LOCK TABLE contractors IN SHARE ROW EXCLUSIVE MODE;
        history_id := run.import_history_id;
        IF history_id IS NULL THEN
            INSERT INTO import_history(file_name,imported_rows,successful_rows,failed_rows,notes)
                VALUES(run.file_name,jsonb_array_length(run.source_rows),0,0,'myCOI reviewed contractor creation')
                RETURNING id INTO history_id;
            UPDATE mycoi_import_runs SET import_history_id=history_id WHERE id=p_run;
        END IF;
    END IF;
    FOR vendor IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
        IF vendor->>'createContractor'='true' THEN
            IF NOT COALESCE(run.decisions->'addContractors' @> jsonb_build_array(vendor->>'key'),false)
                OR EXISTS(SELECT 1 FROM mycoi_vendor_mappings WHERE active AND vendor_name_key=vendor->>'key')
                OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(run.source_rows) r
                    WHERE r->>'Vendor Name'=vendor->>'raw' AND lower(btrim(r->>'Vendor Name'))=vendor->>'key')
                OR length(btrim(vendor->>'raw')) NOT BETWEEN 1 AND 250
                OR COALESCE(contractor_import_name_key(vendor->>'raw'),'')='' THEN
                RAISE EXCEPTION 'Explicit valid Add Contractor review required';
            END IF;
            IF EXISTS(SELECT 1 FROM contractors WHERE contractor_import_name_key(company_name)=contractor_import_name_key(vendor->>'raw')) THEN
                RAISE EXCEPTION 'Matching company already exists; Match Existing Contractor instead' USING ERRCODE='40001';
            END IF;
            INSERT INTO contractors(company_name,creation_source,creation_import_history_id)
                VALUES(btrim(vendor->>'raw'),'MYCOI',history_id) RETURNING id INTO new_id;
            INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
                SELECT p_actor,name,email,'CONTRACTOR_CREATED_FROM_IMPORT','contractor',new_id::text,vendor->>'raw',
                    jsonb_build_object('source','MYCOI','contractor_id',new_id,'import_history_id',history_id,
                        'import_run_id',p_run,'raw_company_name',vendor->>'raw','timestamp',clock_timestamp())
                FROM user_profiles WHERE auth_user_id=p_actor;
            vendor := vendor || jsonb_build_object('contractorId',new_id);
        END IF;
        resolved_plan := resolved_plan || jsonb_build_array(vendor);
    END LOOP;
    FOR audit IN SELECT value FROM jsonb_array_elements(p_audits) LOOP
        IF audit->>'action'='MYCOI_MAPPINGS_ACCEPTED' THEN
            SELECT COALESCE(jsonb_agg(CASE WHEN m->>'kind'='vendor' THEN m ||
                jsonb_build_object('contractor_id',(SELECT (v->>'contractorId')::integer
                    FROM jsonb_array_elements(resolved_plan) v WHERE v->>'raw'=m->>'raw'))
                ELSE m END),'[]') INTO mappings FROM jsonb_array_elements(audit->'details'->'mappings') m;
            audit := jsonb_set(audit,'{details,mappings}',mappings);
        END IF;
        resolved_audits := resolved_audits || jsonb_build_array(audit);
    END LOOP;
    result := mycoi_apply_import_data(p_run,p_revision,mycoi_import_reference()->>'token',resolved_plan,resolved_audits,p_actor);
    IF p_snapshot IS NULL THEN RETURN result; END IF;
    SELECT COALESCE(jsonb_agg(CASE WHEN v->>'createContractor'='true' THEN v ||
        jsonb_build_object('contractorId',(SELECT contractor_id FROM mycoi_vendor_mappings
            WHERE active AND vendor_name_key=v->>'key')) ELSE v END),'[]') INTO p_snapshot
        FROM jsonb_array_elements(p_snapshot) v;
    SELECT * INTO STRICT run FROM mycoi_import_runs WHERE id=p_run;
    IF run.status <> 'Complete' OR jsonb_array_length(run.decisions->'ignored') <> 0
        OR jsonb_array_length(run.imported_rows) <> jsonb_array_length(run.source_rows)
        OR jsonb_array_length(run.source_rows) = 0 OR jsonb_typeof(p_snapshot) <> 'array' THEN
        RAISE EXCEPTION 'Only a complete resolved import without ignored rows can replace project ownership';
    END IF;
    IF EXISTS (SELECT 1 FROM project_source_snapshots s JOIN mycoi_import_runs r ON r.id::text=s.import_run_id
        WHERE s.source='MYCOI' AND r.created_at >= run.created_at) THEN
        RAISE EXCEPTION 'This snapshot was already accepted or is older than the latest accepted snapshot' USING ERRCODE='40001';
    END IF;
    -- All source rows must occur exactly once in the server-built, fully reviewed plan.
    IF EXISTS (
        (SELECT (r->>'row')::integer FROM jsonb_array_elements(run.source_rows) r
         EXCEPT SELECT n.value::integer FROM jsonb_array_elements(p_snapshot) v, jsonb_array_elements_text(v->'rows') n)
        UNION ALL
        (SELECT n.value::integer FROM jsonb_array_elements(p_snapshot) v, jsonb_array_elements_text(v->'rows') n
         EXCEPT SELECT (r->>'row')::integer FROM jsonb_array_elements(run.source_rows) r)
    ) OR (SELECT count(*) FROM jsonb_array_elements(p_snapshot) v, jsonb_array_elements_text(v->'rows'))
        <> jsonb_array_length(run.source_rows) THEN
        RAISE EXCEPTION 'Snapshot must account for every reviewed source row';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_snapshot) v WHERE NOT EXISTS (
        SELECT 1 FROM mycoi_vendor_mappings m WHERE m.active AND m.vendor_name_key=v->>'key'
            AND m.contractor_id=(v->>'contractorId')::integer)) THEN
        RAISE EXCEPTION 'Snapshot vendor mapping is not active';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('contractor_id',contractor_id,'project_id',project_id)
        ORDER BY contractor_id,project_id),'[]'::jsonb) INTO pairs FROM (
        SELECT DISTINCT (v->>'contractorId')::integer contractor_id, (d->>'projectId')::integer project_id
        FROM jsonb_array_elements(p_snapshot) v, jsonb_array_elements(v->'divisions') d
        WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(v->'policies') p
            WHERE p->'divisions' @> jsonb_build_array(d->>'key'))
    ) desired;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import',run.import_history_id::text,true);
    FOR pair IN SELECT contractor_id,project_id FROM contractor_projects cp WHERE cp.mycoi_owned
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(pairs) p
            WHERE (p->>'contractor_id')::integer=cp.contractor_id AND (p->>'project_id')::integer=cp.project_id)
    LOOP
        PERFORM set_project_assignment_source(pair.contractor_id,pair.project_id,'MYCOI',false);
    END LOOP;
    FOR pair IN SELECT (p->>'contractor_id')::integer contractor_id,(p->>'project_id')::integer project_id
        FROM jsonb_array_elements(pairs) p
    LOOP
        PERFORM set_project_assignment_source(pair.contractor_id,pair.project_id,'MYCOI',true);
    END LOOP;
    INSERT INTO project_source_snapshots(source,import_run_id,import_history_id,accepted_by,pairs)
        VALUES('MYCOI',p_run::text,run.import_history_id,p_actor,pairs);
    INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
        SELECT p_actor,name,email,'MYCOI_PROJECT_SNAPSHOT_ACCEPTED','mycoi_import',p_run::text,run.file_name,
            jsonb_build_object('import_history_id',run.import_history_id,'project_pairs',pairs)
        FROM user_profiles WHERE auth_user_id=p_actor;
    RETURN result || jsonb_build_object('project_snapshot_accepted',true,'project_pairs',jsonb_array_length(pairs));
END;
$$;
REVOKE ALL ON FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mycoi_apply_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID,JSONB) TO service_role;

-- Historical insurance and correspondence links are retained. Current insurance is myCOI-only.
REVOKE INSERT, UPDATE ON public.contractor_insurance, public.contractor_insurance_history FROM PUBLIC, authenticated, anon;
ALTER TABLE public.communication_insurance_items
    DROP CONSTRAINT communication_insurance_items_contractor_id_fkey,
    ADD CONSTRAINT communication_insurance_items_contractor_id_fkey
        FOREIGN KEY(contractor_id) REFERENCES public.contractors(id) ON DELETE RESTRICT;
COMMENT ON TABLE public.mycoi_contractor_divisions IS
    'Imported vendor/division compliance and individual policy links. Effective project membership is synchronized separately from explicitly accepted complete source snapshots.';

COMMIT;
