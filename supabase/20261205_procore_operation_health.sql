-- Local preparation only. Coordinate this migration with the new Procore API.
BEGIN;

DO $$
DECLARE definition TEXT; message TEXT;
BEGIN
    SELECT pg_get_functiondef('public.procore_apply_import(uuid,integer,text,jsonb,uuid)'::regprocedure)
    INTO definition;
    FOREACH message IN ARRAY ARRAY[
        'Import changed or is Finalized; reload before importing',
        'Reference data changed; reload review',
        'Add Contractor requires explicit approval and no existing vendor mapping',
        'Different-company review is stale or unverified; review again',
        'Duplicate-name override is stale or unverified; review again',
        'Add Contractor requires explicit duplicate-name override approval',
        'Ambiguous contact changed; reload review'
    ] LOOP
        definition := replace(definition,
            format('RAISE EXCEPTION %L USING ERRCODE=''40001''', message),
            format('RAISE EXCEPTION %L USING ERRCODE=''PT409''', message));
    END LOOP;
    IF definition NOT LIKE '%Import changed or is Finalized; reload before importing'' USING ERRCODE=''PT409''%'
       OR definition LIKE '%40001%' THEN
        RAISE EXCEPTION 'Unexpected Procore apply definition; review conflict semantics before installing health controls';
    END IF;
    EXECUTE definition;
END;
$$;

CREATE TABLE public.procore_import_operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id UUID NOT NULL REFERENCES public.procore_import_runs(id),
    revision INTEGER NOT NULL,
    actor_id UUID NOT NULL REFERENCES public.user_profiles(auth_user_id),
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','stopping','succeeded','failed','stopped','timed_out','unknown')),
    started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    deadline_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp() + INTERVAL '120 seconds',
    finished_at TIMESTAMPTZ,
    stop_requested_at TIMESTAMPTZ,
    stop_requested_by UUID REFERENCES public.user_profiles(auth_user_id),
    error_code TEXT,
    diagnostic TEXT,
    CHECK ((stop_requested_at IS NULL) = (stop_requested_by IS NULL))
);
CREATE UNIQUE INDEX procore_one_open_operation ON public.procore_import_operations(run_id)
    WHERE status IN ('running','stopping');
CREATE INDEX procore_operation_history ON public.procore_import_operations(started_at DESC);
ALTER TABLE public.procore_import_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.procore_import_operations FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.procore_operation_active(p_operation UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
        WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
          AND a.application_name='subtracker:procore:' || p_operation::text
          AND a.state='active' AND a.query LIKE '%"public"."procore_execute_operation"%'
          AND l.locktype='advisory' AND l.granted AND l.objsubid=2
          AND l.classid=((hashtext('subtracker_procore_operation')::bigint & 4294967295)::oid)
          AND l.objid=((hashtext(p_operation::text)::bigint & 4294967295)::oid)
    );
$$;

CREATE FUNCTION public.procore_health_admin(p_actor UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE actor public.user_profiles;
BEGIN
    actor := public.procore_require_actor(p_actor,true);
    IF NOT (coalesce(actor.system_administrator,false) OR actor.role='Administrator') THEN
        RAISE EXCEPTION 'Procore health controls require an Administrator' USING ERRCODE='42501';
    END IF;
END;
$$;

CREATE FUNCTION public.procore_begin_operation(p_run UUID,p_revision INTEGER,p_actor UUID)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET statement_timeout='5s' SET lock_timeout='2s' AS $$
DECLARE run public.procore_import_runs; operation UUID; previous public.procore_import_operations;
BEGIN
    PERFORM public.procore_require_actor(p_actor,true);
    PERFORM pg_advisory_xact_lock(hashtext('subtracker_procore_begin'),hashtext(p_run::text));
    SELECT * INTO STRICT run FROM public.procore_import_runs WHERE id=p_run;
    IF run.revision<>p_revision OR run.finalized_at IS NOT NULL THEN
        RAISE EXCEPTION 'Import changed or is Finalized; reload before importing' USING ERRCODE='PT409';
    END IF;
    FOR previous IN SELECT * FROM public.procore_import_operations
        WHERE run_id=p_run AND status IN ('running','stopping') FOR UPDATE LOOP
        IF previous.deadline_at >= clock_timestamp() OR public.procore_operation_active(previous.id) THEN
            RAISE EXCEPTION 'A Procore operation is already outstanding for this import. Refresh Import Status.'
                USING ERRCODE='PT409';
        END IF;
        UPDATE public.procore_import_operations SET status='unknown',finished_at=clock_timestamp(),
            last_activity_at=clock_timestamp(),diagnostic='Request expired without a recorded outcome. Reload the saved review before another import.'
        WHERE id=previous.id;
    END LOOP;
    INSERT INTO public.procore_import_operations(run_id,revision,actor_id)
    VALUES(p_run,p_revision,p_actor) RETURNING id INTO operation;
    RETURN operation;
END;
$$;

CREATE FUNCTION public.procore_operation_checkpoint(p_operation UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE operation public.procore_import_operations;
BEGIN
    SELECT * INTO STRICT operation FROM public.procore_import_operations WHERE id=p_operation;
    IF operation.stop_requested_at IS NOT NULL THEN
        RAISE EXCEPTION 'Stopped by Administrator' USING ERRCODE='PCSTP';
    END IF;
    IF clock_timestamp() >= operation.deadline_at THEN
        RAISE EXCEPTION 'Procore operation exceeded its 120-second deadline' USING ERRCODE='57014';
    END IF;
END;
$$;

CREATE FUNCTION public.procore_execute_operation(
    p_operation UUID,p_run UUID,p_revision INTEGER,p_token TEXT,p_plan JSONB,p_actor UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET statement_timeout='120s' SET lock_timeout='5s' AS $$
DECLARE operation public.procore_import_operations; result JSONB; code TEXT; message TEXT; outcome TEXT;
BEGIN
    PERFORM public.procore_require_actor(p_actor,true);
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'Procore cooperative stop requires read committed isolation' USING ERRCODE='PT409';
    END IF;
    IF NOT pg_try_advisory_xact_lock(hashtext('subtracker_procore_operation'),hashtext(p_operation::text)) THEN
        RAISE EXCEPTION 'This Procore operation is already executing' USING ERRCODE='PT409';
    END IF;
    SELECT * INTO STRICT operation FROM public.procore_import_operations WHERE id=p_operation;
    IF operation.run_id<>p_run OR operation.revision<>p_revision OR operation.actor_id<>p_actor
       OR operation.status NOT IN ('running','stopping') THEN
        RAISE EXCEPTION 'Procore operation does not match this request or is already finished' USING ERRCODE='PT409';
    END IF;
    PERFORM set_config('application_name','subtracker:procore:' || p_operation::text,true);
    BEGIN
        PERFORM public.procore_operation_checkpoint(p_operation);
        result := public.procore_apply_import(p_run,p_revision,p_token,p_plan,p_actor);
        -- Serialize final commit versus an administrator stop; all business writes
        -- stay inside this subtransaction until the final stop/deadline check.
        PERFORM 1 FROM public.procore_import_operations WHERE id=p_operation FOR UPDATE;
        PERFORM public.procore_operation_checkpoint(p_operation);
        outcome := 'succeeded';
    EXCEPTION WHEN query_canceled OR OTHERS THEN
        GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE, message=MESSAGE_TEXT;
        result := NULL;
        IF code='PCSTP' THEN outcome:='stopped'; message:='Stopped by Administrator';
        ELSIF code='57014' THEN
            IF EXISTS(SELECT 1 FROM public.procore_import_operations WHERE id=p_operation AND stop_requested_at IS NOT NULL) THEN
                outcome:='stopped'; code:='PCSTP'; message:='Stopped by Administrator at the transaction timeout. No import changes were committed.';
            ELSE
                outcome:='timed_out'; message:='Procore transaction timed out. No import changes were committed. Reload the review before retrying.';
            END IF;
        ELSIF code='PT409' THEN outcome:='failed';
        ELSIF code='40001' THEN
            outcome:='failed'; code:='PT409';
            message:='Procore transaction could not complete safely. No import changes were committed. Reload the review before retrying.';
        ELSE
            outcome:='failed';
            message:='Procore import failed (SQLSTATE ' || code || '). No import changes were committed. Reload the review.';
        END IF;
    END;
    UPDATE public.procore_import_operations SET status=outcome,finished_at=clock_timestamp(),
        last_activity_at=clock_timestamp(),error_code=code,diagnostic=message WHERE id=p_operation;
    RETURN jsonb_build_object('operationId',p_operation,'ok',outcome='succeeded','result',result,
        'error',CASE WHEN code IS NULL THEN NULL ELSE jsonb_build_object('code',code,'message',message) END);
END;
$$;

CREATE FUNCTION public.procore_operation_health(p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp SET statement_timeout='5s' AS $$
DECLARE operations JSONB; untracked BOOLEAN; state TEXT;
BEGIN
    PERFORM public.procore_health_admin(p_actor);
    SELECT coalesce(jsonb_agg(row_to_json(o) ORDER BY (o.status IN ('running','stopping')) DESC,
        o.started_at DESC),'[]'::jsonb) INTO operations
    FROM (
        SELECT op.id,op.run_id,op.revision,op.status,op.started_at,op.last_activity_at,op.deadline_at,
            op.finished_at,op.stop_requested_at,op.stop_requested_by,op.error_code,op.diagnostic,
            public.procore_operation_active(op.id) AS executing,
            (op.status='running' AND public.procore_operation_active(op.id)
                AND clock_timestamp() > op.started_at + INTERVAL '60 seconds') AS can_stop,
            CASE WHEN public.procore_operation_active(op.id) THEN 'Atomic database transaction'
                WHEN op.status IN ('running','stopping') THEN 'Awaiting execution or outcome confirmation'
                ELSE 'Finished' END AS stage
        FROM public.procore_import_operations op
        ORDER BY (op.status IN ('running','stopping')) DESC,op.started_at DESC LIMIT 20
    ) o;
    SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity a
        WHERE a.datname=current_database() AND a.pid<>pg_backend_pid() AND a.state<>'idle'
          AND (a.query LIKE '%"public"."procore_apply_import"%'
            OR (a.query LIKE '%"public"."procore_execute_operation"%'
                AND a.query_start < clock_timestamp()-INTERVAL '5 seconds'))
          AND NOT EXISTS (SELECT 1 FROM public.procore_import_operations op
              WHERE a.application_name='subtracker:procore:' || op.id::text
                AND public.procore_operation_active(op.id))
    ) INTO untracked;
    state := CASE
        WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(operations) o WHERE o->>'status'='stopping') THEN 'stopping'
        WHEN untracked OR EXISTS(SELECT 1 FROM jsonb_array_elements(operations) o WHERE (o->>'can_stop')::boolean) THEN 'abnormal'
        WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(operations) o WHERE (o->>'executing')::boolean) THEN 'running'
        WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(operations) o WHERE o->>'status' IN ('running','stopping'))
            OR operations->0->>'status' IN ('failed','timed_out','unknown') THEN 'attention'
        ELSE 'healthy' END;
    RETURN jsonb_build_object('state',state,'observedAt',clock_timestamp(),'operations',operations,
        'untrackedActivity',untracked,'timeoutSeconds',120,'reviewThresholdSeconds',60);
END;
$$;

CREATE FUNCTION public.procore_request_operation_stop(p_operation UUID,p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp
SET statement_timeout='5s' SET lock_timeout='2s' AS $$
DECLARE operation public.procore_import_operations;
BEGIN
    PERFORM public.procore_health_admin(p_actor);
    SELECT * INTO operation FROM public.procore_import_operations WHERE id=p_operation FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Procore operation not found. Refresh Import Status.' USING ERRCODE='PT404';
    END IF;
    IF operation.status='stopping' THEN
        RETURN jsonb_build_object('operationId',operation.id,'status','stopping','alreadyRequested',true);
    END IF;
    IF operation.status<>'running' OR clock_timestamp() <= operation.started_at + INTERVAL '60 seconds'
       OR NOT public.procore_operation_active(operation.id) THEN
        RAISE EXCEPTION 'No safely identified abnormal Procore operation is available to stop. Refresh Import Status.'
            USING ERRCODE='PT409';
    END IF;
    UPDATE public.procore_import_operations SET status='stopping',stop_requested_at=clock_timestamp(),
        stop_requested_by=p_actor,last_activity_at=clock_timestamp(),
        diagnostic='Administrator requested cooperative stop; waiting for a checked transaction boundary or timeout.'
    WHERE id=operation.id;
    PERFORM public.procore_import_audit(p_actor,operation.run_id,'PROCORE_OPERATION_STOP_REQUESTED',
        jsonb_build_object('operation_id',operation.id,'reason','Execution exceeded the 60-second review threshold'));
    RETURN jsonb_build_object('operationId',operation.id,'status','stopping','alreadyRequested',false);
END;
$$;

-- Only the bounded wrapper can apply imports through the API. Internal helpers
-- and the operation table are not directly exposed to any API role.
REVOKE ALL ON FUNCTION public.procore_apply_import(UUID,INTEGER,TEXT,JSONB,UUID)
    FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.procore_operation_active(UUID),
    public.procore_health_admin(UUID),public.procore_operation_checkpoint(UUID),
    public.procore_begin_operation(UUID,INTEGER,UUID),
    public.procore_execute_operation(UUID,UUID,INTEGER,TEXT,JSONB,UUID),
    public.procore_operation_health(UUID),public.procore_request_operation_stop(UUID,UUID)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.procore_begin_operation(UUID,INTEGER,UUID),
    public.procore_execute_operation(UUID,UUID,INTEGER,TEXT,JSONB,UUID),
    public.procore_operation_health(UUID),public.procore_request_operation_stop(UUID,UUID)
    TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
