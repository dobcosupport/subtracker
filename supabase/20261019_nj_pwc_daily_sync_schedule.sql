-- Server-owned NJ PWC daily schedule. The worker only polls the due RPC.
BEGIN;

ALTER TABLE public.compliance_sync_settings
    ADD COLUMN IF NOT EXISTS daily_sync_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS daily_sync_start_date DATE,
    ADD COLUMN IF NOT EXISTS daily_sync_time TIME WITHOUT TIME ZONE NOT NULL DEFAULT TIME '02:00',
    ADD COLUMN IF NOT EXISTS daily_sync_timezone TEXT NOT NULL DEFAULT 'America/New_York',
    ADD COLUMN IF NOT EXISTS daily_sync_last_scheduled_date DATE;

ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS manual_run BOOLEAN NOT NULL DEFAULT FALSE;
DROP INDEX IF EXISTS public.uq_compliance_sync_runs_nj_pwc_daily;
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_sync_runs_nj_pwc_daily
    ON public.compliance_sync_runs(run_type,run_date,is_test)
    WHERE run_type='nj_pwc_daily' AND NOT manual_run;

-- Preserve the established recurring enqueue behavior, but treat Run Now rows
-- as separate manual runs even though both use the daily result processor.
CREATE OR REPLACE FUNCTION public.enqueue_nj_pwc_daily_sync(
    p_run_date DATE,p_triggered_by TEXT
)
RETURNS TABLE(run_id INTEGER,created BOOLEAN,enqueued INTEGER,is_test BOOLEAN,skipped_reason TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_type_id INTEGER := public.nj_pwc_compliance_type_id();
    v_run_date DATE := coalesce(p_run_date,CURRENT_DATE);
    v_trigger TEXT := coalesce(nullif(btrim(p_triggered_by),''),'NJ PWC Daily Sync');
    v_run_id INTEGER;
    v_count INTEGER;
    v_stale RECORD;
BEGIN
    SELECT * INTO v_settings FROM public.compliance_sync_settings s
    WHERE s.compliance_name='NJ PWC' FOR UPDATE;
    IF NOT FOUND OR NOT v_settings.enabled THEN
        RETURN QUERY SELECT NULL::INTEGER,FALSE,0,coalesce(v_settings.test_mode,FALSE),'disabled'::TEXT;
        RETURN;
    END IF;
    FOR v_stale IN SELECT r.id FROM public.compliance_sync_runs r
        WHERE r.run_type='nj_pwc_daily' AND NOT r.manual_run
          AND r.run_status='Running' AND r.run_date<v_run_date ORDER BY r.id
    LOOP
        PERFORM public.finalize_nj_pwc_daily_run(v_stale.id,TRUE);
    END LOOP;
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
    WHERE c.active AND nullif(btrim(c.company_name),'') IS NOT NULL
      AND (nullif(btrim(c.nj_pwc_number),'') IS NOT NULL OR EXISTS(
          SELECT 1 FROM public.compliance_records cr
          WHERE cr.contractor_id=c.id AND cr.compliance_type_id=v_type_id AND cr.active AND cr.is_current))
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

CREATE OR REPLACE FUNCTION public.nj_pwc_next_daily_sync_at(
    p_start_date DATE, p_start_time TIME WITHOUT TIME ZONE, p_timezone TEXT, p_after TIMESTAMPTZ
)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE v_date DATE; v_candidate TIMESTAMPTZ;
BEGIN
    IF p_start_date IS NULL OR p_start_time IS NULL OR p_after IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = p_timezone) THEN
        RAISE EXCEPTION 'A valid start date, start time, and IANA time zone are required.' USING ERRCODE='22023';
    END IF;
    v_date := greatest(p_start_date, timezone(p_timezone, p_after)::DATE);
    LOOP
        v_candidate := (v_date::TIMESTAMP + p_start_time) AT TIME ZONE p_timezone;
        IF v_candidate > p_after THEN RETURN v_candidate; END IF;
        v_date := v_date + 1;
    END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.save_nj_pwc_daily_sync_schedule(
    p_daily_sync_enabled BOOLEAN, p_daily_sync_start_date DATE,
    p_daily_sync_time TIME WITHOUT TIME ZONE, p_daily_sync_timezone TEXT,
    p_actor_id UUID, p_actor_name TEXT, p_actor_email TEXT
)
RETURNS TABLE(daily_sync_enabled BOOLEAN, daily_sync_start_date DATE,
    daily_sync_time TIME WITHOUT TIME ZONE, daily_sync_timezone TEXT, next_sync_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_setting public.compliance_sync_settings%ROWTYPE;
    v_next TIMESTAMPTZ;
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name),''),'Unknown user');
BEGIN
    IF p_daily_sync_enabled IS NULL OR p_daily_sync_start_date IS NULL OR p_daily_sync_time IS NULL
       OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=p_daily_sync_timezone) THEN
        RAISE EXCEPTION 'A valid schedule enabled flag, start date, time, and time zone are required.' USING ERRCODE='22023';
    END IF;
    SELECT * INTO v_setting FROM public.compliance_sync_settings
    WHERE compliance_name='NJ PWC' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ PWC sync settings are not configured.' USING ERRCODE='P0002'; END IF;
    v_next := CASE WHEN p_daily_sync_enabled
        THEN public.nj_pwc_next_daily_sync_at(p_daily_sync_start_date,p_daily_sync_time,p_daily_sync_timezone,now())
        ELSE NULL END;

    UPDATE public.compliance_sync_settings SET
        daily_sync_enabled=p_daily_sync_enabled,
        daily_sync_start_date=p_daily_sync_start_date,
        daily_sync_time=p_daily_sync_time,
        daily_sync_timezone=p_daily_sync_timezone,
        next_sync_at=v_next,
        updated_at=now()
    WHERE id=v_setting.id;

    PERFORM public.nj_pwc_write_audit(p_actor_id,v_actor,p_actor_email,
        'NJ_PWC_DAILY_SCHEDULE_CHANGED','compliance_sync_settings',v_setting.id::TEXT,'NJ PWC Daily Schedule',
        jsonb_build_object(
            'enabled',jsonb_build_object('old',v_setting.daily_sync_enabled,'new',p_daily_sync_enabled),
            'start_date',jsonb_build_object('old',v_setting.daily_sync_start_date,'new',p_daily_sync_start_date),
            'time',jsonb_build_object('old',v_setting.daily_sync_time,'new',p_daily_sync_time),
            'timezone',jsonb_build_object('old',v_setting.daily_sync_timezone,'new',p_daily_sync_timezone),
            'next_scheduled_run',v_next));
    RETURN QUERY SELECT p_daily_sync_enabled,p_daily_sync_start_date,p_daily_sync_time,p_daily_sync_timezone,v_next;
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

    SELECT r.id,r.run_status INTO v_active_run
    FROM public.compliance_sync_runs r
    WHERE r.run_type='nj_pwc_daily' AND r.manual_run AND r.run_status='Running'
    ORDER BY r.started_at,r.id LIMIT 1 FOR UPDATE;
    IF v_active_run.id IS NOT NULL THEN
        RETURN QUERY SELECT FALSE,v_active_run.id,FALSE,0,v_setting.test_mode,
            ('run_in_progress:'||v_active_run.run_status)::TEXT,v_setting.next_sync_at;
        RETURN;
    END IF;

    -- The legacy run uniqueness includes Test Mode. Also guard by scheduled
    -- local date so a pre-migration or opposite-mode run cannot be duplicated.
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

CREATE TABLE IF NOT EXISTS public.nj_pwc_manual_run_requests (
    request_key UUID PRIMARY KEY,
    run_id INTEGER NOT NULL REFERENCES public.compliance_sync_runs(id) ON DELETE CASCADE,
    created BOOLEAN NOT NULL,
    created_by TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.nj_pwc_manual_run_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.nj_pwc_manual_run_requests FROM PUBLIC,anon,authenticated,service_role;

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
    WHERE c.active AND nullif(btrim(c.company_name),'') IS NOT NULL
      AND (nullif(btrim(c.nj_pwc_number),'') IS NOT NULL OR EXISTS(
          SELECT 1 FROM public.compliance_records cr
          WHERE cr.contractor_id=c.id AND cr.compliance_type_id=public.nj_pwc_compliance_type_id()
            AND cr.active AND cr.is_current))
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

REVOKE ALL ON FUNCTION public.nj_pwc_next_daily_sync_at(DATE,TIME WITHOUT TIME ZONE,TEXT,TIMESTAMPTZ),
    public.save_nj_pwc_daily_sync_schedule(BOOLEAN,DATE,TIME WITHOUT TIME ZONE,TEXT,UUID,TEXT,TEXT),
    public.poll_nj_pwc_daily_sync_schedule(TIMESTAMPTZ),
    public.run_nj_pwc_daily_sync_now(UUID,UUID,TEXT,TEXT)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.poll_nj_pwc_daily_sync_schedule(TIMESTAMPTZ),
    public.save_nj_pwc_daily_sync_schedule(BOOLEAN,DATE,TIME WITHOUT TIME ZONE,TEXT,UUID,TEXT,TEXT),
    public.run_nj_pwc_daily_sync_now(UUID,UUID,TEXT,TEXT) TO service_role;

COMMIT;