-- Add confirmed Public Works contractors to NJ PWC daily coverage.
-- Requires 20261114_project_public_works.sql.
BEGIN;

CREATE OR REPLACE FUNCTION public.nj_pwc_daily_contractor_eligible(p_contractor_id INTEGER)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.contractors c
        WHERE c.id = p_contractor_id
          AND c.active
          AND nullif(btrim(c.company_name), '') IS NOT NULL
          AND NOT c.material_vendor_only
          AND (
              nullif(btrim(c.nj_pwc_number), '') IS NOT NULL
              OR EXISTS (
                  SELECT 1
                  FROM public.compliance_records cr
                  WHERE cr.contractor_id = c.id
                    AND cr.compliance_type_id = public.nj_pwc_compliance_type_id()
                    AND cr.active
                    AND cr.is_current
              )
              OR EXISTS (
                  SELECT 1
                  FROM public.contractor_projects cp
                  JOIN public.projects p ON p.id = cp.project_id
                  WHERE cp.contractor_id = c.id
                    AND cp.active
                    AND p.status = 'Active'
                    AND p.public_works IS TRUE
              )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.nj_pwc_daily_contractor_eligible(INTEGER)
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

DO $$
DECLARE
    v_owner TEXT;
BEGIN
    FOR v_owner IN
        SELECT DISTINCT pg_get_userbyid(p.proowner)
        FROM pg_proc p
        WHERE p.oid IN (
            'public.enqueue_nj_pwc_daily_sync(date,text)'::regprocedure,
            'public.run_nj_pwc_daily_sync_now(uuid,uuid,text,text)'::regprocedure
        )
    LOOP
        EXECUTE format(
            'GRANT EXECUTE ON FUNCTION public.nj_pwc_daily_contractor_eligible(integer) TO %I',
            v_owner
        );
    END LOOP;
END;
$$;

COMMIT;
