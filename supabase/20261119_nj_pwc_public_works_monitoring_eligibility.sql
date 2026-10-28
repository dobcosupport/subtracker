-- Public Works based NJ PWC monitoring eligibility.
-- Apply after 20261115_nj_pwc_public_works_candidates.sql.
BEGIN;

ALTER TABLE public.nj_pwc_sync_exceptions
    ALTER COLUMN status TYPE VARCHAR(32);

ALTER TABLE public.nj_pwc_sync_exceptions
    ADD COLUMN IF NOT EXISTS monitoring_not_required_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS monitoring_not_required_reason TEXT;

ALTER TABLE public.nj_pwc_sync_exceptions
    DROP CONSTRAINT IF EXISTS nj_pwc_sync_exceptions_status_check;
ALTER TABLE public.nj_pwc_sync_exceptions
    ADD CONSTRAINT nj_pwc_sync_exceptions_status_check
    CHECK (status IN ('open', 'resolved', 'monitoring_not_required'));

CREATE OR REPLACE FUNCTION public.nj_pwc_daily_contractor_eligible(p_contractor_id INTEGER)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.contractors c
        WHERE c.id = p_contractor_id
          AND c.active
          AND nullif(btrim(c.company_name), '') IS NOT NULL
          AND NOT c.material_vendor_only
          AND EXISTS (
              SELECT 1
              FROM public.contractor_projects cp
              JOIN public.projects p ON p.id = cp.project_id
              WHERE cp.contractor_id = c.id
                AND cp.active
                AND p.status = 'Active'
                AND p.public_works IS TRUE
          )
    );
$$;

CREATE OR REPLACE FUNCTION public.nj_pwc_reconcile_monitoring_eligibility(
    p_contractor_id INTEGER DEFAULT NULL,
    p_run_id INTEGER DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_row RECORD;
    v_reason TEXT;
BEGIN
    FOR v_row IN
        SELECT e.id, e.contractor_id, e.is_test, e.reason, c.company_name AS contractor_name,
            c.active, c.material_vendor_only,
            EXISTS (
                SELECT 1 FROM public.contractor_projects cp
                JOIN public.projects p ON p.id = cp.project_id
                WHERE cp.contractor_id = c.id AND cp.active AND p.status = 'Active' AND p.public_works IS TRUE
            ) AS has_public_works_assignment
        FROM public.nj_pwc_sync_exceptions e
        JOIN public.contractors c ON c.id = e.contractor_id
        WHERE e.status = 'open'
          AND (p_contractor_id IS NULL OR e.contractor_id = p_contractor_id)
          AND NOT public.nj_pwc_daily_contractor_eligible(e.contractor_id)
        ORDER BY e.id
        FOR UPDATE OF e
    LOOP
        v_reason := CASE
            WHEN NOT v_row.active THEN 'Contractor is inactive.'
            WHEN nullif(btrim(v_row.contractor_name), '') IS NULL THEN 'Contractor has no valid company name.'
            WHEN v_row.material_vendor_only THEN 'Contractor is classified as Material Only.'
            WHEN NOT v_row.has_public_works_assignment THEN 'No active assignment to an Active Public Works project.'
            ELSE 'Contractor does not currently meet NJ PWC monitoring eligibility.'
        END;
        UPDATE public.nj_pwc_sync_exceptions
        SET status = 'monitoring_not_required',
            monitoring_not_required_at = now(),
            monitoring_not_required_reason = v_reason,
            updated_at = now()
        WHERE id = v_row.id;
        PERFORM public.nj_pwc_write_audit(
            NULL, 'NJ PWC Daily Sync', '',
            public.nj_pwc_audit_action('NJ_PWC_MONITORING_NOT_REQUIRED', v_row.is_test),
            'contractor', v_row.contractor_id::TEXT,
            public.nj_pwc_audit_label(v_row.contractor_name, v_row.is_test),
            jsonb_build_object('exception_id', v_row.id, 'reason', v_row.reason,
                'monitoring_status', 'monitoring_not_required',
                'monitoring_not_required_reason', v_reason)
        );
    END LOOP;

    FOR v_row IN
        SELECT q.id, q.contractor_id, q.is_test, q.sync_run_id, q.origin, c.company_name AS contractor_name
        FROM public.compliance_sync_search_requests q
        JOIN public.contractors c ON c.id = q.contractor_id
        WHERE q.status = 'pending'
          AND q.origin <> 'user'
          AND (p_contractor_id IS NULL OR q.contractor_id = p_contractor_id)
          AND NOT public.nj_pwc_daily_contractor_eligible(q.contractor_id)
        ORDER BY q.id
        FOR UPDATE OF q
    LOOP
        UPDATE public.compliance_sync_search_requests
        SET status = 'cancelled',
            sync_outcome = 'cancelled:monitoring_not_required',
            error_message = 'Contractor no longer meets NJ PWC monitoring eligibility; no registry search was performed.',
            processed_at = now(),
            completed_at = now(),
            updated_at = now()
        WHERE id = v_row.id;
        PERFORM public.nj_pwc_write_audit(
            NULL, 'NJ PWC Daily Sync', '',
            public.nj_pwc_audit_action('NJ_PWC_SEARCH_CANCELLED_NOT_REQUIRED', v_row.is_test),
            'compliance_sync', v_row.id::TEXT,
            public.nj_pwc_audit_label(v_row.contractor_name, v_row.is_test),
            jsonb_build_object('search_request_id', v_row.id, 'sync_run_id', v_row.sync_run_id,
                'contractor_id', v_row.contractor_id, 'origin', v_row.origin,
                'reason', 'Contractor no longer meets NJ PWC monitoring eligibility.')
        );
    END LOOP;

    FOR v_row IN
        SELECT s.contractor_id, s.is_test, s.pending_expiration_run_id,
            c.company_name AS contractor_name, c.active, c.material_vendor_only,
            EXISTS (
                SELECT 1 FROM public.contractor_projects cp
                JOIN public.projects p ON p.id = cp.project_id
                WHERE cp.contractor_id = c.id AND cp.active AND p.status = 'Active' AND p.public_works IS TRUE
            ) AS has_public_works_assignment
        FROM public.nj_pwc_sync_state s
        JOIN public.contractors c ON c.id = s.contractor_id
        WHERE s.pending_expiration_run_id IS NOT NULL
          AND (p_contractor_id IS NULL OR s.contractor_id = p_contractor_id)
          AND (p_run_id IS NULL OR s.pending_expiration_run_id = p_run_id)
          AND NOT public.nj_pwc_daily_contractor_eligible(s.contractor_id)
        ORDER BY s.contractor_id
        FOR UPDATE OF s
    LOOP
        v_reason := CASE
            WHEN NOT v_row.active THEN 'Contractor is inactive.'
            WHEN nullif(btrim(v_row.contractor_name), '') IS NULL THEN 'Contractor has no valid company name.'
            WHEN v_row.material_vendor_only THEN 'Contractor is classified as Material Only.'
            WHEN NOT v_row.has_public_works_assignment THEN 'No active assignment to an Active Public Works project.'
            ELSE 'Contractor does not currently meet NJ PWC monitoring eligibility.'
        END;
        UPDATE public.nj_pwc_sync_state
        SET pending_expiration_run_id = NULL, updated_at = now()
        WHERE contractor_id = v_row.contractor_id AND is_test = v_row.is_test;
        PERFORM public.nj_pwc_write_audit(
            NULL, 'NJ PWC Daily Sync', '',
            public.nj_pwc_audit_action('NJ_PWC_EXPIRATION_WITHHELD_NOT_REQUIRED', v_row.is_test),
            'contractor', v_row.contractor_id::TEXT,
            public.nj_pwc_audit_label(v_row.contractor_name, v_row.is_test),
            jsonb_build_object('sync_run_id', v_row.pending_expiration_run_id,
                'reason', v_reason, 'compliance_records_modified', FALSE)
        );
    END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.nj_pwc_reconcile_monitoring_eligibility(INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enqueue_nj_pwc_daily_sync(
    p_run_date DATE,p_triggered_by TEXT
)
RETURNS TABLE(run_id INTEGER,created BOOLEAN,enqueued INTEGER,is_test BOOLEAN,skipped_reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_run_date DATE := coalesce(p_run_date,CURRENT_DATE);
    v_trigger TEXT := coalesce(nullif(btrim(p_triggered_by),''),'NJ PWC Daily Sync');
    v_run_id INTEGER;
    v_count INTEGER;
    v_active public.compliance_sync_runs%ROWTYPE;
BEGIN
    SELECT * INTO v_settings FROM public.compliance_sync_settings s
    WHERE s.compliance_name='NJ PWC' FOR UPDATE;
    IF NOT FOUND OR NOT v_settings.enabled THEN
        RETURN QUERY SELECT NULL::INTEGER,FALSE,0,coalesce(v_settings.test_mode,FALSE),'disabled'::TEXT;
        RETURN;
    END IF;
    PERFORM public.nj_pwc_reconcile_monitoring_eligibility();
    -- Share the Run Now settings lock and active-run guard. Time alone never
    -- terminalizes yesterday's unsearched work.
    SELECT * INTO v_active FROM public.compliance_sync_runs r
    WHERE r.run_type IN ('nj_pwc_daily','nj_pwc_manual') AND r.run_status='Running'
    ORDER BY r.started_at,r.id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        SELECT count(*) INTO v_count FROM public.compliance_sync_search_requests q WHERE q.sync_run_id=v_active.id;
        RETURN QUERY SELECT v_active.id,FALSE,v_count,v_active.is_test,'run_in_progress'::TEXT;
        RETURN;
    END IF;
    SELECT r.id INTO v_run_id FROM public.compliance_sync_runs r
    WHERE r.run_type='nj_pwc_daily' AND NOT r.manual_run
      AND r.run_date=v_run_date AND r.is_test=v_settings.test_mode;
    IF v_run_id IS NOT NULL THEN
        SELECT count(*) INTO v_count FROM public.compliance_sync_search_requests q WHERE q.sync_run_id=v_run_id;
        RETURN QUERY SELECT v_run_id,FALSE,v_count,v_settings.test_mode,'already_started'::TEXT;
        RETURN;
    END IF;
    INSERT INTO public.compliance_sync_runs(
        run_at,started_at,sync_source,run_status,status,records_checked,changes_detected,
        records_approved,records_rejected,records_failed,failures,initiated_by,triggered_by,
        is_test,run_type,run_date,manual_run,notes
    ) VALUES (
        now(),now(),'RPA','Running','completed',0,0,0,0,0,0,
        left(v_trigger,200),left(v_trigger,200),v_settings.test_mode,'nj_pwc_daily',v_run_date,FALSE,
        CASE WHEN v_settings.test_mode THEN 'NJ PWC daily registry sync (Test Mode dry run).'
            ELSE 'NJ PWC daily registry sync (mode: '||v_settings.mode||').' END
    ) RETURNING id INTO v_run_id;
    INSERT INTO public.compliance_sync_search_requests(
        compliance_name,searched_company_name,searched_city,searched_state,searched_zip_code,
        status,candidates,is_test,requested_by,contractor_id,origin,priority,sync_run_id
    )
    SELECT 'NJ PWC',left(upper(btrim(regexp_replace(c.company_name,'\s+',' ','g'))),200),
        left(nullif(btrim(c.city),''),150),left(nullif(btrim(c.state),''),100),left(nullif(btrim(c.zip_code),''),20),
        'pending','[]'::JSONB,v_settings.test_mode,'NJ PWC Daily Sync',c.id,'daily_sync',20,v_run_id
    FROM public.contractors c
    WHERE public.nj_pwc_daily_contractor_eligible(c.id)
      AND NOT EXISTS(SELECT 1 FROM public.compliance_sync_search_requests p
          WHERE p.contractor_id=c.id AND p.compliance_name='NJ PWC' AND p.status='pending' AND p.origin<>'user')
    ORDER BY c.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;
    PERFORM public.nj_pwc_write_audit(NULL,'NJ PWC Daily Sync','',
        public.nj_pwc_audit_action('NJ_PWC_DAILY_SYNC_STARTED',v_settings.test_mode),
        'compliance_sync_run',v_run_id::TEXT,
        public.nj_pwc_audit_label('NJ PWC Daily Sync '||v_run_date::TEXT,v_settings.test_mode),
        jsonb_build_object('run_date',v_run_date,'enqueued',v_count,'is_test',v_settings.test_mode,
            'test_mode',v_settings.test_mode,'compliance_records_modified',NOT v_settings.test_mode,
            'mode',v_settings.mode,'triggered_by',v_trigger));
    IF v_count=0 THEN PERFORM public.finalize_nj_pwc_daily_run(v_run_id,FALSE); END IF;
    RETURN QUERY SELECT v_run_id,TRUE,v_count,v_settings.test_mode,NULL::TEXT;
END $$;

CREATE OR REPLACE FUNCTION public.run_nj_pwc_daily_sync_now(
    p_request_key UUID,p_actor_id UUID,p_actor_name TEXT,p_actor_email TEXT
)
RETURNS TABLE(run_id INTEGER,created BOOLEAN,is_test BOOLEAN,run_date DATE,run_status TEXT,already_active BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_setting public.compliance_sync_settings%ROWTYPE;
    v_existing public.nj_pwc_manual_run_requests%ROWTYPE;
    v_active public.compliance_sync_runs%ROWTYPE;
    v_run_id INTEGER;
    v_run_date DATE;
    v_count INTEGER;
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name),''),'Unknown user');
BEGIN
    IF p_request_key IS NULL THEN RAISE EXCEPTION 'Run Now request key is required.' USING ERRCODE='22023'; END IF;
    SELECT * INTO v_setting FROM public.compliance_sync_settings
    WHERE compliance_name='NJ PWC' FOR UPDATE;
    IF NOT FOUND OR NOT v_setting.enabled THEN
        RAISE EXCEPTION 'NJ PWC compliance sync is disabled.' USING ERRCODE='55000';
    END IF;
    PERFORM public.nj_pwc_reconcile_monitoring_eligibility();

    SELECT * INTO v_existing FROM public.nj_pwc_manual_run_requests WHERE request_key=p_request_key;
    IF FOUND THEN
        SELECT * INTO v_active FROM public.compliance_sync_runs WHERE id=v_existing.run_id;
        RETURN QUERY SELECT v_active.id,FALSE,v_active.is_test,v_active.run_date,v_active.run_status::TEXT,
            v_active.run_status='Running';
        RETURN;
    END IF;

    SELECT * INTO v_active FROM public.compliance_sync_runs r
    WHERE r.run_type IN ('nj_pwc_daily','nj_pwc_manual') AND r.run_status='Running'
    ORDER BY r.started_at,r.id LIMIT 1 FOR UPDATE;
    IF FOUND THEN
        INSERT INTO public.nj_pwc_manual_run_requests(request_key,run_id,created,created_by)
        VALUES(p_request_key,v_active.id,FALSE,left(v_actor,200));
        RETURN QUERY SELECT v_active.id,FALSE,v_active.is_test,v_active.run_date,v_active.run_status::TEXT,TRUE;
        RETURN;
    END IF;

    v_run_date := timezone(v_setting.daily_sync_timezone,now())::DATE;
    INSERT INTO public.compliance_sync_runs(
        run_at,started_at,sync_source,run_status,status,records_checked,changes_detected,
        records_approved,records_rejected,records_failed,failures,initiated_by,triggered_by,
        is_test,run_type,run_date,manual_run,notes
    ) VALUES (
        now(),now(),v_setting.sync_source,'Running','completed',0,0,0,0,0,0,
        left(v_actor,200),left(v_actor,200),v_setting.test_mode,'nj_pwc_daily',v_run_date,TRUE,
        CASE WHEN v_setting.test_mode THEN 'NJ PWC manual Run Now (Test Mode dry run; mode: '||v_setting.mode||').'
            ELSE 'NJ PWC manual Run Now (mode: '||v_setting.mode||').' END
    ) RETURNING id INTO v_run_id;

    INSERT INTO public.compliance_sync_search_requests(
        compliance_name,searched_company_name,searched_city,searched_state,searched_zip_code,
        status,candidates,is_test,requested_by,contractor_id,origin,priority,sync_run_id
    )
    SELECT 'NJ PWC',left(upper(btrim(regexp_replace(c.company_name,'\s+',' ','g'))),200),
        left(nullif(btrim(c.city),''),150),left(nullif(btrim(c.state),''),100),left(nullif(btrim(c.zip_code),''),20),
        'pending','[]'::JSONB,v_setting.test_mode,'NJ PWC Run Now',c.id,'daily_sync',20,v_run_id
    FROM public.contractors c
    WHERE public.nj_pwc_daily_contractor_eligible(c.id)
      AND NOT EXISTS(SELECT 1 FROM public.compliance_sync_search_requests q
          WHERE q.contractor_id=c.id AND q.compliance_name='NJ PWC' AND q.status='pending' AND q.origin<>'user')
    ORDER BY c.id;
    GET DIAGNOSTICS v_count=ROW_COUNT;

    INSERT INTO public.nj_pwc_manual_run_requests(request_key,run_id,created,created_by)
    VALUES(p_request_key,v_run_id,TRUE,left(v_actor,200));
    PERFORM public.nj_pwc_write_audit(p_actor_id,v_actor,p_actor_email,'NJ_PWC_DAILY_RUN_MANUALLY_STARTED',
        'compliance_sync_run',v_run_id::TEXT,
        public.nj_pwc_audit_label('NJ PWC Manual Daily Sync '||v_run_date::TEXT,v_setting.test_mode),
        jsonb_build_object('run_id',v_run_id,'run_date',v_run_date,'is_test',v_setting.test_mode,
            'test_mode',v_setting.test_mode,'mode',v_setting.mode,'failure_expire_threshold',v_setting.failure_expire_threshold,
            'sync_source',v_setting.sync_source,'enqueued',v_count,'request_key',p_request_key));
    IF v_count=0 THEN PERFORM public.finalize_nj_pwc_daily_run(v_run_id,FALSE); END IF;
    RETURN QUERY SELECT v_run_id,TRUE,v_setting.test_mode,v_run_date,
        CASE WHEN v_count=0 THEN 'Completed' ELSE 'Running' END::TEXT,FALSE;
END $$;

CREATE OR REPLACE FUNCTION public.poll_nj_pwc_daily_sync_schedule(p_now TIMESTAMPTZ DEFAULT now())
RETURNS TABLE(due BOOLEAN,run_id INTEGER,created BOOLEAN,enqueued INTEGER,is_test BOOLEAN,
    skipped_reason TEXT,next_sync_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_setting public.compliance_sync_settings%ROWTYPE;
    v_schedule_date DATE;
    v_today DATE;
    v_next TIMESTAMPTZ;
    v_enqueued RECORD;
    v_existing_run_id INTEGER;
    v_existing_is_test BOOLEAN;
    v_existing_enqueued INTEGER;
    v_active_run RECORD;
BEGIN
    SELECT * INTO v_setting FROM public.compliance_sync_settings
    WHERE compliance_name='NJ PWC' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ PWC sync settings are not configured.' USING ERRCODE='P0002'; END IF;
    IF NOT v_setting.daily_sync_enabled OR NOT v_setting.enabled THEN
        RETURN QUERY SELECT FALSE,NULL::INTEGER,FALSE,0,v_setting.test_mode,'disabled'::TEXT,v_setting.next_sync_at;
        RETURN;
    END IF;
    IF v_setting.next_sync_at IS NULL THEN
        v_next := public.nj_pwc_next_daily_sync_at(v_setting.daily_sync_start_date,v_setting.daily_sync_time,
            v_setting.daily_sync_timezone,p_now);
        UPDATE public.compliance_sync_settings SET next_sync_at=v_next,updated_at=now() WHERE id=v_setting.id;
        RETURN QUERY SELECT FALSE,NULL::INTEGER,FALSE,0,v_setting.test_mode,'schedule_initialized'::TEXT,v_next;
        RETURN;
    END IF;
    IF v_setting.next_sync_at > p_now THEN
        RETURN QUERY SELECT FALSE,NULL::INTEGER,FALSE,0,v_setting.test_mode,NULL::TEXT,v_setting.next_sync_at;
        RETURN;
    END IF;

    v_schedule_date := timezone(v_setting.daily_sync_timezone,v_setting.next_sync_at)::DATE;
    v_today := timezone(v_setting.daily_sync_timezone,p_now)::DATE;
    IF v_schedule_date < v_today OR v_setting.daily_sync_last_scheduled_date=v_schedule_date THEN
        v_next := public.nj_pwc_next_daily_sync_at(v_setting.daily_sync_start_date,v_setting.daily_sync_time,
            v_setting.daily_sync_timezone,p_now);
        UPDATE public.compliance_sync_settings SET next_sync_at=v_next,updated_at=now() WHERE id=v_setting.id;
        RETURN QUERY SELECT FALSE,NULL::INTEGER,FALSE,0,v_setting.test_mode,
            CASE WHEN v_schedule_date < v_today THEN 'missed_occurrence_skipped' ELSE 'already_scheduled' END,v_next;
        RETURN;
    END IF;

    SELECT r.id,r.run_status,r.is_test INTO v_active_run
    FROM public.compliance_sync_runs r
    WHERE r.run_type IN ('nj_pwc_daily','nj_pwc_manual') AND r.run_status='Running'
    ORDER BY r.started_at,r.id LIMIT 1 FOR UPDATE;
    IF v_active_run.id IS NOT NULL THEN
        -- Skip this occurrence, not the unfinished queue. Do not catch it up
        -- immediately after draining and re-search the same contractors.
        v_next := public.nj_pwc_next_daily_sync_at(v_setting.daily_sync_start_date,v_setting.daily_sync_time,
            v_setting.daily_sync_timezone,p_now);
        UPDATE public.compliance_sync_settings SET daily_sync_last_scheduled_date=v_schedule_date,
            next_sync_at=v_next,updated_at=now() WHERE id=v_setting.id;
        RETURN QUERY SELECT FALSE,v_active_run.id,FALSE,0,v_active_run.is_test,
            ('run_in_progress:'||v_active_run.run_status)::TEXT,v_next;
        RETURN;
    END IF;

    SELECT r.id,r.is_test INTO v_existing_run_id,v_existing_is_test
    FROM public.compliance_sync_runs r
    WHERE r.run_type='nj_pwc_daily' AND NOT r.manual_run AND r.run_date=v_schedule_date
    ORDER BY r.id LIMIT 1 FOR UPDATE;
    IF v_existing_run_id IS NOT NULL THEN
        SELECT count(*)::INTEGER INTO v_existing_enqueued
        FROM public.compliance_sync_search_requests q WHERE q.sync_run_id=v_existing_run_id;
        v_next := public.nj_pwc_next_daily_sync_at(v_setting.daily_sync_start_date,v_setting.daily_sync_time,
            v_setting.daily_sync_timezone,p_now);
        UPDATE public.compliance_sync_settings SET daily_sync_last_scheduled_date=v_schedule_date,
            next_sync_at=v_next,updated_at=now() WHERE id=v_setting.id;
        RETURN QUERY SELECT FALSE,v_existing_run_id,FALSE,coalesce(v_existing_enqueued,0),
            v_existing_is_test,'already_scheduled'::TEXT,v_next;
        RETURN;
    END IF;

    SELECT * INTO v_enqueued FROM public.enqueue_nj_pwc_daily_sync(v_schedule_date,'NJ PWC Scheduled Daily Sync');
    v_next := public.nj_pwc_next_daily_sync_at(v_setting.daily_sync_start_date,v_setting.daily_sync_time,
        v_setting.daily_sync_timezone,p_now);
    UPDATE public.compliance_sync_settings SET daily_sync_last_scheduled_date=v_schedule_date,
        next_sync_at=v_next,updated_at=now() WHERE id=v_setting.id;
    RETURN QUERY SELECT TRUE,v_enqueued.run_id,v_enqueued.created,v_enqueued.enqueued,
        v_enqueued.is_test,v_enqueued.skipped_reason,v_next;
END $$;

CREATE OR REPLACE FUNCTION public.claim_nj_pwc_request(p_worker_instance_id UUID)
RETURNS SETOF public.compliance_sync_search_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_request public.compliance_sync_search_requests%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(61015,1);
    PERFORM public.nj_pwc_reconcile_monitoring_eligibility();
    IF NOT EXISTS (SELECT 1 FROM public.compliance_sync_workers WHERE worker_key='nj-pwc' AND enabled) THEN
        RAISE EXCEPTION 'NJ PWC worker is disabled.' USING ERRCODE='55000';
    END IF;
    PERFORM 1 FROM public.nj_pwc_queue_workers
    WHERE instance_id=p_worker_instance_id AND lifecycle IN ('ready','busy')
      AND browser_connected AND loaded_hash=current_hash
      AND last_heartbeat_at > now()-interval '2 minutes' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'NJ PWC worker must register a healthy heartbeat before claiming.' USING ERRCODE='55000';
    END IF;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests
    WHERE worker_instance_id=p_worker_instance_id AND status IN ('claimed','processing');
    IF FOUND THEN
        IF v_request.status='processing' THEN
            RAISE EXCEPTION 'Worker already owns a processing request; recovery is required before further work.' USING ERRCODE='55000';
        END IF;
        RETURN NEXT v_request;
        RETURN;
    END IF;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests q
    WHERE q.compliance_name='NJ PWC' AND q.status='pending'
      AND NOT EXISTS (SELECT 1 FROM public.compliance_sync_runs r
          WHERE r.id=q.sync_run_id AND r.stop_requested_at IS NOT NULL)
    ORDER BY q.priority,q.created_at,q.id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.compliance_sync_search_requests SET
        status='claimed',worker_instance_id=p_worker_instance_id,claimed_at=now(),updated_at=now()
    WHERE id=v_request.id RETURNING * INTO v_request;
    PERFORM public.nj_pwc_write_audit(NULL,'NJ PWC Worker','',
        public.nj_pwc_audit_action('NJ_PWC_REQUEST_CLAIMED',v_request.is_test),
        'compliance_sync',v_request.id::TEXT,'NJ PWC Search',
        jsonb_build_object('worker_instance_id',p_worker_instance_id,'origin',v_request.origin,'priority',v_request.priority));
    RETURN NEXT v_request;
END $$;

CREATE OR REPLACE FUNCTION public.start_nj_pwc_request(p_request_id INTEGER,p_worker_instance_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_request public.compliance_sync_search_requests%ROWTYPE;
    v_company_name TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(61015,1);
    PERFORM 1 FROM public.contractors c WHERE c.id=(
        SELECT contractor_id FROM public.compliance_sync_search_requests WHERE id=p_request_id
    ) FOR UPDATE;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests WHERE id=p_request_id FOR UPDATE;
    IF NOT FOUND OR v_request.compliance_name<>'NJ PWC' OR v_request.status<>'claimed'
       OR v_request.worker_instance_id IS DISTINCT FROM p_worker_instance_id THEN
        RAISE EXCEPTION 'Request is not claimed by this worker.' USING ERRCODE='55000';
    END IF;
    SELECT company_name INTO v_company_name FROM public.contractors WHERE id=v_request.contractor_id;
    IF v_request.origin<>'user'
       AND NOT public.nj_pwc_daily_contractor_eligible(v_request.contractor_id) THEN
        UPDATE public.compliance_sync_search_requests SET
            status='cancelled',sync_outcome='cancelled:monitoring_not_required',
            error_message='Contractor no longer meets NJ PWC monitoring eligibility; no registry search was performed.',
            processed_at=now(),completed_at=now(),updated_at=now()
        WHERE id=v_request.id;
        PERFORM public.nj_pwc_reconcile_monitoring_eligibility(v_request.contractor_id);
        PERFORM public.nj_pwc_write_audit(NULL,'NJ PWC Worker','',
            public.nj_pwc_audit_action('NJ_PWC_SEARCH_CANCELLED_NOT_REQUIRED',v_request.is_test),
            'compliance_sync',v_request.id::TEXT,
            public.nj_pwc_audit_label(v_company_name,v_request.is_test),
            jsonb_build_object('search_request_id',v_request.id,'sync_run_id',v_request.sync_run_id,
                'contractor_id',v_request.contractor_id,
                'reason','Eligibility changed before the registry search began.'));
        RETURN;
    END IF;
    UPDATE public.compliance_sync_search_requests SET status='processing',processing_at=now(),updated_at=now()
    WHERE id=v_request.id;
END $$;

CREATE OR REPLACE FUNCTION public.complete_nj_pwc_request(
    p_request_id INTEGER,p_worker_instance_id UUID,p_result_status TEXT,
    p_candidates JSONB,p_error_message TEXT,p_source_url TEXT,p_search_variation TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_request public.compliance_sync_search_requests%ROWTYPE;
    v_sync JSONB;
    v_status TEXT;
    v_company_name TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(61015,1);
    PERFORM 1 FROM public.contractors c WHERE c.id=(
        SELECT contractor_id FROM public.compliance_sync_search_requests WHERE id=p_request_id
    ) FOR UPDATE;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests WHERE id=p_request_id FOR UPDATE;
    IF NOT FOUND OR v_request.compliance_name<>'NJ PWC' THEN
        RAISE EXCEPTION 'NJ PWC request not found.' USING ERRCODE='P0002';
    END IF;
    IF v_request.worker_instance_id IS DISTINCT FROM p_worker_instance_id OR p_worker_instance_id IS NULL
       OR v_request.recovery_action IS NOT NULL THEN
        RAISE EXCEPTION 'Result rejected: worker does not own this request.' USING ERRCODE='55000';
    END IF;
    IF v_request.status NOT IN ('claimed','processing') THEN
        RETURN jsonb_build_object('already_processed',TRUE,'status',v_request.status);
    END IF;
    IF p_result_status NOT IN ('Match Found','Multiple Matches','No Match Found','Invalid Search','Website Error','RPA Error')
       OR p_result_status IS NULL THEN
        RAISE EXCEPTION 'Invalid result status.' USING ERRCODE='22023';
    END IF;
    SELECT company_name INTO v_company_name FROM public.contractors WHERE id=v_request.contractor_id;
    IF v_request.origin<>'user'
       AND NOT public.nj_pwc_daily_contractor_eligible(v_request.contractor_id) THEN
        UPDATE public.compliance_sync_search_requests SET
            status='cancelled',sync_outcome='cancelled:monitoring_not_required',
            error_message='Contractor no longer meets NJ PWC monitoring eligibility; registry result was not applied.',
            processed_at=now(),completed_at=now(),updated_at=now()
        WHERE id=v_request.id;
        PERFORM public.nj_pwc_reconcile_monitoring_eligibility(v_request.contractor_id);
        PERFORM public.nj_pwc_write_audit(NULL,'NJ PWC Worker','',
            public.nj_pwc_audit_action('NJ_PWC_RESULT_IGNORED_NOT_REQUIRED',v_request.is_test),
            'compliance_sync',v_request.id::TEXT,
            public.nj_pwc_audit_label(v_company_name,v_request.is_test),
            jsonb_build_object('search_request_id',v_request.id,'sync_run_id',v_request.sync_run_id,
                'contractor_id',v_request.contractor_id,'submitted_result',p_result_status,
                'compliance_records_modified',FALSE));
        RETURN jsonb_build_object('status','cancelled','monitoring_not_required',TRUE);
    END IF;

    IF v_request.origin<>'user' THEN
        UPDATE public.compliance_sync_search_requests SET status='pending' WHERE id=p_request_id;
        SELECT to_jsonb(s) INTO v_sync FROM public.submit_nj_pwc_sync_result(
            p_request_id,p_result_status,p_candidates,p_error_message,p_source_url,p_search_variation
        ) s;
        IF v_sync IS NULL THEN RAISE EXCEPTION 'NJ PWC sync processor returned no result.'; END IF;
    ELSE
        UPDATE public.compliance_sync_search_requests SET
            status=CASE WHEN p_result_status='No Match Found' THEN 'no_match'
                WHEN p_result_status IN ('Match Found','Multiple Matches') THEN 'completed'
                WHEN p_result_status='Website Error' THEN 'website_error' ELSE 'failed' END,
            result_status=p_result_status,candidates=p_candidates,
            error_message=left(p_error_message,2000),source_url=p_source_url,
            search_variation=left(p_search_variation,40),processed_at=now(),completed_at=now(),updated_at=now()
        WHERE id=p_request_id;
    END IF;
    SELECT status INTO v_status FROM public.compliance_sync_search_requests WHERE id=p_request_id;
    IF v_status NOT IN ('completed','no_match','failed','website_error') THEN
        RAISE EXCEPTION 'NJ PWC result did not reach a terminal state.';
    END IF;
    PERFORM public.nj_pwc_write_audit(NULL,'NJ PWC Worker','',
        public.nj_pwc_audit_action('NJ_PWC_REQUEST_COMPLETED',v_request.is_test),
        'compliance_sync',p_request_id::TEXT,'NJ PWC Search',
        jsonb_build_object('worker_instance_id',p_worker_instance_id,'result_status',p_result_status,'status',v_status));
    RETURN jsonb_build_object('status',v_status,'sync',v_sync);
END $$;

CREATE OR REPLACE FUNCTION public.finalize_nj_pwc_daily_run(p_run_id INTEGER, p_force BOOLEAN DEFAULT FALSE)
RETURNS TABLE(run_id INTEGER,finished BOOLEAN,run_status TEXT,total INTEGER,pending INTEGER,succeeded INTEGER,
    failures INTEGER,review_required INTEGER,infrastructure INTEGER,expired INTEGER,expirations_withheld INTEGER,circuit_breaker BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_run public.compliance_sync_runs%ROWTYPE;
    v_owned INTEGER;
    v_pending INTEGER;
BEGIN
    PERFORM pg_advisory_xact_lock(61015,1);
    SELECT * INTO v_run FROM public.compliance_sync_runs WHERE id=p_run_id FOR UPDATE;
    PERFORM public.nj_pwc_reconcile_monitoring_eligibility(NULL,p_run_id);
    SELECT count(*) FILTER (WHERE status IN ('claimed','processing')),count(*)
    INTO v_owned,v_pending FROM public.compliance_sync_search_requests
    WHERE sync_run_id=p_run_id AND status IN ('pending','claimed','processing');
    IF v_owned>0 OR (v_pending>0 AND v_run.stop_requested_at IS NULL) THEN
        RETURN QUERY SELECT p_run_id,FALSE,'Running'::TEXT,NULL::INTEGER,v_pending,
            NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::BOOLEAN;
        RETURN;
    END IF;
    RETURN QUERY SELECT * FROM public.finalize_nj_pwc_unclaimed_run(p_run_id,p_force);
END $$;

-- CREATE OR REPLACE retains the installed owners and restrictive ACLs.
COMMIT;
