-- Graceful Stop Run for NJ PWC automatic daily sync.
-- Cancellation happens at the batch boundary: a stop request marks the run,
-- the atomic queue stops claiming that run's unstarted automatic searches,
-- any already claimed/processing search finishes normally through the
-- unchanged completion path, and the run is recorded as Cancelled only once
-- no active automatic work remains. The worker process, Priority 0 user
-- searches, and the recurring daily schedule are not affected.
-- Apply after 20261019_nj_pwc_daily_sync_schedule.sql.
BEGIN;

ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS stop_requested_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS stop_requested_by VARCHAR(200);

ALTER TABLE public.compliance_sync_runs
    DROP CONSTRAINT IF EXISTS chk_compliance_sync_runs_run_status;
ALTER TABLE public.compliance_sync_runs
    ADD CONSTRAINT chk_compliance_sync_runs_run_status
    CHECK (run_status IS NULL OR run_status IN ('Running','Completed','Completed With Errors','Failed','Cancelled'));

ALTER TABLE public.compliance_sync_search_requests
    DROP CONSTRAINT IF EXISTS compliance_sync_search_requests_status_check;
ALTER TABLE public.compliance_sync_search_requests
    ADD CONSTRAINT compliance_sync_search_requests_status_check
    CHECK (status IN ('pending','claimed','processing','completed','no_match','failed','website_error','cancelled'));

-- The claim itself stays atomic and priority-ordered; it simply never starts
-- an automatic search whose run has a stop request. Requests without a run
-- (Priority 0 user searches) can never match the stop filter.
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
    SELECT * INTO v_request FROM public.compliance_sync_search_requests q
    WHERE q.compliance_name='NJ PWC' AND q.status='pending'
      AND NOT EXISTS (SELECT 1 FROM public.compliance_sync_runs r
          WHERE r.id=q.sync_run_id AND r.stop_requested_at IS NOT NULL)
    ORDER BY q.priority, q.created_at, q.id LIMIT 1 FOR UPDATE SKIP LOCKED;
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

-- Idempotent stop request. Sets the stop flag on the specific active run and,
-- when no claimed/processing automatic work remains, finalizes immediately to
-- Cancelled. Otherwise the run finishes its in-flight search and the regular
-- idle-queue finalization records it as Cancelled.
CREATE OR REPLACE FUNCTION public.request_nj_pwc_daily_run_stop(
    p_run_id INTEGER, p_actor_id UUID, p_actor_name TEXT, p_actor_email TEXT
)
RETURNS TABLE(run_id INTEGER, stop_requested BOOLEAN, already_requested BOOLEAN, run_status TEXT, finished BOOLEAN)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
    v_run public.compliance_sync_runs%ROWTYPE;
    v_actor TEXT := coalesce(nullif(btrim(p_actor_name),''),'Unknown user');
    v_finalize RECORD;
BEGIN
    PERFORM pg_advisory_xact_lock(61015,1);
    SELECT * INTO v_run FROM public.compliance_sync_runs r WHERE r.id=p_run_id FOR UPDATE;
    IF NOT FOUND OR v_run.run_type IS DISTINCT FROM 'nj_pwc_daily' THEN
        RAISE EXCEPTION 'NJ PWC automatic sync run not found.' USING ERRCODE='P0002';
    END IF;
    IF v_run.run_status IS DISTINCT FROM 'Running' THEN
        RETURN QUERY SELECT v_run.id, FALSE, FALSE, v_run.run_status::TEXT, TRUE;
        RETURN;
    END IF;
    IF v_run.stop_requested_at IS NOT NULL THEN
        SELECT * INTO v_finalize FROM public.finalize_nj_pwc_daily_run(v_run.id,FALSE);
        RETURN QUERY SELECT v_run.id, TRUE, TRUE, v_finalize.run_status, v_finalize.finished;
        RETURN;
    END IF;
    UPDATE public.compliance_sync_runs r
    SET stop_requested_at=now(), stop_requested_by=left(v_actor,200)
    WHERE r.id=v_run.id;
    PERFORM public.nj_pwc_write_audit(p_actor_id,v_actor,coalesce(p_actor_email,''),
        public.nj_pwc_audit_action('NJ_PWC_DAILY_RUN_STOP_REQUESTED',v_run.is_test),
        'compliance_sync_run',v_run.id::TEXT,
        public.nj_pwc_audit_label('NJ PWC Daily Sync '||coalesce(v_run.run_date::TEXT,''),v_run.is_test),
        jsonb_build_object('run_id',v_run.id,'run_date',v_run.run_date,'is_test',v_run.is_test,
            'test_mode',v_run.is_test,'manual_run',v_run.manual_run,'stop_requested_by',v_actor));
    SELECT * INTO v_finalize FROM public.finalize_nj_pwc_daily_run(v_run.id,FALSE);
    RETURN QUERY SELECT v_run.id, TRUE, FALSE, v_finalize.run_status, v_finalize.finished;
END $$;

-- Finalization with graceful-stop handling. A stop-requested run does not wait
-- for unstarted searches: they are cancelled (never failures, never counted,
-- never exceptions) and the run is recorded as Cancelled. Pending batch
-- expirations are withheld, exactly as the circuit breaker withholds them,
-- because a stopped batch is not a complete registry pass.
CREATE OR REPLACE FUNCTION public.finalize_nj_pwc_unclaimed_run(
    p_run_id INTEGER,
    p_force BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
    run_id INTEGER,
    finished BOOLEAN,
    run_status TEXT,
    total INTEGER,
    pending INTEGER,
    succeeded INTEGER,
    failures INTEGER,
    review_required INTEGER,
    infrastructure INTEGER,
    expired INTEGER,
    expirations_withheld INTEGER,
    circuit_breaker BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    v_run public.compliance_sync_runs%ROWTYPE;
    v_settings public.compliance_sync_settings%ROWTYPE;
    v_pending INTEGER;
    v_cancelled INTEGER := 0;
    v_total INTEGER;
    v_success INTEGER;
    v_failure INTEGER;
    v_review INTEGER;
    v_infra INTEGER;
    v_approved INTEGER;
    v_changes INTEGER;
    v_expired INTEGER := 0;
    v_withheld INTEGER := 0;
    v_breaker BOOLEAN := FALSE;
    v_row RECORD;
    v_apply RECORD;
    v_review_id INTEGER;
    v_status TEXT;
    v_actor CONSTANT TEXT := 'NJ PWC Daily Sync';
BEGIN
    SELECT * INTO v_run FROM public.compliance_sync_runs r WHERE r.id = p_run_id FOR UPDATE;
    IF NOT FOUND OR v_run.run_type IS DISTINCT FROM 'nj_pwc_daily' THEN
        RAISE EXCEPTION 'NJ PWC daily run not found' USING ERRCODE = 'no_data_found';
    END IF;

    SELECT count(*) INTO v_pending FROM public.compliance_sync_search_requests q
    WHERE q.sync_run_id = p_run_id AND q.status = 'pending';

    IF v_run.run_status IS DISTINCT FROM 'Running' THEN
        RETURN QUERY SELECT v_run.id, TRUE, v_run.run_status::TEXT, v_run.records_checked, v_pending,
            NULL::INTEGER, v_run.failures, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::BOOLEAN;
        RETURN;
    END IF;

    IF v_pending > 0 AND NOT coalesce(p_force, FALSE) AND v_run.stop_requested_at IS NULL THEN
        RETURN QUERY SELECT v_run.id, FALSE, 'Running'::TEXT, NULL::INTEGER, v_pending,
            NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::INTEGER, NULL::BOOLEAN;
        RETURN;
    END IF;

    IF v_run.stop_requested_at IS NOT NULL THEN
        -- Graceful stop: unstarted searches leave the queue as cancelled.
        UPDATE public.compliance_sync_search_requests q SET
            status = 'cancelled', processed_at = now(), completed_at = now(), updated_at = now()
        WHERE q.sync_run_id = p_run_id AND q.status = 'pending';
        GET DIAGNOSTICS v_cancelled = ROW_COUNT;
    ELSIF coalesce(p_force, FALSE) THEN
        -- Forced finalization: unprocessed searches are infrastructure outcomes.
        FOR v_row IN
            SELECT q.id, q.contractor_id, q.is_test FROM public.compliance_sync_search_requests q
            WHERE q.sync_run_id = p_run_id AND q.status = 'pending'
            ORDER BY q.id
            FOR UPDATE
        LOOP
            UPDATE public.compliance_sync_search_requests q SET
                status = 'failed', result_status = 'RPA Error',
                error_message = 'Daily run finalized before the search was processed.',
                sync_outcome = 'infrastructure:Registry Unavailable',
                processed_at = now(), completed_at = now(), updated_at = now()
            WHERE q.id = v_row.id;
            PERFORM public.nj_pwc_upsert_exception(
                v_row.contractor_id, v_row.is_test, 'Registry Unavailable', 'infrastructure',
                coalesce((SELECT s.consecutive_failure_count FROM public.nj_pwc_sync_state s
                          WHERE s.contractor_id = v_row.contractor_id AND s.is_test = v_row.is_test), 0),
                p_run_id, v_row.id, NULL,
                jsonb_build_object('result_status', 'RPA Error', 'error_message', 'Search not processed before the run was finalized.')
            );
        END LOOP;
    END IF;

    SELECT count(*),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'success:%'),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'failure:%'),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'review:%'),
           count(*) FILTER (WHERE q.sync_outcome LIKE 'infrastructure:%' OR q.sync_outcome IS NULL),
           count(*) FILTER (WHERE q.sync_outcome = 'success:auto_approved'),
           count(*) FILTER (WHERE q.sync_outcome IN ('success:auto_approved', 'success:review_required_update'))
    INTO v_total, v_success, v_failure, v_review, v_infra, v_approved, v_changes
    FROM public.compliance_sync_search_requests q
    WHERE q.sync_run_id = p_run_id AND q.status <> 'cancelled';

    -- Circuit breaker: a registry-wide problem must not expire contractors.
    IF ((v_total - v_infra) >= 5 AND v_failure * 2 > (v_total - v_infra))
       OR (v_total >= 5 AND v_infra * 2 > v_total) THEN
        v_breaker := TRUE;
    END IF;

    SELECT * INTO v_settings FROM public.compliance_sync_settings s WHERE s.compliance_name = 'NJ PWC';

    FOR v_row IN
        SELECT s.contractor_id, s.consecutive_failure_count, c.company_name
        FROM public.nj_pwc_sync_state s
        JOIN public.contractors c ON c.id = s.contractor_id
        WHERE s.pending_expiration_run_id = p_run_id AND s.is_test = v_run.is_test
        ORDER BY s.contractor_id
    LOOP
        IF v_breaker OR v_run.stop_requested_at IS NOT NULL THEN
            UPDATE public.nj_pwc_sync_state s SET pending_expiration_run_id = NULL, updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND s.is_test = v_run.is_test;
            v_withheld := v_withheld + 1;
            CONTINUE;
        END IF;

        PERFORM 1 FROM public.contractors c WHERE c.id = v_row.contractor_id FOR UPDATE;

        IF v_run.is_test THEN
            UPDATE public.nj_pwc_sync_state s
            SET state = 'Expired', expired_at = now(), pending_expiration_run_id = NULL,
                dry_run_action = CASE WHEN v_settings.mode = 'auto_approve' THEN 'would_expire'
                                      ELSE 'would_propose_expiration' END,
                dry_run_action_at = now(), updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND s.is_test;
            v_expired := v_expired + 1;
            PERFORM public.nj_pwc_write_audit(
                NULL, v_actor, '',
                CASE WHEN v_settings.mode = 'auto_approve' THEN 'NJ_PWC_TEST_MODE_WOULD_EXPIRE'
                     ELSE 'NJ_PWC_TEST_MODE_WOULD_PROPOSE_EXPIRATION' END,
                'contractor', v_row.contractor_id::TEXT, public.nj_pwc_audit_label(v_row.company_name, TRUE),
                jsonb_build_object('test_mode', TRUE, 'compliance_records_modified', FALSE,
                    'mode', v_settings.mode, 'sync_run_id', p_run_id,
                    'consecutive_failure_count', v_row.consecutive_failure_count,
                    'threshold', v_settings.failure_expire_threshold)
            );
        ELSIF v_settings.mode = 'auto_approve' THEN
            SELECT * INTO v_apply FROM public.nj_pwc_expire_active_record(
                v_row.contractor_id, v_actor, p_run_id,
                'NJ PWC registration not found in the registry after '
                    || v_row.consecutive_failure_count || ' consecutive daily sync failures.'
            );
            UPDATE public.nj_pwc_sync_state s
            SET state = 'Expired', expired_at = now(), pending_expiration_run_id = NULL, updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND NOT s.is_test;
            IF v_apply.record_action = 'expired' THEN
                v_expired := v_expired + 1;
                PERFORM public.nj_pwc_write_audit(
                    NULL, v_actor, '', 'NJ_PWC_SYNC_EXPIRED', 'contractor',
                    v_row.contractor_id::TEXT, v_row.company_name,
                    jsonb_build_object('sync_run_id', p_run_id,
                        'consecutive_failure_count', v_row.consecutive_failure_count,
                        'threshold', v_settings.failure_expire_threshold,
                        'compliance_record_id', v_apply.record_id,
                        'old_values', v_apply.old_values, 'new_values', v_apply.new_values)
                );
            END IF;
        ELSE
            v_review_id := public.nj_pwc_upsert_review(
                v_row.contractor_id, p_run_id, NULL, 'Expiration Proposed', 'No Match Found', NULL,
                'Expired - Not Found in Registry',
                'Not found in the NJ PWC registry after ' || v_row.consecutive_failure_count
                    || ' consecutive daily sync failures.',
                'NJ PWC daily sync expiration proposal (review_required mode).'
            );
            UPDATE public.nj_pwc_sync_state s SET pending_expiration_run_id = NULL, updated_at = now()
            WHERE s.contractor_id = v_row.contractor_id AND NOT s.is_test;
            UPDATE public.nj_pwc_sync_exceptions e SET review_queue_id = v_review_id, updated_at = now()
            WHERE e.contractor_id = v_row.contractor_id AND NOT e.is_test AND e.status = 'open' AND e.kind = 'failure';
            v_expired := v_expired + 1;
        END IF;

        UPDATE public.nj_pwc_sync_exceptions e SET expired_by_sync = TRUE, updated_at = now()
        WHERE e.contractor_id = v_row.contractor_id AND e.is_test = v_run.is_test
          AND e.status = 'open' AND e.kind = 'failure'
          AND (v_run.is_test OR v_settings.mode = 'auto_approve');
    END LOOP;

    v_status := CASE WHEN v_run.stop_requested_at IS NOT NULL THEN 'Cancelled'
                     WHEN v_infra > 0 OR v_breaker THEN 'Completed With Errors' ELSE 'Completed' END;
    UPDATE public.compliance_sync_runs r SET
        run_status = v_status,
        -- Legacy status is VARCHAR(20); 'completed_with_errors' does not fit,
        -- so run_status carries the detailed outcome.
        status = 'completed',
        completed_at = now(),
        records_checked = v_total,
        changes_detected = v_changes + v_expired,
        records_approved = v_approved,
        records_failed = v_failure + v_infra,
        failures = v_failure + v_infra,
        notes = coalesce(r.notes, '')
            || CASE WHEN v_breaker THEN ' Circuit breaker tripped: ' || v_withheld || ' expiration(s) withheld.' ELSE '' END
            || CASE WHEN coalesce(p_force, FALSE) AND v_pending > 0 AND v_run.stop_requested_at IS NULL
                    THEN ' Finalized with ' || v_pending || ' unprocessed search(es).' ELSE '' END
            || CASE WHEN v_run.stop_requested_at IS NOT NULL
                    THEN ' Stopped by ' || coalesce(v_run.stop_requested_by, 'user') || '; '
                        || v_cancelled || ' unstarted search(es) cancelled.'
                        || CASE WHEN v_withheld > 0 THEN ' ' || v_withheld || ' expiration(s) withheld.' ELSE '' END
                    ELSE '' END
    WHERE r.id = p_run_id;

    IF NOT v_run.is_test THEN
        UPDATE public.compliance_sync_settings s SET last_sync_at = now(), updated_at = now()
        WHERE s.compliance_name = 'NJ PWC';
    END IF;

    PERFORM public.nj_pwc_write_audit(
        NULL, v_actor, '', public.nj_pwc_audit_action('NJ_PWC_DAILY_SYNC_COMPLETED', v_run.is_test),
        'compliance_sync_run', p_run_id::TEXT,
        public.nj_pwc_audit_label('NJ PWC Daily Sync ' || coalesce(v_run.run_date::TEXT, ''), v_run.is_test),
        jsonb_build_object('run_status', v_status, 'is_test', v_run.is_test, 'mode', v_settings.mode,
            'test_mode', v_run.is_test, 'compliance_records_modified', NOT v_run.is_test,
            'total', v_total, 'succeeded', v_success, 'failures', v_failure, 'review_required', v_review,
            'infrastructure', v_infra, 'expired', v_expired, 'expirations_withheld', v_withheld,
            'circuit_breaker', v_breaker, 'forced', coalesce(p_force, FALSE), 'unprocessed', v_pending,
            'stop_requested', v_run.stop_requested_at IS NOT NULL, 'cancelled', v_cancelled)
    );

    RETURN QUERY SELECT p_run_id, TRUE, v_status, v_total, 0, v_success, v_failure, v_review, v_infra,
        v_expired, v_withheld, v_breaker;
END;
$$;

REVOKE ALL ON FUNCTION public.request_nj_pwc_daily_run_stop(INTEGER,UUID,TEXT,TEXT)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.request_nj_pwc_daily_run_stop(INTEGER,UUID,TEXT,TEXT) TO service_role;

COMMIT;
