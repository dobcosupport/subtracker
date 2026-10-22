-- Defines a scoped proposal and correction only. Does not execute the correction.
BEGIN;

CREATE TABLE public.mycoi_ownership_correction_receipts (
    correction_key TEXT PRIMARY KEY CHECK (correction_key='compliance3-import-ownership-omission-v1'),
    import_run_id UUID NOT NULL REFERENCES public.mycoi_import_runs(id) ON DELETE RESTRICT,
    import_history_id INTEGER NOT NULL REFERENCES public.import_history(id) ON DELETE RESTRICT,
    proposal_token TEXT NOT NULL,
    applied_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    result JSONB NOT NULL
);
ALTER TABLE public.mycoi_ownership_correction_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mycoi_ownership_correction_receipts FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.mycoi_ownership_correction_receipts TO service_role;

CREATE FUNCTION public.mycoi_compliance3_ownership_proposal() RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    run public.mycoi_import_runs;
    source JSONB;
    frozen_vendors JSONB;
    frozen_divisions JSONB;
    frozen_contractor INTEGER;
    frozen_project INTEGER;
    vm public.mycoi_vendor_mappings;
    dm public.mycoi_division_mappings;
    cd public.mycoi_contractor_divisions;
    vendor_key TEXT;
    division_key TEXT;
    reason TEXT;
    audits JSONB;
    mapping_audits JSONB;
    policies JSONB;
    review_issues JSONB;
    evidence JSONB := '[]';
    pairs JSONB;
    excluded JSONB;
    proposal JSONB;
BEGIN
    SELECT * INTO STRICT run FROM mycoi_import_runs
        WHERE id='d621b20f-109b-432e-b5c4-6739b80d02b1';
    IF run.file_name <> 'Compliance(3).xlsx' OR run.import_history_id IS DISTINCT FROM 10
        OR run.finalized_at IS NULL OR run.artifacts_purged_at IS NOT NULL
        OR jsonb_typeof(run.finalized_review->'preview'->'vendors') IS DISTINCT FROM 'array'
        OR jsonb_typeof(run.finalized_review->'preview'->'divisions') IS DISTINCT FROM 'array'
        OR NOT EXISTS (SELECT 1 FROM import_history WHERE id=10 AND file_name=run.file_name) THEN
        RAISE EXCEPTION 'Retained finalized Compliance(3) evidence is required';
    END IF;
    IF EXISTS (SELECT 1 FROM project_source_snapshots s WHERE s.source='MYCOI'
        AND s.accepted_at >= run.last_imported_at) THEN
        RAISE EXCEPTION 'A subsequent COMPLETE snapshot requires separate review; historical correction blocked';
    END IF;
    FOR source IN SELECT value FROM jsonb_array_elements(run.source_rows) LOOP
        vendor_key := lower(btrim(source->>'Vendor Name'));
        division_key := lower(btrim(source->>'Division Name'));
        SELECT coalesce(jsonb_agg(v),'[]') INTO frozen_vendors
            FROM jsonb_array_elements(run.finalized_review->'preview'->'vendors') v
            WHERE v->>'key'=vendor_key AND v->'rows' @> jsonb_build_array(source);
        SELECT coalesce(jsonb_agg(d),'[]') INTO frozen_divisions
            FROM jsonb_array_elements(run.finalized_review->'preview'->'divisions') d
            WHERE d->>'key'=division_key;
        frozen_contractor := CASE WHEN jsonb_array_length(frozen_vendors)=1
            THEN (frozen_vendors->0->>'contractorId')::integer END;
        frozen_project := CASE WHEN jsonb_array_length(frozen_divisions)=1
            THEN (frozen_divisions->0->>'projectId')::integer END;
        SELECT * INTO vm FROM mycoi_vendor_mappings WHERE active AND vendor_name_key=vendor_key;
        SELECT * INTO dm FROM mycoi_division_mappings WHERE active AND division_name_key=division_key;
        SELECT * INTO cd FROM mycoi_contractor_divisions WHERE vendor_mapping_id=vm.id
            AND division_mapping_id=dm.id AND active AND is_current;
        SELECT coalesce(jsonb_agg(a.id ORDER BY a.id),'[]') INTO audits
            FROM administration_audit_log a WHERE object_type='mycoi_import' AND object_id=run.id::text
            AND action='MYCOI_IMPORT_APPLIED' AND audit_date<=run.finalized_at
            AND details->'source_rows' @> jsonb_build_array((source->>'row')::integer);
        SELECT coalesce(jsonb_agg(a.id ORDER BY a.id),'[]') INTO mapping_audits
            FROM administration_audit_log a WHERE object_type='mycoi_import' AND object_id=run.id::text
            AND action='MYCOI_MAPPINGS_ACCEPTED' AND audit_date<=run.finalized_at
            AND EXISTS(SELECT 1 FROM jsonb_array_elements(a.details->'mappings') m
                WHERE (m->>'kind'='vendor' AND lower(btrim(m->>'raw'))=vendor_key)
                    OR (m->>'kind'='division' AND lower(btrim(m->>'raw'))=division_key));
        SELECT coalesce(jsonb_agg(DISTINCT p.id ORDER BY p.id),'[]') INTO policies
            FROM mycoi_policies p JOIN mycoi_policy_divisions l ON l.policy_id=p.id
            WHERE l.contractor_division_id=cd.id AND l.vendor_mapping_id=vm.id
                AND p.contractor_id=frozen_contractor AND p.vendor_mapping_id=vm.id
                AND p.active AND p.is_current AND p.import_history_id=10
                AND p.import_reference='myCOI import ' || run.id::text || ' | ' || run.file_name;
        SELECT coalesce(jsonb_agg(jsonb_build_object('category',i->>'category','reason',i->>'reason')
            ORDER BY i->>'category',i->>'reason'),'[]') INTO review_issues
            FROM jsonb_array_elements(run.finalized_review->'preview'->'issues') i
            WHERE i->'rows' @> jsonb_build_array((source->>'row')::integer);
        reason := CASE
            WHEN run.decisions->'ignored' @> jsonb_build_array((source->>'row')::integer) THEN 'ignored_source_row'
            WHEN NOT run.imported_rows @> jsonb_build_array((source->>'row')::integer) THEN
                CASE WHEN frozen_contractor IS NULL AND frozen_vendors->0->>'addContractor'='true' THEN 'unexecuted_add_not_imported'
                    WHEN frozen_contractor IS NULL THEN 'unmatched_vendor_not_imported'
                    WHEN frozen_project IS NULL THEN 'unresolved_project_not_imported'
                    ELSE 'unresolved_records_not_imported' END
            WHEN jsonb_array_length(audits)=0 THEN 'successful_import_audit_missing'
            WHEN NOT run.imported_vendor_keys @> jsonb_build_array(vendor_key) THEN 'imported_vendor_key_missing'
            WHEN frozen_contractor IS NULL OR frozen_project IS NULL THEN 'frozen_accepted_identity_missing'
            WHEN vm.id IS NULL OR vm.contractor_id IS DISTINCT FROM frozen_contractor
                OR vm.import_history_id IS DISTINCT FROM 10
                OR vm.import_reference IS DISTINCT FROM 'myCOI import ' || run.id::text || ' | ' || run.file_name
                OR vm.updated_at>run.finalized_at THEN 'vendor_mapping_provenance_changed_or_missing'
            WHEN dm.id IS NULL OR dm.project_id IS DISTINCT FROM frozen_project
                OR dm.updated_at>run.finalized_at THEN 'project_mapping_provenance_changed_or_missing'
            WHEN cd.id IS NULL OR cd.import_history_id IS DISTINCT FROM 10
                OR cd.import_reference IS DISTINCT FROM 'myCOI import ' || run.id::text || ' | ' || run.file_name
                OR cd.updated_at>run.finalized_at THEN 'imported_division_provenance_changed_or_missing'
            WHEN NOT EXISTS(SELECT 1 FROM contractors WHERE id=frozen_contractor)
                OR NOT EXISTS(SELECT 1 FROM projects WHERE id=frozen_project) THEN 'referenced_identity_missing'
            WHEN EXISTS(SELECT 1 FROM administration_audit_log a,
                jsonb_array_elements(a.details->'mappings') m
                WHERE a.object_type='mycoi_import' AND a.object_id=run.id::text
                    AND a.action='MYCOI_MAPPINGS_ACCEPTED'
                    AND ((m->>'kind'='vendor' AND lower(btrim(m->>'raw'))=vendor_key
                        AND (m->>'contractor_id')::integer IS DISTINCT FROM frozen_contractor)
                    OR (m->>'kind'='division' AND lower(btrim(m->>'raw'))=division_key
                        AND (m->>'project_id')::integer IS DISTINCT FROM frozen_project))) THEN 'accepted_mapping_audit_conflict'
        END;
        evidence := evidence || jsonb_build_array(jsonb_build_object(
            'source_row',(source->>'row')::integer,'vendor_key',vendor_key,'raw_vendor',source->>'Vendor Name',
            'raw_division',source->>'Division Name','contractor_id',frozen_contractor,'project_id',frozen_project,
            'vendor_mapping_id',vm.id,'division_mapping_id',dm.id,'contractor_division_id',cd.id,
            'import_audit_ids',audits,'mapping_audit_ids',mapping_audits,'current_policy_ids',policies,
            'frozen_review_issues',review_issues,'exclusion_reason',reason));
    END LOOP;
    SELECT coalesce(jsonb_agg(item ORDER BY contractor_id,project_id),'[]') INTO pairs FROM (
        SELECT e.contractor_id,e.project_id,jsonb_build_object(
            'contractor_id',e.contractor_id,'company_name',c.company_name,
            'project_id',e.project_id,'project_number',p.project_number,
            'assignment_id',cp.id,'prior_ownership_sources',coalesce(to_jsonb(cp.ownership_sources),'[]'),
            'resulting_ownership_sources',CASE WHEN cp.mycoi_owned THEN to_jsonb(cp.ownership_sources)
                ELSE coalesce(to_jsonb(cp.ownership_sources),'[]') || '["MYCOI"]'::jsonb END,
            'action',CASE WHEN cp.mycoi_owned THEN 'NO_CHANGE' WHEN cp.id IS NULL THEN 'CREATE_ASSIGNMENT' ELSE 'ADD_MYCOI' END,
            'has_current_policy_links',e.policy_linked,'evidence',e.proofs) item
        FROM (
            SELECT (v->>'contractor_id')::integer contractor_id,(v->>'project_id')::integer project_id,
                bool_or(jsonb_array_length(v->'current_policy_ids')>0) policy_linked,
                jsonb_agg(v ORDER BY (v->>'source_row')::integer) proofs
            FROM jsonb_array_elements(evidence) v WHERE v->>'exclusion_reason' IS NULL GROUP BY 1,2
        ) e JOIN contractors c ON c.id=e.contractor_id JOIN projects p ON p.id=e.project_id
        LEFT JOIN contractor_projects cp ON cp.contractor_id=e.contractor_id AND cp.project_id=e.project_id AND cp.active
    ) grouped;
    SELECT coalesce(jsonb_agg(v ORDER BY (v->>'source_row')::integer),'[]') INTO excluded
        FROM jsonb_array_elements(evidence) v WHERE v->>'exclusion_reason' IS NOT NULL;
    proposal := jsonb_build_object('correction_key','compliance3-import-ownership-omission-v1',
        'import_run_id',run.id,'import_history_id',10,'file_name',run.file_name,'revision',run.revision,
        'finalized_at',run.finalized_at,'pairs',pairs,'excluded_rows',excluded,
        'counts',jsonb_build_object(
            'source_rows',jsonb_array_length(run.source_rows),'imported_source_rows',jsonb_array_length(run.imported_rows),
            'eligible_source_rows',jsonb_array_length(evidence)-jsonb_array_length(excluded),
            'excluded_source_rows',jsonb_array_length(excluded),'eligible_pairs',jsonb_array_length(pairs),
            'eligible_contractors',(SELECT count(DISTINCT v->>'contractor_id') FROM jsonb_array_elements(pairs) v),
            'eligible_projects',(SELECT count(DISTINCT v->>'project_id') FROM jsonb_array_elements(pairs) v),
            'existing_assignments_to_gain',(SELECT count(*) FROM jsonb_array_elements(pairs) v WHERE v->>'action'='ADD_MYCOI'),
            'missing_assignments_to_create',(SELECT count(*) FROM jsonb_array_elements(pairs) v WHERE v->>'action'='CREATE_ASSIGNMENT'),
            'already_correct',(SELECT count(*) FROM jsonb_array_elements(pairs) v WHERE v->>'action'='NO_CHANGE'),
            'policy_linked_pairs',(SELECT count(*) FROM jsonb_array_elements(pairs) v WHERE v->>'has_current_policy_links'='true'),
            'division_only_pairs',(SELECT count(*) FROM jsonb_array_elements(pairs) v WHERE v->>'has_current_policy_links'='false')));
    RETURN proposal || jsonb_build_object('proposal_token',md5(proposal::text));
END;
$$;
REVOKE ALL ON FUNCTION public.mycoi_compliance3_ownership_proposal() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mycoi_compliance3_ownership_proposal() TO service_role;

CREATE FUNCTION public.mycoi_correct_compliance3_ownership(p_actor UUID,p_proposal_token TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    actor public.user_profiles;
    receipt public.mycoi_ownership_correction_receipts;
    proposal JSONB;
    pair JSONB;
    assignment public.contractor_projects;
    result JSONB;
    additions INTEGER := 0;
    correction_reason TEXT := 'MYCOI project ownership omitted by the earlier Import behavior; additive retained Compliance(3) correction';
BEGIN
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active'
        AND (system_administrator OR (role='Administrator' AND NOT EXISTS(
            SELECT 1 FROM (VALUES ('imports'),('insurance'),('projects')) required(module)
            WHERE NOT EXISTS(SELECT 1 FROM role_permissions p WHERE p.role=user_profiles.role
                AND p.module=required.module AND p.can_view AND p.can_add AND p.can_edit))));
    IF actor.auth_user_id IS NULL THEN
        RAISE EXCEPTION 'An active authorized administrator is required' USING ERRCODE='42501';
    END IF;
    IF p_proposal_token IS NULL OR p_proposal_token !~ '^[0-9a-f]{32}$' THEN
        RAISE EXCEPTION 'A reviewed proposal token is required' USING ERRCODE='22023';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('mycoi_manual_import'));
    PERFORM pg_advisory_xact_lock(hashtext('contractor_project_ownership'));
    SELECT * INTO receipt FROM mycoi_ownership_correction_receipts
        WHERE correction_key='compliance3-import-ownership-omission-v1';
    IF FOUND THEN
        IF receipt.proposal_token<>p_proposal_token THEN
            RAISE EXCEPTION 'Correction already applied with a different reviewed proposal' USING ERRCODE='40001';
        END IF;
        RETURN receipt.result || jsonb_build_object('replayed',true);
    END IF;
    -- Prevent non-cooperating writers from changing retained proof or membership during validation/writes.
    LOCK TABLE mycoi_import_runs,mycoi_vendor_mappings,mycoi_division_mappings,mycoi_contractor_divisions,
        mycoi_policies,mycoi_policy_divisions,contractors,projects,project_source_snapshots,import_history IN SHARE MODE;
    LOCK TABLE administration_audit_log IN SHARE ROW EXCLUSIVE MODE;
    LOCK TABLE contractor_projects IN SHARE ROW EXCLUSIVE MODE;
    proposal := mycoi_compliance3_ownership_proposal();
    IF proposal->>'proposal_token'<>p_proposal_token THEN
        RAISE EXCEPTION 'Proposal evidence or ownership changed; recalculate and review before correction' USING ERRCODE='40001';
    END IF;
    PERFORM set_config('subtracker.assignment_actor',p_actor::text,true);
    PERFORM set_config('subtracker.assignment_import','10',true);
    FOR pair IN SELECT value FROM jsonb_array_elements(proposal->'pairs') LOOP
        IF pair->>'action'='NO_CHANGE' THEN CONTINUE; END IF;
        assignment := set_project_assignment_source((pair->>'contractor_id')::integer,(pair->>'project_id')::integer,'MYCOI',true);
        IF to_jsonb(assignment.ownership_sources) IS DISTINCT FROM pair->'resulting_ownership_sources' THEN
            RAISE EXCEPTION 'Unexpected ownership result; entire correction rolled back';
        END IF;
        INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
            VALUES(p_actor,actor.name,actor.email,'MYCOI_PROJECT_OWNERSHIP_CORRECTED','contractor_project',assignment.id::text,
                'Compliance(3) additive MYCOI ownership correction',pair || jsonb_build_object(
                    'assignment_id',assignment.id,'source','MYCOI','change','ADDED',
                    'correction_key',proposal->>'correction_key','import_run_id',proposal->>'import_run_id',
                    'import_history_id',10,'proposal_token',p_proposal_token,'actor_id',p_actor,
                    'timestamp',clock_timestamp(),'reason',correction_reason));
        additions := additions+1;
    END LOOP;
    result := jsonb_build_object('correction_key',proposal->>'correction_key','import_run_id',proposal->>'import_run_id',
        'import_history_id',10,'proposal_token',p_proposal_token,'counts',proposal->'counts',
        'ownership_additions',additions,'ownership_removals',0,'actor_id',p_actor,'applied_at',clock_timestamp(),'replayed',false);
    INSERT INTO mycoi_ownership_correction_receipts(correction_key,import_run_id,import_history_id,proposal_token,applied_by,result)
        VALUES(proposal->>'correction_key',(proposal->>'import_run_id')::uuid,10,p_proposal_token,p_actor,result);
    RETURN result;
END;
$$;
REVOKE ALL ON FUNCTION public.mycoi_correct_compliance3_ownership(UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.mycoi_correct_compliance3_ownership(UUID,TEXT) TO service_role;

COMMIT;
