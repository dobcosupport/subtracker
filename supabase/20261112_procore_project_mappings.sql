-- Local migration proposal. Apply manually before deploying dependent application code.
-- No project renumbering, project creation, import, backfill or entity-lineage change.
BEGIN;

CREATE TABLE public.procore_project_mappings (
    source_number TEXT PRIMARY KEY CHECK (length(source_number) BETWEEN 1 AND 250 AND source_number=btrim(source_number)),
    project_id INTEGER REFERENCES public.projects(id) ON DELETE RESTRICT,
    import_run_id UUID NOT NULL REFERENCES public.procore_import_runs(id) ON DELETE RESTRICT,
    accepted_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.procore_project_mappings.project_id IS
    'NULL is an explicit Leave Unmatched decision; otherwise the approved existing project. Procore only.';
ALTER TABLE public.procore_project_mappings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.procore_project_mappings FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.procore_project_mappings TO service_role;

CREATE FUNCTION public.procore_resolve_project(p_number TEXT) RETURNS INTEGER
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target INTEGER;
BEGIN
    IF nullif(btrim(p_number),'') IS NULL THEN RETURN NULL; END IF;
    SELECT project_id INTO target FROM procore_project_mappings WHERE source_number=btrim(p_number);
    IF FOUND THEN RETURN target; END IF;
    SELECT min(id) INTO target FROM projects WHERE project_number=btrim(p_number)
        HAVING count(*)=1;
    RETURN target;
END;
$$;

CREATE OR REPLACE FUNCTION public.procore_import_reference() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
    WITH state AS (SELECT jsonb_build_object(
        'contractors',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM
            (SELECT id,company_name,active FROM contractors) c),'[]'::jsonb),
        'projects',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM
            (SELECT id,project_number,project_name FROM projects) p),'[]'::jsonb),
        'projectMappings',coalesce((SELECT jsonb_agg(to_jsonb(m) ORDER BY source_number)
            FROM procore_project_mappings m),'[]'::jsonb),
        'vendors',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY vendor_key) FROM procore_vendor_mappings v),'[]'::jsonb),
        'contacts',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM
            (SELECT id,contractor_id,contact_name,email,business_phone,mobile_phone,is_active FROM contractor_contacts) c),'[]'::jsonb)
    ) value)
    SELECT value || jsonb_build_object('token',md5(value::text)) FROM state;
$$;

CREATE FUNCTION public.procore_save_project_mapping(
    p_run UUID,p_revision INTEGER,p_token TEXT,p_number TEXT,p_project INTEGER,p_actor UUID
) RETURNS public.procore_import_runs
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE run public.procore_import_runs; prior JSONB;
BEGIN
    PERFORM procore_require_actor(p_actor,true);
    PERFORM pg_advisory_xact_lock(hashtext('procore_manual_import'));
    SELECT * INTO STRICT run FROM procore_import_runs WHERE id=p_run FOR UPDATE;
    IF run.revision<>p_revision OR run.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'Import changed or is Finalized; reload before mapping' USING ERRCODE='40001';
    END IF;
    LOCK TABLE projects,procore_project_mappings IN SHARE ROW EXCLUSIVE MODE;
    IF p_token IS DISTINCT FROM procore_import_reference()->>'token' THEN
        RAISE EXCEPTION 'Reference data changed; reload review' USING ERRCODE='40001';
    END IF;
    IF nullif(btrim(p_number),'') IS NULL OR p_number<>btrim(p_number) OR length(p_number)>250 OR NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(run.source_rows) r WHERE btrim(r->>'Project > Number')=p_number
    ) THEN RAISE EXCEPTION 'Unknown Procore project number' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(run.source_rows) r
        WHERE btrim(r->>'Project > Number')=p_number AND run.imported_rows @> jsonb_build_array((r->>'row')::integer)) THEN
        RAISE EXCEPTION 'Project rows already imported in this review; mapping cannot be changed here' USING ERRCODE='40001';
    END IF;
    IF p_project IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE id=p_project) THEN
        RAISE EXCEPTION 'Select an existing SubTracker project' USING ERRCODE='22023';
    END IF;
    SELECT to_jsonb(m) INTO prior FROM procore_project_mappings m WHERE source_number=p_number;
    IF prior IS NOT NULL AND (prior->>'project_id')::integer IS NOT DISTINCT FROM p_project THEN RETURN run; END IF;
    INSERT INTO procore_project_mappings(source_number,project_id,import_run_id,accepted_by)
    VALUES(p_number,p_project,p_run,p_actor)
    ON CONFLICT(source_number) DO UPDATE SET project_id=excluded.project_id,import_run_id=excluded.import_run_id,
        accepted_by=excluded.accepted_by,accepted_at=now();
    UPDATE procore_import_runs SET revision=revision+1,updated_at=now() WHERE id=p_run RETURNING * INTO run;
    PERFORM procore_import_audit(p_actor,p_run,'PROCORE_PROJECT_MAPPING_SAVED',
        jsonb_build_object('source_number',p_number,'project_id',p_project,'prior_mapping',prior,'revision',run.revision));
    RETURN run;
END;
$$;

CREATE OR REPLACE FUNCTION public.procore_apply_import(p_run UUID,p_revision INTEGER,p_token TEXT,p_plan JSONB,p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE
    run public.procore_import_runs;
    actor public.user_profiles;
    vendor JSONB; assignment JSONB; contact JSONB; source JSONB;
    company JSONB; contractor INTEGER; history INTEGER; row_number INTEGER;
    contact_row public.contractor_contacts;
    contact_ids JSONB; prior_sources TEXT[]; resulting public.contractor_projects;
    contact_matches UUID[]; imported JSONB; assignment_count INTEGER:=0; contact_count INTEGER:=0; created_count INTEGER:=0;
    current_reference JSONB; assignment_keys JSONB:='[]'; assignment_key TEXT;
BEGIN
    actor := procore_require_actor(p_actor,true);
    PERFORM pg_advisory_xact_lock(hashtext('procore_manual_import'));
    PERFORM pg_advisory_xact_lock(hashtext('contractor_project_ownership'));
    SELECT * INTO STRICT run FROM procore_import_runs WHERE id=p_run FOR UPDATE;
    IF run.revision<>p_revision OR run.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'Import changed or is Finalized; reload before importing' USING ERRCODE='40001';
    END IF;
    LOCK TABLE contractors,projects,contractor_contacts,procore_vendor_mappings,procore_project_mappings IN SHARE ROW EXCLUSIVE MODE;
    current_reference:=procore_import_reference();
    IF p_token IS DISTINCT FROM current_reference->>'token' THEN
        RAISE EXCEPTION 'Reference data changed; reload review' USING ERRCODE='40001';
    END IF;
    IF jsonb_typeof(p_plan) IS DISTINCT FROM 'array' OR jsonb_array_length(p_plan)=0 THEN
        RAISE EXCEPTION 'No resolved Procore assignments to import' USING ERRCODE='22023';
    END IF;
    history:=run.import_history_id;
    IF history IS NULL THEN
        INSERT INTO import_history(file_name,imported_rows,successful_rows,failed_rows,notes)
        VALUES(run.file_name,run.source_row_count,0,run.source_row_count,'Procore import '||run.id) RETURNING id INTO history;
    END IF;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import',history::text,true);
    imported:=run.imported_rows;
    FOR vendor IN SELECT value FROM jsonb_array_elements(p_plan) LOOP
        company:=vendor->'company';
        IF vendor->>'key' IS DISTINCT FROM contractor_import_name_key(company->>'company_name')
            OR nullif(vendor->>'key','') IS NULL THEN RAISE EXCEPTION 'Invalid vendor identity'; END IF;
        IF (vendor->>'createContractor')::boolean THEN
            PERFORM procore_require_actor(p_actor,true,true);
            IF run.decisions->'vendors'->(vendor->>'key')->>'action' IS DISTINCT FROM 'ADD'
                OR EXISTS(SELECT 1 FROM contractors c WHERE contractor_import_name_key(c.company_name)=vendor->>'key') THEN
                RAISE EXCEPTION 'Add Contractor requires explicit approval and no normalized duplicate' USING ERRCODE='40001';
            END IF;
            INSERT INTO contractors(company_name,phone,address_1,city,state,zip_code,active,creation_source,creation_import_history_id)
            VALUES(company->>'company_name',company->>'phone',company->>'address_1',company->>'city',company->>'state',
                company->>'zip_code',true,'PROCORE',history) RETURNING id INTO contractor;
            created_count:=created_count+1;
        ELSE
            contractor:=(vendor->>'contractorId')::integer;
            IF NOT EXISTS(SELECT 1 FROM contractors WHERE id=contractor) OR NOT coalesce((
                (run.decisions->'vendors'->(vendor->>'key')->>'action'='MATCH'
                    AND (run.decisions->'vendors'->(vendor->>'key')->>'contractorId')::integer=contractor)
                OR (coalesce(run.decisions->'vendors'->(vendor->>'key')->>'action','') NOT IN ('MATCH','UNMATCHED') AND EXISTS(
                    SELECT 1 FROM procore_vendor_mappings WHERE vendor_key=vendor->>'key' AND contractor_id=contractor))
            ),false) THEN RAISE EXCEPTION 'An accepted contractor mapping is required'; END IF;
        END IF;
        INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,import_run_id,import_history_id,accepted_by)
        VALUES(vendor->>'key',company->>'company_name',contractor,p_run,history,p_actor)
        ON CONFLICT(vendor_key) DO UPDATE SET contractor_id=excluded.contractor_id,import_run_id=excluded.import_run_id,
            import_history_id=excluded.import_history_id,accepted_by=excluded.accepted_by,accepted_at=now();
        contact_ids:='{}';
        FOR contact IN SELECT value FROM jsonb_array_elements(vendor->'contacts') ORDER BY value->>'email' NULLS LAST LOOP
            SELECT array_agg(id ORDER BY id) INTO contact_matches FROM contractor_contacts c WHERE contractor_id=contractor
                AND CASE WHEN nullif(contact->>'email','') IS NOT NULL
                    THEN lower(btrim(c.email))=lower(btrim(contact->>'email'))
                    ELSE lower(regexp_replace(btrim(c.contact_name),'[[:space:]]+',' ','g'))=
                        lower(regexp_replace(btrim(contact->>'contact_name'),'[[:space:]]+',' ','g')) END;
            IF contact_matches IS NULL AND nullif(contact->>'email','') IS NOT NULL THEN
                SELECT array_agg(id ORDER BY id) INTO contact_matches FROM contractor_contacts c
                    WHERE contractor_id=contractor AND nullif(btrim(c.email),'') IS NULL AND
                    lower(regexp_replace(btrim(c.contact_name),'[[:space:]]+',' ','g'))=
                    lower(regexp_replace(btrim(contact->>'contact_name'),'[[:space:]]+',' ','g'));
            END IF;
            IF cardinality(contact_matches)>1 THEN RAISE EXCEPTION 'Ambiguous contact changed; reload review' USING ERRCODE='40001'; END IF;
            IF contact_matches IS NULL THEN
                INSERT INTO contractor_contacts(contractor_id,contact_name,email,business_phone,mobile_phone)
                VALUES(contractor,contact->>'contact_name',contact->>'email',contact->>'business_phone',contact->>'mobile_phone')
                RETURNING * INTO contact_row;
                contact_count:=contact_count+1;
            ELSE SELECT * INTO STRICT contact_row FROM contractor_contacts WHERE id=contact_matches[1];
            END IF;
            FOR row_number IN SELECT value::integer FROM jsonb_array_elements_text(contact->'rows') LOOP
                contact_ids:=contact_ids || jsonb_build_object(row_number::text,contact_row.id);
            END LOOP;
        END LOOP;
        FOR assignment IN SELECT value FROM jsonb_array_elements(vendor->'assignments') LOOP
            IF procore_resolve_project(assignment->>'number') IS DISTINCT FROM (assignment->>'projectId')::integer
                OR (assignment->>'projectId') IS NULL THEN
                RAISE EXCEPTION 'Project number must match exactly one existing project or approved Procore mapping';
            END IF;
            SELECT ownership_sources INTO prior_sources FROM contractor_projects
                WHERE contractor_id=contractor AND project_id=(assignment->>'projectId')::integer AND active;
            resulting:=set_project_assignment_source(contractor,(assignment->>'projectId')::integer,'PROCORE',true);
            assignment_key:=contractor::text || ':' || (assignment->>'projectId');
            IF NOT assignment_keys @> jsonb_build_array(assignment_key) THEN
                assignment_count:=assignment_count+1;
                assignment_keys:=assignment_keys || jsonb_build_array(assignment_key);
            END IF;
            FOR row_number IN SELECT value::integer FROM jsonb_array_elements_text(assignment->'rows') LOOP
                SELECT value INTO STRICT source FROM jsonb_array_elements(run.source_rows)
                    WHERE (value->>'row')::integer=row_number AND btrim(value->>'Project > Number')=assignment->>'number'
                        AND contractor_import_name_key(value->>'Company (Vendor) > Name')=vendor->>'key';
                IF imported @> jsonb_build_array(row_number) THEN RAISE EXCEPTION 'Source row already imported'; END IF;
                INSERT INTO procore_import_lineage(import_run_id,import_history_id,source_row,contractor_id,project_id,contact_id,actor_id,evidence)
                VALUES(p_run,history,row_number,contractor,(assignment->>'projectId')::integer,
                    (contact_ids->>row_number::text)::uuid,p_actor,
                    jsonb_build_object('source_row',source,'prior_ownership_sources',coalesce(to_jsonb(prior_sources),'[]'),
                        'resulting_ownership_sources',resulting.ownership_sources,'assignment_id',resulting.id,'vendor_key',vendor->>'key',
                        'project_mapping',(SELECT to_jsonb(m) FROM procore_project_mappings m WHERE source_number=assignment->>'number')));
                imported:=imported || jsonb_build_array(row_number);
            END LOOP;
        END LOOP;
    END LOOP;
    UPDATE procore_import_runs SET imported_rows=imported,import_history_id=history,last_imported_at=now(),updated_at=now(),
        revision=revision+1,status=CASE WHEN jsonb_array_length(imported)=source_row_count THEN 'Complete' ELSE 'Partial' END
        WHERE id=p_run;
    UPDATE import_history SET successful_rows=jsonb_array_length(imported),failed_rows=run.source_row_count-jsonb_array_length(imported)
        WHERE id=history;
    PERFORM procore_import_audit(p_actor,p_run,'PROCORE_IMPORT_APPLIED',jsonb_build_object('import_history_id',history,
        'source_rows',imported,'assignments',assignment_count,'contacts_created',contact_count,'contractors_created',created_count,
        'ownership_removals',0));
    RETURN jsonb_build_object('assignments',assignment_count,'contacts_created',contact_count,'contractors_created',created_count,
        'ownership_removals',0,'import_history_id',history);
END;
$$;

REVOKE ALL ON FUNCTION public.procore_resolve_project(TEXT),public.procore_save_project_mapping(UUID,INTEGER,TEXT,TEXT,INTEGER,UUID)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.procore_save_project_mapping(UUID,INTEGER,TEXT,TEXT,INTEGER,UUID) TO service_role;

COMMIT;
