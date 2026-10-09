BEGIN;

CREATE TABLE public.compliance_sync_workers (
    worker_key TEXT PRIMARY KEY CHECK (worker_key IN ('nj-pwc', 'ny')),
    display_name TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT false,
    instance_id UUID,
    started_at TIMESTAMPTZ,
    last_heartbeat_at TIMESTAMPTZ,
    lifecycle TEXT CHECK (lifecycle IN ('starting', 'ready', 'busy', 'stopped')),
    last_poll_at TIMESTAMPTZ,
    last_poll_reported_at TIMESTAMPTZ,
    browser_connected BOOLEAN NOT NULL DEFAULT false,
    file_modified_at TIMESTAMPTZ,
    loaded_hash TEXT,
    current_hash TEXT,
    report_sequence BIGINT NOT NULL DEFAULT 0,
    current_request_id BIGINT,
    last_search_at TIMESTAMPTZ,
    last_search_request_id BIGINT,
    last_search_result TEXT,
    last_error_at TIMESTAMPTZ,
    last_error TEXT,
    test_id UUID,
    test_requested_at TIMESTAMPTZ,
    test_acknowledged_at TIMESTAMPTZ
);

INSERT INTO public.compliance_sync_workers (worker_key, display_name, enabled)
VALUES ('nj-pwc', 'NJ PWC Worker', true), ('ny', 'Future NY Worker', false);

CREATE TABLE public.compliance_sync_worker_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    worker_key TEXT NOT NULL REFERENCES public.compliance_sync_workers(worker_key),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    event TEXT NOT NULL CHECK (event IN ('start', 'stop', 'search', 'error', 'test')),
    message TEXT NOT NULL,
    request_id BIGINT
);
CREATE INDEX compliance_sync_worker_events_recent
    ON public.compliance_sync_worker_events (worker_key, id DESC);

ALTER TABLE public.compliance_sync_workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.compliance_sync_worker_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.compliance_sync_workers, public.compliance_sync_worker_events FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.compliance_sync_workers, public.compliance_sync_worker_events TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.compliance_sync_worker_events_id_seq TO service_role;

-- Server-only, serialized ingestion prevents older instances/reports overwriting health.
CREATE FUNCTION public.report_compliance_worker(p_report JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
    worker public.compliance_sync_workers%ROWTYPE;
    incoming_start TIMESTAMPTZ := (p_report->>'started_at')::timestamptz;
    incoming_instance UUID := (p_report->>'instance_id')::uuid;
    incoming_sequence BIGINT := (p_report->>'sequence')::bigint;
    incoming_poll TIMESTAMPTZ := (p_report->>'last_poll_at')::timestamptz;
BEGIN
    SELECT * INTO worker FROM public.compliance_sync_workers
    WHERE worker_key = p_report->>'worker_key' FOR UPDATE;
    IF NOT FOUND OR NOT worker.enabled THEN RETURN false; END IF;
    IF worker.instance_id IS DISTINCT FROM incoming_instance THEN
        IF worker.started_at IS NOT NULL AND incoming_start <= worker.started_at THEN RETURN false; END IF;
    ELSIF incoming_start IS DISTINCT FROM worker.started_at OR incoming_sequence <= worker.report_sequence THEN
        RETURN false;
    END IF;

    UPDATE public.compliance_sync_workers SET
        instance_id = incoming_instance,
        started_at = incoming_start,
        last_heartbeat_at = now(),
        lifecycle = p_report->>'lifecycle',
        last_poll_at = CASE WHEN incoming_poll IS NULL THEN NULL
            WHEN worker.instance_id IS DISTINCT FROM incoming_instance
                OR incoming_poll IS DISTINCT FROM worker.last_poll_reported_at THEN now()
            ELSE worker.last_poll_at END,
        last_poll_reported_at = incoming_poll,
        browser_connected = (p_report->>'browser_connected')::boolean,
        file_modified_at = (p_report->>'file_modified_at')::timestamptz,
        loaded_hash = p_report->>'loaded_hash',
        current_hash = p_report->>'current_hash',
        report_sequence = incoming_sequence,
        current_request_id = (p_report->>'current_request_id')::bigint,
        last_search_at = CASE WHEN p_report->>'event' = 'search' THEN now() ELSE last_search_at END,
        last_search_request_id = CASE WHEN p_report->>'event' = 'search' THEN (p_report->>'request_id')::bigint ELSE last_search_request_id END,
        last_search_result = CASE WHEN p_report->>'event' = 'search' THEN p_report->>'result_status' ELSE last_search_result END,
        last_error_at = CASE WHEN p_report->>'event' = 'error' THEN now() ELSE last_error_at END,
        last_error = CASE WHEN p_report->>'event' = 'error' THEN p_report->>'message' ELSE last_error END,
        test_acknowledged_at = CASE
            WHEN test_id::text = p_report->>'test_id'
                AND test_requested_at > now() - interval '30 seconds'
                AND (p_report->>'browser_connected')::boolean
                AND p_report->>'lifecycle' IN ('ready', 'busy') THEN now()
            ELSE test_acknowledged_at END
    WHERE worker_key = worker.worker_key;

    IF p_report->>'event' IS NOT NULL THEN
        INSERT INTO public.compliance_sync_worker_events(worker_key, event, message, request_id)
        VALUES(worker.worker_key, p_report->>'event', p_report->>'message', (p_report->>'request_id')::bigint);
        -- Keep only the most recent 200 operational events per worker.
        DELETE FROM public.compliance_sync_worker_events
        WHERE worker_key = worker.worker_key AND id IN (
            SELECT id FROM public.compliance_sync_worker_events
            WHERE worker_key = worker.worker_key ORDER BY id DESC OFFSET 200
        );
    END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.report_compliance_worker(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.report_compliance_worker(JSONB) TO service_role;

COMMIT;
