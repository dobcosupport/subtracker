-- Additive definitions only. No import, backfill, reconciliation or cleanup.
BEGIN;

ALTER TABLE public.contractor_contacts ADD COLUMN business_phone TEXT;

-- Preserve the established contact validation/primary-contact behavior and old clients.
ALTER FUNCTION public.save_contractor_contact(INTEGER,UUID,JSONB) RENAME TO save_contractor_contact_without_business_phone;
REVOKE ALL ON FUNCTION public.save_contractor_contact_without_business_phone(INTEGER,UUID,JSONB)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_contractor_contact(p_contractor_id INTEGER,p_contact_id UUID,p_values JSONB)
RETURNS public.contractor_contacts LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE saved public.contractor_contacts;
BEGIN
    IF p_values ? 'business_phone' AND jsonb_typeof(p_values->'business_phone') NOT IN ('string','null') THEN
        RAISE EXCEPTION 'Business Phone must be text or null' USING ERRCODE='22023';
    END IF;
    saved := save_contractor_contact_without_business_phone(p_contractor_id,p_contact_id,p_values-'business_phone');
    IF p_values ? 'business_phone' THEN
        UPDATE contractor_contacts SET business_phone=nullif(btrim(p_values->>'business_phone'),'')
            WHERE id=saved.id RETURNING * INTO saved;
    END IF;
    RETURN saved;
END;
$$;
REVOKE ALL ON FUNCTION public.save_contractor_contact(INTEGER,UUID,JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.save_contractor_contact(INTEGER,UUID,JSONB) TO authenticated;

CREATE TABLE public.procore_import_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_name TEXT NOT NULL CHECK(length(file_name) BETWEEN 1 AND 250),
    created_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revision INTEGER NOT NULL DEFAULT 1,
    source_rows JSONB NOT NULL CHECK(jsonb_typeof(source_rows)='array' AND jsonb_array_length(source_rows) BETWEEN 1 AND 20000),
    source_row_count INTEGER GENERATED ALWAYS AS (jsonb_array_length(source_rows)) STORED,
    decisions JSONB NOT NULL DEFAULT '{"vendors":{}}',
    imported_rows JSONB NOT NULL DEFAULT '[]',
    import_history_id INTEGER REFERENCES public.import_history(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'Review' CHECK(status IN ('Review','Partial','Complete')),
    last_imported_at TIMESTAMPTZ,
    finalized_at TIMESTAMPTZ,
    finalized_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    closeout JSONB,
    finalized_review JSONB,
    CHECK ((finalized_at IS NULL AND finalized_by IS NULL AND finalized_review IS NULL)
        OR (finalized_at IS NOT NULL AND finalized_by IS NOT NULL AND finalized_review IS NOT NULL AND closeout IS NOT NULL))
);
CREATE INDEX procore_import_runs_history ON public.procore_import_runs(created_at DESC,id);
CREATE TABLE public.procore_vendor_mappings (
    vendor_key TEXT PRIMARY KEY,
    raw_vendor_name TEXT NOT NULL,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    import_run_id UUID NOT NULL REFERENCES public.procore_import_runs(id) ON DELETE RESTRICT,
    import_history_id INTEGER NOT NULL REFERENCES public.import_history(id) ON DELETE RESTRICT,
    accepted_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE public.procore_import_lineage (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    import_run_id UUID NOT NULL REFERENCES public.procore_import_runs(id) ON DELETE RESTRICT,
    import_history_id INTEGER NOT NULL REFERENCES public.import_history(id) ON DELETE RESTRICT,
    source_row INTEGER NOT NULL,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    contact_id UUID REFERENCES public.contractor_contacts(id) ON DELETE RESTRICT,
    actor_id UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    evidence JSONB NOT NULL,
    UNIQUE(import_run_id,source_row)
);
ALTER TABLE public.procore_import_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procore_vendor_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.procore_import_lineage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.procore_import_runs,public.procore_vendor_mappings,public.procore_import_lineage
    FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.procore_import_runs TO service_role;
GRANT SELECT ON public.procore_vendor_mappings,public.procore_import_lineage TO service_role;

CREATE FUNCTION public.procore_require_actor(p_actor UUID,p_write BOOLEAN DEFAULT false,p_add BOOLEAN DEFAULT false)
RETURNS public.user_profiles LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.user_profiles;
BEGIN
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active';
    IF actor.auth_user_id IS NULL OR (NOT coalesce(actor.system_administrator,false) AND EXISTS(
        SELECT 1 FROM (VALUES('imports'),('contractors'),('projects')) modules(module)
        WHERE NOT EXISTS(SELECT 1 FROM role_permissions p WHERE p.role=actor.role AND p.module=modules.module
            AND p.can_view AND (NOT p_write OR
                (CASE WHEN modules.module='contractors' THEN p.can_manage AND (NOT p_add OR p.can_add)
                    ELSE p.can_add AND p.can_edit END))))) THEN
        RAISE EXCEPTION 'Procore import permission denied' USING ERRCODE='42501';
    END IF;
    RETURN actor;
END;
$$;

CREATE FUNCTION public.procore_import_reference() RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
    WITH state AS (SELECT jsonb_build_object(
        'contractors',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM
            (SELECT id,company_name,active FROM contractors) c),'[]'::jsonb),
        'projects',coalesce((SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM
            (SELECT id,project_number,project_name FROM projects) p),'[]'::jsonb),
        'vendors',coalesce((SELECT jsonb_agg(to_jsonb(v) ORDER BY vendor_key) FROM procore_vendor_mappings v),'[]'::jsonb),
        'contacts',coalesce((SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM
            (SELECT id,contractor_id,contact_name,email,business_phone,mobile_phone,is_active FROM contractor_contacts) c),'[]'::jsonb)
    ) value)
    SELECT value || jsonb_build_object('token',md5(value::text)) FROM state;
$$;

CREATE FUNCTION public.procore_import_audit(p_actor UUID,p_run UUID,p_action TEXT,p_details JSONB) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.user_profiles;
BEGIN
    SELECT * INTO STRICT actor FROM user_profiles WHERE auth_user_id=p_actor;
    INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
    VALUES(p_actor,actor.name,actor.email,p_action,'procore_import',p_run::text,'Procore import',
        p_details || jsonb_build_object('import_run_id',p_run,'source','PROCORE'));
END;
$$;

CREATE FUNCTION public.procore_save_review(p_run UUID,p_revision INTEGER,p_decisions JSONB,p_actor UUID)
RETURNS public.procore_import_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE run public.procore_import_runs;
BEGIN
    PERFORM procore_require_actor(p_actor,true);
    SELECT * INTO STRICT run FROM procore_import_runs WHERE id=p_run FOR UPDATE;
    IF run.revision<>p_revision OR run.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'Import changed or is Finalized; reload before saving' USING ERRCODE='40001';
    END IF;
    IF jsonb_typeof(p_decisions->'vendors') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid review decisions' USING ERRCODE='22023';
    END IF;
    UPDATE procore_import_runs SET decisions=p_decisions,revision=revision+1,updated_at=now()
        WHERE id=p_run RETURNING * INTO run;
    PERFORM procore_import_audit(p_actor,p_run,'PROCORE_REVIEW_SAVED',jsonb_build_object('revision',run.revision,'decisions',p_decisions));
    RETURN run;
END;
$$;

CREATE FUNCTION public.procore_apply_import(p_run UUID,p_revision INTEGER,p_token TEXT,p_plan JSONB,p_actor UUID)
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
    LOCK TABLE contractors,projects,contractor_contacts,procore_vendor_mappings IN SHARE ROW EXCLUSIVE MODE;
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
            IF (SELECT count(*) FROM projects WHERE project_number=assignment->>'number')<>1 OR
                NOT EXISTS(SELECT 1 FROM projects WHERE id=(assignment->>'projectId')::integer AND project_number=assignment->>'number') THEN
                RAISE EXCEPTION 'Project number must match exactly one existing project';
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
                    WHERE (value->>'row')::integer=row_number AND value->>'Project > Number'=assignment->>'number'
                        AND contractor_import_name_key(value->>'Company (Vendor) > Name')=vendor->>'key';
                IF imported @> jsonb_build_array(row_number) THEN RAISE EXCEPTION 'Source row already imported'; END IF;
                INSERT INTO procore_import_lineage(import_run_id,import_history_id,source_row,contractor_id,project_id,contact_id,actor_id,evidence)
                VALUES(p_run,history,row_number,contractor,(assignment->>'projectId')::integer,
                    (contact_ids->>row_number::text)::uuid,p_actor,
                    jsonb_build_object('source_row',source,'prior_ownership_sources',coalesce(to_jsonb(prior_sources),'[]'),
                        'resulting_ownership_sources',resulting.ownership_sources,'assignment_id',resulting.id,'vendor_key',vendor->>'key'));
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

CREATE FUNCTION public.procore_finalize_import(p_run UUID,p_revision INTEGER,p_token TEXT,p_review JSONB,p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE run public.procore_import_runs; stats JSONB;
BEGIN
    PERFORM procore_require_actor(p_actor,true);
    PERFORM pg_advisory_xact_lock(hashtext('procore_manual_import'));
    SELECT * INTO STRICT run FROM procore_import_runs WHERE id=p_run FOR UPDATE;
    IF run.revision<>p_revision OR run.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'Import changed or is Finalized; reload before closing' USING ERRCODE='40001';
    END IF;
    LOCK TABLE contractors,projects,contractor_contacts,procore_vendor_mappings IN SHARE MODE;
    IF p_token IS DISTINCT FROM procore_import_reference()->>'token' THEN
        RAISE EXCEPTION 'Reference data changed; reload finalization review' USING ERRCODE='40001';
    END IF;
    IF jsonb_typeof(p_review->'preview'->'summary') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Frozen review is required'; END IF;
    stats:=(p_review->'preview'->'summary') || jsonb_build_object('importedRows',jsonb_array_length(run.imported_rows),
        'notImportedRows',run.source_row_count-jsonb_array_length(run.imported_rows));
    UPDATE procore_import_runs SET finalized_at=now(),finalized_by=p_actor,closeout=stats,
        finalized_review=p_review,updated_at=now(),revision=revision+1 WHERE id=p_run;
    PERFORM procore_import_audit(p_actor,p_run,'PROCORE_IMPORT_FINALIZED',jsonb_build_object('import_history_id',run.import_history_id,
        'closeout',stats,'ownership_changed',false,'portfolio_reconciled',false));
    RETURN jsonb_build_object('id',p_run,'finalized_at',now(),'closeout',stats);
END;
$$;

CREATE FUNCTION public.procore_list_import_runs(p_finalized BOOLEAN,p_offset INTEGER,p_actor UUID) RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
BEGIN
    PERFORM procore_require_actor(p_actor);
    IF p_offset<0 THEN RAISE EXCEPTION 'Invalid history offset'; END IF;
    RETURN coalesce((SELECT jsonb_agg(to_jsonb(r) ORDER BY created_at DESC,id) FROM (
        SELECT id,file_name,revision,created_at,status,source_row_count,last_imported_at,finalized_at,closeout
        FROM procore_import_runs WHERE (finalized_at IS NOT NULL)=p_finalized
        ORDER BY created_at DESC,id LIMIT 20 OFFSET p_offset) r),'[]'::jsonb);
END;
$$;

REVOKE ALL ON FUNCTION public.procore_require_actor(UUID,BOOLEAN,BOOLEAN),public.procore_import_audit(UUID,UUID,TEXT,JSONB)
    FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.procore_import_reference(),public.procore_save_review(UUID,INTEGER,JSONB,UUID),
    public.procore_apply_import(UUID,INTEGER,TEXT,JSONB,UUID),public.procore_finalize_import(UUID,INTEGER,TEXT,JSONB,UUID),
    public.procore_list_import_runs(BOOLEAN,INTEGER,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.procore_import_reference(),public.procore_save_review(UUID,INTEGER,JSONB,UUID),
    public.procore_apply_import(UUID,INTEGER,TEXT,JSONB,UUID),public.procore_finalize_import(UUID,INTEGER,TEXT,JSONB,UUID),
    public.procore_list_import_runs(BOOLEAN,INTEGER,UUID) TO service_role;

COMMIT;
