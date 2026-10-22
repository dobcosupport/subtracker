BEGIN;

ALTER TABLE public.mycoi_import_runs
    ADD COLUMN finalized_at TIMESTAMPTZ,
    ADD COLUMN finalized_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    ADD COLUMN closeout JSONB,
    ADD COLUMN finalized_review JSONB,
    ADD COLUMN artifacts_purged_at TIMESTAMPTZ,
    ADD CONSTRAINT mycoi_finalization_metadata CHECK (
        (finalized_at IS NULL AND finalized_by IS NULL AND closeout IS NULL
            AND finalized_review IS NULL AND artifacts_purged_at IS NULL)
        OR (finalized_at IS NOT NULL AND finalized_by IS NOT NULL AND closeout IS NOT NULL AND jsonb_typeof(closeout) = 'object'
            AND ((artifacts_purged_at IS NULL AND finalized_review IS NOT NULL AND jsonb_typeof(finalized_review) = 'object')
                OR (artifacts_purged_at IS NOT NULL AND finalized_review IS NULL)))
    );
CREATE INDEX mycoi_import_runs_finalized ON public.mycoi_import_runs(finalized_at DESC,id)
    WHERE finalized_at IS NOT NULL;

CREATE FUNCTION public.mycoi_guard_finalized_import() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    IF OLD.finalized_at IS NOT NULL THEN
        -- Only the explicit service cleanup may clear expired import-only payloads.
        IF current_setting('subtracker.mycoi_artifact_cleanup',true) IS DISTINCT FROM OLD.id::text
            OR OLD.artifacts_purged_at IS NOT NULL OR NEW.artifacts_purged_at IS NULL
            OR OLD.finalized_at > now() - interval '12 months'
            OR NEW.source_rows <> '[]'::jsonb OR NEW.imported_rows <> '[]'::jsonb
            OR NEW.decisions <> '{"vendors":{},"divisions":{},"contacts":{},"ignored":[],"addContractors":[]}'::jsonb
            OR NEW.finalized_review IS NOT NULL
            OR (to_jsonb(NEW) - ARRAY['source_rows','source_row_count','decisions','imported_rows','finalized_review','artifacts_purged_at','updated_at'])
                IS DISTINCT FROM
               (to_jsonb(OLD) - ARRAY['source_rows','source_row_count','decisions','imported_rows','finalized_review','artifacts_purged_at','updated_at']) THEN
            RAISE EXCEPTION 'Finalized imports are read-only' USING ERRCODE='40001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER mycoi_import_runs_finalized BEFORE UPDATE ON public.mycoi_import_runs
    FOR EACH ROW EXECUTE FUNCTION public.mycoi_guard_finalized_import();

CREATE FUNCTION public.mycoi_finalize_import(
    p_run UUID,p_revision INTEGER,p_token TEXT,p_closeout JSONB,p_review JSONB,p_actor UUID
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    run public.mycoi_import_runs;
    actor public.user_profiles;
    field TEXT;
    result JSONB;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mycoi_manual_import'));
    SELECT * INTO actor FROM user_profiles WHERE auth_user_id=p_actor AND status='Active';
    IF NOT FOUND OR NOT (actor.system_administrator OR NOT EXISTS (
        SELECT 1 FROM (VALUES ('imports','view'),('imports','add'),('imports','edit'),
            ('insurance','view'),('insurance','add'),('insurance','edit'),('contractors','view'),('projects','view')) needed(module,action)
        WHERE NOT EXISTS (SELECT 1 FROM role_permissions r WHERE r.role=actor.role AND r.module=needed.module
            AND CASE needed.action WHEN 'view' THEN r.can_view WHEN 'add' THEN r.can_add ELSE r.can_edit END)
    )) THEN RAISE EXCEPTION 'Import permissions are required' USING ERRCODE='42501'; END IF;
    SELECT * INTO STRICT run FROM mycoi_import_runs WHERE id=p_run FOR UPDATE;
    IF run.finalized_at IS NOT NULL OR run.revision IS DISTINCT FROM p_revision
        OR (mycoi_import_reference()->>'token') IS DISTINCT FROM p_token THEN
        RAISE EXCEPTION 'Import or reference changed; reload close-out statistics' USING ERRCODE='40001';
    END IF;
    IF p_closeout IS NULL OR jsonb_typeof(p_closeout) <> 'object'
        OR p_review IS NULL OR jsonb_typeof(p_review) <> 'object'
        OR jsonb_typeof(p_review->'preview') IS DISTINCT FROM 'object'
        OR jsonb_typeof(p_review->'contractors') IS DISTINCT FROM 'array'
        OR jsonb_typeof(p_review->'projects') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'Close-out statistics and review snapshot are required' USING ERRCODE='22023';
    END IF;
    FOREACH field IN ARRAY ARRAY['totalRows','totalVendors','matchedExistingVendors','contractorsAdded',
        'unmatchedVendors','stagedContractorsNotCreated','matchedProjects','unresolvedProjects','policiesImported'] LOOP
        IF jsonb_typeof(p_closeout->field) IS DISTINCT FROM 'number' OR (p_closeout->>field) !~ '^[0-9]+$' THEN
            RAISE EXCEPTION 'Invalid close-out statistic: %',field USING ERRCODE='22023';
        END IF;
    END LOOP;
    IF (p_closeout->>'totalRows')::integer <> run.source_row_count
        OR (p_closeout->>'policiesImported')::integer <> (run.metrics->>'policies')::integer THEN
        RAISE EXCEPTION 'Close-out counts changed; reload' USING ERRCODE='40001';
    END IF;
    UPDATE mycoi_import_runs SET finalized_at=now(),finalized_by=p_actor,closeout=p_closeout,
        finalized_review=p_review,revision=revision+1 WHERE id=p_run RETURNING * INTO run;
    result:=jsonb_build_object('id',run.id,'finalized_at',run.finalized_at,'closeout',run.closeout);
    INSERT INTO administration_audit_log(user_id,user_name,user_email,action,object_type,object_id,object_label,details)
        VALUES(p_actor,actor.name,actor.email,'MYCOI_IMPORT_FINALIZED','mycoi_import',p_run::text,run.file_name,
            result || jsonb_build_object('import_history_id',run.import_history_id,'portfolio_reconciled',false));
    RETURN result;
END;
$$;

CREATE FUNCTION public.mycoi_list_import_runs(p_finalized BOOLEAN DEFAULT false,p_offset INTEGER DEFAULT 0)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result JSONB;
BEGIN
    IF p_finalized IS NULL OR p_offset IS NULL OR p_offset<0 THEN
        RAISE EXCEPTION 'Invalid import list scope/offset' USING ERRCODE='22023';
    END IF;
    SELECT coalesce(jsonb_agg(item ORDER BY sort_at DESC,id),'[]'::jsonb) INTO result FROM (
        SELECT r.id,coalesce(r.finalized_at,r.created_at) sort_at,
            jsonb_build_object('id',r.id,'file_name',r.file_name,'created_at',r.created_at,'updated_at',r.updated_at,
                'last_imported_at',r.last_imported_at,'status',r.status,'metrics',r.metrics,'revision',r.revision,
                'import_history_id',r.import_history_id,'source_row_count',r.source_row_count,
                'finalized_at',r.finalized_at,'closeout',r.closeout) item
        FROM mycoi_import_runs r
        WHERE (NOT p_finalized AND r.finalized_at IS NULL)
           OR (p_finalized AND r.finalized_at > now() - interval '12 months')
        ORDER BY sort_at DESC,r.id LIMIT 20 OFFSET p_offset
    ) page;
    RETURN result;
END;
$$;

-- Deliberately unscheduled. Retain the run row and every downstream business/audit reference.
CREATE FUNCTION public.mycoi_purge_import_artifacts(p_run UUID) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
    run public.mycoi_import_runs;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('mycoi_manual_import'));
    LOCK TABLE mycoi_import_runs IN SHARE ROW EXCLUSIVE MODE;
    SELECT * INTO STRICT run FROM mycoi_import_runs WHERE id=p_run FOR UPDATE;
    IF run.finalized_at IS NULL OR run.finalized_at > now() - interval '12 months'
        OR run.closeout IS NULL OR NOT (run.closeout ? 'totalRows') THEN
        RAISE EXCEPTION 'Only finalized imports beyond 12 months with retained close-out metadata may be cleaned'
            USING ERRCODE='23514';
    END IF;
    IF run.artifacts_purged_at IS NOT NULL THEN
        RETURN jsonb_build_object('id',run.id,'artifacts_purged_at',run.artifacts_purged_at,'already_purged',true);
    END IF;
    IF EXISTS(
        SELECT 1 FROM pg_constraint c JOIN pg_attribute a
            ON a.attrelid=c.confrelid AND a.attnum=ANY(c.confkey)
        WHERE c.contype='f' AND c.confrelid='public.mycoi_import_runs'::regclass
            AND a.attname=ANY(ARRAY['source_rows','source_row_count','decisions','imported_rows','finalized_review'])
    ) THEN
        RAISE EXCEPTION 'Import artifacts have dependent foreign keys; cleanup refused' USING ERRCODE='23503';
    END IF;
    PERFORM set_config('subtracker.mycoi_artifact_cleanup',run.id::text,true);
    UPDATE mycoi_import_runs SET source_rows='[]',imported_rows='[]',
        decisions='{"vendors":{},"divisions":{},"contacts":{},"ignored":[],"addContractors":[]}',
        finalized_review=NULL,artifacts_purged_at=now() WHERE id=p_run;
    PERFORM set_config('subtracker.mycoi_artifact_cleanup','',true);
    INSERT INTO administration_audit_log(user_name,user_email,action,object_type,object_id,object_label,details)
        VALUES('Service cleanup','service','MYCOI_IMPORT_ARTIFACTS_PURGED','mycoi_import',p_run::text,run.file_name,
            jsonb_build_object('finalized_at',run.finalized_at,'purged_at',now(),'closeout',run.closeout,
                'import_history_id',run.import_history_id,'retained_run_metadata',true));
    RETURN jsonb_build_object('id',run.id,'artifacts_purged_at',now(),'already_purged',false);
END;
$$;
REVOKE ALL ON FUNCTION public.mycoi_guard_finalized_import(),
    public.mycoi_finalize_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID),
    public.mycoi_list_import_runs(BOOLEAN,INTEGER),public.mycoi_purge_import_artifacts(UUID) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.mycoi_finalize_import(UUID,INTEGER,TEXT,JSONB,JSONB,UUID),
    public.mycoi_list_import_runs(BOOLEAN,INTEGER),public.mycoi_purge_import_artifacts(UUID) TO service_role;

COMMIT;
