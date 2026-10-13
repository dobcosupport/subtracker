-- Apply after both 20261014 NJ PWC migrations and worker-health schema.
-- Deploy the app next, then restart NJ PWC workers. Old pollers fail closed.
-- Claims never expire or automatically reassign.
BEGIN;

CREATE TABLE IF NOT EXISTS public.nj_pwc_queue_workers (
    instance_id UUID PRIMARY KEY,
    started_at TIMESTAMPTZ NOT NULL,
    last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    sequence BIGINT NOT NULL,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('starting','ready','busy','stopped')),
    browser_connected BOOLEAN NOT NULL DEFAULT FALSE,
    loaded_hash TEXT,
    current_hash TEXT
);
ALTER TABLE public.compliance_sync_search_requests
    ADD COLUMN IF NOT EXISTS worker_instance_id UUID REFERENCES public.nj_pwc_queue_workers(instance_id),
    ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recovery_action TEXT,
    ADD COLUMN IF NOT EXISTS retry_of_request_id INTEGER REFERENCES public.compliance_sync_search_requests(id);
ALTER TABLE public.compliance_sync_search_requests
    DROP CONSTRAINT IF EXISTS compliance_sync_search_requests_status_check;
ALTER TABLE public.compliance_sync_search_requests
    ADD CONSTRAINT compliance_sync_search_requests_status_check
    CHECK (status IN ('pending','claimed','processing','completed','no_match','failed','website_error'));
CREATE UNIQUE INDEX IF NOT EXISTS nj_pwc_one_active_claim_per_worker
    ON public.compliance_sync_search_requests(worker_instance_id)
    WHERE compliance_name = 'NJ PWC' AND status IN ('claimed','processing');
CREATE INDEX IF NOT EXISTS nj_pwc_queue_order
    ON public.compliance_sync_search_requests(priority, created_at, id)
    WHERE compliance_name = 'NJ PWC' AND status = 'pending';

ALTER TABLE public.nj_pwc_queue_workers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nj_pwc_queue_workers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.nj_pwc_queue_workers TO service_role;

CREATE OR REPLACE FUNCTION public.report_nj_pwc_queue_worker(p_report JSONB)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_accepted BOOLEAN;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.compliance_sync_workers WHERE worker_key='nj-pwc' AND enabled) THEN
        RETURN FALSE;
    END IF;
    INSERT INTO public.nj_pwc_queue_workers(instance_id, started_at, sequence, lifecycle, browser_connected,loaded_hash,current_hash)
    VALUES ((p_report->>'instance_id')::UUID, (p_report->>'started_at')::TIMESTAMPTZ,
        (p_report->>'sequence')::BIGINT, p_report->>'lifecycle',
        (p_report->>'browser_connected')::BOOLEAN,p_report->>'loaded_hash',p_report->>'current_hash')
    ON CONFLICT (instance_id) DO UPDATE SET
        last_heartbeat_at=now(), sequence=EXCLUDED.sequence, lifecycle=EXCLUDED.lifecycle,
        browser_connected=EXCLUDED.browser_connected,loaded_hash=EXCLUDED.loaded_hash,current_hash=EXCLUDED.current_hash
    WHERE nj_pwc_queue_workers.started_at=EXCLUDED.started_at
      AND nj_pwc_queue_workers.sequence < EXCLUDED.sequence
      AND nj_pwc_queue_workers.lifecycle <> 'stopped';
    v_accepted := FOUND;
    RETURN v_accepted;
END $$;

CREATE OR REPLACE FUNCTION public.claim_nj_pwc_request(p_worker_instance_id UUID)
RETURNS SETOF public.compliance_sync_search_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_request public.compliance_sync_search_requests%ROWTYPE;
BEGIN
    PERFORM pg_advisory_xact_lock(61015,1);
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
    -- Retry a lost claim response safely; never execute an already-processing claim twice.
    SELECT * INTO v_request FROM public.compliance_sync_search_requests
    WHERE worker_instance_id=p_worker_instance_id AND status IN ('claimed','processing');
    IF FOUND THEN
        IF v_request.status='processing' THEN
            RAISE EXCEPTION 'Worker already owns a processing request; recovery is required before further work.' USING ERRCODE='55000';
        END IF;
        RETURN NEXT v_request; RETURN;
    END IF;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests
    WHERE compliance_name='NJ PWC' AND status='pending'
    ORDER BY priority, created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.compliance_sync_search_requests SET
        status='claimed', worker_instance_id=p_worker_instance_id, claimed_at=now(), updated_at=now()
    WHERE id=v_request.id RETURNING * INTO v_request;
    PERFORM public.nj_pwc_write_audit(NULL,'NJ PWC Worker','',
        public.nj_pwc_audit_action('NJ_PWC_REQUEST_CLAIMED',v_request.is_test),
        'compliance_sync',v_request.id::TEXT,'NJ PWC Search',
        jsonb_build_object('worker_instance_id',p_worker_instance_id,'origin',v_request.origin,'priority',v_request.priority));
    RETURN NEXT v_request;
END $$;

CREATE OR REPLACE FUNCTION public.start_nj_pwc_request(p_request_id INTEGER, p_worker_instance_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    UPDATE public.compliance_sync_search_requests SET status='processing', processing_at=now(), updated_at=now()
    WHERE id=p_request_id AND compliance_name='NJ PWC' AND status='claimed'
      AND worker_instance_id=p_worker_instance_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Request is not claimed by this worker.' USING ERRCODE='55000';
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.complete_nj_pwc_request(
    p_request_id INTEGER, p_worker_instance_id UUID, p_result_status TEXT,
    p_candidates JSONB, p_error_message TEXT, p_source_url TEXT, p_search_variation TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_request public.compliance_sync_search_requests%ROWTYPE; v_sync JSONB; v_status TEXT;
BEGIN
    -- Match the underlying processor's contractor-before-request lock order.
    PERFORM 1 FROM public.contractors c WHERE c.id=(
        SELECT contractor_id FROM public.compliance_sync_search_requests WHERE id=p_request_id
    ) FOR UPDATE;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests WHERE id=p_request_id FOR UPDATE;
    IF NOT FOUND OR v_request.compliance_name <> 'NJ PWC' THEN
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
    IF v_request.origin <> 'user' THEN
        -- The authoritative processor expects pending. This temporary state
        -- is transaction-local and invisible to other claimers.
        UPDATE public.compliance_sync_search_requests SET status='pending' WHERE id=p_request_id;
        SELECT to_jsonb(s) INTO v_sync FROM public.submit_nj_pwc_sync_result(
            p_request_id,p_result_status,p_candidates,p_error_message,p_source_url,p_search_variation
        ) s;
        IF v_sync IS NULL THEN
            RAISE EXCEPTION 'NJ PWC sync processor returned no result.';
        END IF;
    ELSE
        UPDATE public.compliance_sync_search_requests SET
            status=CASE WHEN p_result_status='No Match Found' THEN 'no_match'
                WHEN p_result_status IN ('Match Found','Multiple Matches') THEN 'completed'
                WHEN p_result_status='Website Error' THEN 'website_error' ELSE 'failed' END,
            result_status=p_result_status, candidates=p_candidates,
            error_message=left(p_error_message,2000), source_url=p_source_url,
            search_variation=left(p_search_variation,40), processed_at=now(), completed_at=now(), updated_at=now()
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

-- Guard finalization, including force/stale-run handling, while any worker owns a search.
DO $$
BEGIN
    IF to_regprocedure('public.finalize_nj_pwc_unclaimed_run(integer,boolean)') IS NULL THEN
        ALTER FUNCTION public.finalize_nj_pwc_daily_run(INTEGER,BOOLEAN) RENAME TO finalize_nj_pwc_unclaimed_run;
    END IF;
END $$;
CREATE OR REPLACE FUNCTION public.finalize_nj_pwc_daily_run(p_run_id INTEGER, p_force BOOLEAN DEFAULT FALSE)
RETURNS TABLE(run_id INTEGER,finished BOOLEAN,run_status TEXT,total INTEGER,pending INTEGER,succeeded INTEGER,
    failures INTEGER,review_required INTEGER,infrastructure INTEGER,expired INTEGER,expirations_withheld INTEGER,circuit_breaker BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_owned INTEGER; v_pending INTEGER;
BEGIN
    -- Serialize claim/finalize/recovery transactions, not browser execution.
    PERFORM pg_advisory_xact_lock(61015,1);
    PERFORM 1 FROM public.compliance_sync_runs WHERE id=p_run_id FOR UPDATE;
    SELECT count(*)::INTEGER INTO v_owned FROM public.compliance_sync_search_requests
    WHERE sync_run_id=p_run_id AND status IN ('claimed','processing');
    IF v_owned > 0 THEN
        SELECT count(*)::INTEGER INTO v_pending FROM public.compliance_sync_search_requests
        WHERE sync_run_id=p_run_id AND status IN ('pending','claimed','processing');
        RETURN QUERY SELECT p_run_id,FALSE,'Running'::TEXT,NULL::INTEGER,v_pending,
            NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::INTEGER,NULL::BOOLEAN;
        RETURN;
    END IF;
    RETURN QUERY SELECT * FROM public.finalize_nj_pwc_unclaimed_run(p_run_id,p_force);
END $$;

CREATE OR REPLACE FUNCTION public.list_orphaned_nj_pwc_requests(p_min_age_minutes INTEGER)
RETURNS SETOF public.compliance_sync_search_requests
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF p_min_age_minutes NOT BETWEEN 1 AND 1440 OR p_min_age_minutes IS NULL THEN
        RAISE EXCEPTION 'Invalid orphan age threshold.' USING ERRCODE='22023';
    END IF;
    RETURN QUERY SELECT r.* FROM public.compliance_sync_search_requests r
    LEFT JOIN public.nj_pwc_queue_workers w ON w.instance_id=r.worker_instance_id
    WHERE r.compliance_name='NJ PWC' AND r.status IN ('claimed','processing')
      AND r.claimed_at <= now()-make_interval(mins=>p_min_age_minutes)
      AND (w.instance_id IS NULL OR w.lifecycle='stopped'
           OR w.last_heartbeat_at <= now()-interval '2 minutes')
    ORDER BY r.claimed_at,r.id;
END $$;

CREATE OR REPLACE FUNCTION public.recover_orphaned_nj_pwc_request(
    p_request_id INTEGER,p_action TEXT,p_min_age_minutes INTEGER,
    p_actor_id UUID,p_actor_name TEXT,p_actor_email TEXT,p_note TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_request public.compliance_sync_search_requests%ROWTYPE; v_retry_id INTEGER;
BEGIN
    IF p_action NOT IN ('fail','retry','resolve') OR p_action IS NULL THEN
        RAISE EXCEPTION 'Invalid recovery action.' USING ERRCODE='22023';
    END IF;
    PERFORM pg_advisory_xact_lock(61015,1);
    -- Same worker-before-request order as claiming; heartbeat updates serialize here.
    PERFORM 1 FROM public.nj_pwc_queue_workers WHERE instance_id=(
        SELECT worker_instance_id FROM public.compliance_sync_search_requests WHERE id=p_request_id
    ) FOR UPDATE;
    PERFORM 1 FROM public.contractors c WHERE c.id=(
        SELECT contractor_id FROM public.compliance_sync_search_requests WHERE id=p_request_id
    ) FOR UPDATE;
    SELECT * INTO v_request FROM public.compliance_sync_search_requests WHERE id=p_request_id FOR UPDATE;
    IF NOT EXISTS (SELECT 1 FROM public.list_orphaned_nj_pwc_requests(p_min_age_minutes) WHERE id=p_request_id) THEN
        RAISE EXCEPTION 'Request no longer meets orphan recovery criteria.' USING ERRCODE='55000';
    END IF;
    IF v_request.origin <> 'user' THEN
        UPDATE public.compliance_sync_search_requests SET status='pending' WHERE id=p_request_id;
        PERFORM public.submit_nj_pwc_sync_result(p_request_id,'RPA Error','[]'::JSONB,
            'Administrator confirmed abandoned NJ PWC worker request.',NULL,NULL);
    END IF;
    UPDATE public.compliance_sync_search_requests SET status='failed', result_status='RPA Error',
        recovery_action=p_action, completed_at=now(), processed_at=now(), updated_at=now(),
        error_message='NJ PWC request abandoned by an inactive worker; administrator confirmed orphan recovery.',
        sync_outcome=CASE WHEN origin='user' THEN sync_outcome ELSE 'infrastructure:Registry Unavailable' END
    WHERE id=p_request_id;
    IF p_action='retry' THEN
        INSERT INTO public.compliance_sync_search_requests(
            compliance_name,searched_company_name,searched_zip_code,searched_city,searched_state,
            contractor_id,origin,priority,is_test,requested_by,sync_run_id,retry_of_request_id
        ) VALUES ('NJ PWC',v_request.searched_company_name,v_request.searched_zip_code,
            v_request.searched_city,v_request.searched_state,v_request.contractor_id,
            CASE WHEN v_request.origin='user' THEN 'user' ELSE 'exception_retry' END,
            CASE WHEN v_request.origin='user' THEN 0 ELSE 10 END,v_request.is_test,v_request.requested_by,
            CASE WHEN EXISTS(SELECT 1 FROM public.compliance_sync_runs
                WHERE id=v_request.sync_run_id AND run_status='Running') THEN v_request.sync_run_id ELSE NULL END,
            v_request.id) RETURNING id INTO v_retry_id;
    END IF;
    PERFORM public.nj_pwc_write_audit(p_actor_id,p_actor_name,p_actor_email,
        public.nj_pwc_audit_action('NJ_PWC_ORPHAN_RECOVERED',v_request.is_test),
        'compliance_sync',p_request_id::TEXT,'NJ PWC Search',
        jsonb_build_object('action',p_action,'old_status',v_request.status,'new_status','failed',
            'worker_instance_id',v_request.worker_instance_id,'retry_request_id',v_retry_id,'note',p_note));
    RETURN jsonb_build_object('request_id',p_request_id,'status','failed','action',p_action,'retry_request_id',v_retry_id);
END $$;

REVOKE ALL ON FUNCTION public.report_nj_pwc_queue_worker(JSONB),
    public.claim_nj_pwc_request(UUID), public.start_nj_pwc_request(INTEGER,UUID),
    public.complete_nj_pwc_request(INTEGER,UUID,TEXT,JSONB,TEXT,TEXT,TEXT),
    public.list_orphaned_nj_pwc_requests(INTEGER),
    public.recover_orphaned_nj_pwc_request(INTEGER,TEXT,INTEGER,UUID,TEXT,TEXT,TEXT),
    public.finalize_nj_pwc_daily_run(INTEGER,BOOLEAN)
    FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.submit_nj_pwc_sync_result(INTEGER,TEXT,JSONB,TEXT,TEXT,TEXT),
    public.finalize_nj_pwc_unclaimed_run(INTEGER,BOOLEAN) FROM service_role;
GRANT EXECUTE ON FUNCTION public.report_nj_pwc_queue_worker(JSONB),
    public.claim_nj_pwc_request(UUID), public.start_nj_pwc_request(INTEGER,UUID),
    public.complete_nj_pwc_request(INTEGER,UUID,TEXT,JSONB,TEXT,TEXT,TEXT),
    public.list_orphaned_nj_pwc_requests(INTEGER),
    public.recover_orphaned_nj_pwc_request(INTEGER,TEXT,INTEGER,UUID,TEXT,TEXT,TEXT),
    public.finalize_nj_pwc_daily_run(INTEGER,BOOLEAN) TO service_role;
COMMIT;
