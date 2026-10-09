-- Isolated fixture only. Never run this acceptance file in production.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
    report JSONB := jsonb_build_object(
        'worker_key','nj-pwc','instance_id','00000000-0000-0000-0000-000000000001',
        'started_at',now() - interval '5 minutes','sequence',1,'lifecycle','ready',
        'last_poll_at',now(),'browser_connected',true,'file_modified_at',now() - interval '10 minutes',
        'loaded_hash',repeat('a',64),'current_hash',repeat('a',64),'event','start','message','Synthetic startup');
    old_heartbeat TIMESTAMPTZ;
    diagnostic UUID := '00000000-0000-0000-0000-000000000002';
BEGIN
    IF NOT public.report_compliance_worker(report) THEN RAISE EXCEPTION 'Initial report rejected'; END IF;
    SELECT last_heartbeat_at INTO old_heartbeat FROM compliance_sync_workers WHERE worker_key='nj-pwc';
    IF old_heartbeat IS DISTINCT FROM now() THEN RAISE EXCEPTION 'Heartbeat not server receipt time'; END IF;
    IF NOT EXISTS(SELECT 1 FROM compliance_sync_workers WHERE worker_key='nj-pwc' AND last_poll_at=now())
        THEN RAISE EXCEPTION 'Poll freshness not server receipt time'; END IF;
    IF public.report_compliance_worker(report) THEN RAISE EXCEPTION 'Duplicate sequence accepted'; END IF;
    IF public.report_compliance_worker(report || jsonb_build_object('instance_id','00000000-0000-0000-0000-000000000003','started_at',now() - interval '6 minutes'))
        THEN RAISE EXCEPTION 'Older instance accepted'; END IF;
    IF public.report_compliance_worker(report || jsonb_build_object('started_at',now(),'sequence',2))
        THEN RAISE EXCEPTION 'Same instance changed start time'; END IF;
    UPDATE compliance_sync_workers SET last_poll_at=now() - interval '10 minutes' WHERE worker_key='nj-pwc';
    UPDATE compliance_sync_workers SET test_id=diagnostic, test_requested_at=now(),test_acknowledged_at=NULL WHERE worker_key='nj-pwc';
    IF NOT public.report_compliance_worker(report || jsonb_build_object('sequence',2,'test_id',diagnostic,'event','test','message','Synthetic readiness'))
        THEN RAISE EXCEPTION 'Test report rejected'; END IF;
    IF NOT EXISTS(SELECT 1 FROM compliance_sync_workers WHERE worker_key='nj-pwc' AND test_acknowledged_at=now())
        THEN RAISE EXCEPTION 'Diagnostic not acknowledged'; END IF;
    IF NOT EXISTS(SELECT 1 FROM compliance_sync_workers WHERE worker_key='nj-pwc' AND last_poll_at=now() - interval '10 minutes')
        THEN RAISE EXCEPTION 'Heartbeat incorrectly refreshed an old queue poll'; END IF;
    UPDATE compliance_sync_workers SET test_requested_at=now() - interval '31 seconds',test_acknowledged_at=NULL WHERE worker_key='nj-pwc';
    PERFORM public.report_compliance_worker(report || jsonb_build_object('sequence',3,'test_id',diagnostic));
    IF EXISTS(SELECT 1 FROM compliance_sync_workers WHERE worker_key='nj-pwc' AND test_acknowledged_at IS NOT NULL)
        THEN RAISE EXCEPTION 'Expired diagnostic accepted'; END IF;
    PERFORM public.report_compliance_worker(report || jsonb_build_object('sequence',4,'event','search','message','No Match Found','result_status','No Match Found','request_id',62));
    IF NOT EXISTS(SELECT 1 FROM compliance_sync_workers WHERE worker_key='nj-pwc' AND last_search_request_id=62 AND last_search_result='No Match Found')
        THEN RAISE EXCEPTION 'Search summary missing'; END IF;
    PERFORM public.report_compliance_worker(report || jsonb_build_object('sequence',5,'event','error','message','Synthetic error'));
    IF NOT EXISTS(SELECT 1 FROM compliance_sync_workers WHERE worker_key='nj-pwc' AND last_error='Synthetic error')
        THEN RAISE EXCEPTION 'Error summary missing'; END IF;
    FOR i IN 6..210 LOOP
        PERFORM public.report_compliance_worker(report || jsonb_build_object('sequence',i));
    END LOOP;
    IF (SELECT count(*) FROM compliance_sync_worker_events WHERE worker_key='nj-pwc') <> 200
        THEN RAISE EXCEPTION 'Retention not capped at 200'; END IF;
    IF public.report_compliance_worker(report || jsonb_build_object('worker_key','ny'))
        THEN RAISE EXCEPTION 'Disabled future worker accepted'; END IF;
    IF NOT public.report_compliance_worker(report || jsonb_build_object('instance_id','00000000-0000-0000-0000-000000000003','started_at',now(),'sequence',1))
        THEN RAISE EXCEPTION 'New instance rejected'; END IF;
    IF public.report_compliance_worker(report || jsonb_build_object('sequence',999))
        THEN RAISE EXCEPTION 'Superseded instance overwrote new worker'; END IF;
END;
$$;
RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
    BEGIN
        PERFORM * FROM compliance_sync_workers;
        RAISE EXCEPTION 'Direct authenticated read allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
    BEGIN
        PERFORM public.report_compliance_worker('{}');
        RAISE EXCEPTION 'Authenticated telemetry allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
SET LOCAL ROLE anon;
DO $$
BEGIN
    BEGIN
        INSERT INTO compliance_sync_worker_events(worker_key,event,message) VALUES('nj-pwc','start','Unauthorized');
        RAISE EXCEPTION 'Anonymous write allowed';
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
END;
$$;
ROLLBACK;
