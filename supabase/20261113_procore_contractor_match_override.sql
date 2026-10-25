-- Local proposal only. Do not apply or deploy dependent code before review.
-- No new tables, backfill, import, project matching or ownership-rule changes.
BEGIN;

CREATE FUNCTION public.procore_duplicate_override_valid(p_run UUID,p_key TEXT,p_override JSONB)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
    SELECT coalesce(
        jsonb_typeof(p_override)='object'
        AND (SELECT count(*) FROM contractors WHERE contractor_import_name_key(company_name)=p_key)=1
        AND EXISTS(SELECT 1 FROM contractors WHERE contractor_import_name_key(company_name)=p_key
            AND to_jsonb(id)=p_override->'contractorId' AND company_name=p_override->>'companyName')
        AND EXISTS(SELECT 1 FROM administration_audit_log a WHERE a.object_type='procore_import'
            AND a.object_id=p_run::text AND a.action='PROCORE_REVIEW_SAVED'
            AND a.user_id::text=p_override->>'approvedBy'
            AND to_jsonb(a.audit_date)=p_override->'approvedAt'
            AND a.details->'decisions'->'vendors'->p_key->'duplicateOverride'=p_override),false);
$$;

CREATE OR REPLACE FUNCTION public.procore_save_review(p_run UUID,p_revision INTEGER,p_decisions JSONB,p_actor UUID)
RETURNS public.procore_import_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE run public.procore_import_runs; key TEXT; choice JSONB; approval JSONB; previous JSONB;
BEGIN
    PERFORM procore_require_actor(p_actor,true);
    PERFORM pg_advisory_xact_lock(hashtext('procore_manual_import'));
    SELECT * INTO STRICT run FROM procore_import_runs WHERE id=p_run FOR UPDATE;
    IF run.revision<>p_revision OR run.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'Import changed or is Finalized; reload before saving' USING ERRCODE='40001';
    END IF;
    IF jsonb_typeof(p_decisions->'vendors') IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'Invalid review decisions' USING ERRCODE='22023';
    END IF;
    LOCK TABLE contractors,procore_vendor_mappings IN SHARE ROW EXCLUSIVE MODE;
    FOR key,choice IN SELECT * FROM jsonb_each(p_decisions->'vendors') LOOP
        IF choice ? 'duplicateOverride' THEN
            approval:=choice->'duplicateOverride';
            previous:=run.decisions->'vendors'->key;
            IF choice->>'action' IS DISTINCT FROM 'ADD' OR jsonb_typeof(approval) IS DISTINCT FROM 'object' THEN
                RAISE EXCEPTION 'Invalid duplicate-name override' USING ERRCODE='22023';
            END IF;
            IF previous->>'action'='ADD' AND previous->'duplicateOverride'->'contractorId'=approval->'contractorId'
                AND previous->'duplicateOverride'->'companyName'=approval->'companyName' THEN
                -- Preserve original approval, including when an unrelated row is saved after this context became stale.
                approval:=previous->'duplicateOverride';
            ELSE
                PERFORM procore_require_actor(p_actor,true,true);
                IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(run.source_rows) r
                    WHERE contractor_import_name_key(r->>'Company (Vendor) > Name')=key)
                    OR EXISTS(SELECT 1 FROM procore_vendor_mappings WHERE vendor_key=key)
                    OR (SELECT count(*) FROM contractors WHERE contractor_import_name_key(company_name)=key)<>1
                    OR NOT EXISTS(SELECT 1 FROM contractors WHERE contractor_import_name_key(company_name)=key
                        AND to_jsonb(id)=approval->'contractorId' AND company_name=approval->>'companyName') THEN
                    RAISE EXCEPTION 'Duplicate-name context changed; reload and review before approving a separate contractor' USING ERRCODE='40001';
                END IF;
                approval:=jsonb_build_object('contractorId',approval->'contractorId','companyName',approval->'companyName',
                    'approvedBy',p_actor,'approvedAt',now());
            END IF;
            p_decisions:=jsonb_set(p_decisions,ARRAY['vendors',key],jsonb_build_object('action','ADD','duplicateOverride',approval));
        END IF;
    END LOOP;
    UPDATE procore_import_runs SET decisions=p_decisions,revision=revision+1,updated_at=now()
        WHERE id=p_run RETURNING * INTO run;
    PERFORM procore_import_audit(p_actor,p_run,'PROCORE_REVIEW_SAVED',jsonb_build_object('revision',run.revision,'decisions',p_decisions));
    RETURN run;
END;
$$;

CREATE OR REPLACE FUNCTION public.procore_apply_import(p_run UUID,p_revision INTEGER,p_token TEXT,p_plan JSONB,p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET TimeZone='UTC' AS $$
DECLARE
    run public.procore_import_runs;
    actor public.user_profiles;
    vendor JSONB; assignment JSONB; contact JSONB; source JSONB;
    company JSONB; contractor INTEGER; history INTEGER; row_number INTEGER; approval JSONB;
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
                OR EXISTS(SELECT 1 FROM procore_vendor_mappings WHERE vendor_key=vendor->>'key') THEN
                RAISE EXCEPTION 'Add Contractor requires explicit approval and no existing vendor mapping' USING ERRCODE='40001';
            END IF;
            approval:=run.decisions->'vendors'->(vendor->>'key')->'duplicateOverride';
            IF approval IS NOT NULL THEN
                IF NOT procore_duplicate_override_valid(p_run,vendor->>'key',approval) THEN
                    RAISE EXCEPTION 'Duplicate-name override is stale or unverified; review again' USING ERRCODE='40001';
                END IF;
            ELSIF EXISTS(SELECT 1 FROM contractors WHERE contractor_import_name_key(company_name)=vendor->>'key') THEN
                RAISE EXCEPTION 'Add Contractor requires explicit duplicate-name override approval' USING ERRCODE='40001';
            END IF;
            INSERT INTO contractors(company_name,phone,address_1,city,state,zip_code,active,creation_source,creation_import_history_id)
            VALUES(company->>'company_name',company->>'phone',company->>'address_1',company->>'city',company->>'state',
                company->>'zip_code',true,'PROCORE',history) RETURNING id INTO contractor;
            created_count:=created_count+1;
            IF approval IS NOT NULL THEN
                PERFORM procore_import_audit(p_actor,p_run,'PROCORE_SEPARATE_CONTRACTOR_CREATED',
                    jsonb_build_object('vendor_key',vendor->>'key','raw_vendor_name',company->>'company_name',
                        'suggested_contractor_id',approval->'contractorId','suggested_contractor_name',approval->>'companyName',
                        'contractor_id',contractor,'approval',approval,'import_history_id',history,'timestamp',now()));
            END IF;
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

REVOKE ALL ON FUNCTION public.procore_duplicate_override_valid(UUID,TEXT,JSONB) FROM PUBLIC,anon,authenticated,service_role;

COMMIT;
