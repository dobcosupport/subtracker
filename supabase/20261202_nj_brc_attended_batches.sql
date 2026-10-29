-- Attended, explicitly started batches. No jobs, source submissions, or approvals.
BEGIN;

ALTER TABLE public.nj_brc_verification_sessions
    DROP CONSTRAINT nj_brc_verification_sessions_status_check,
    ADD CONSTRAINT nj_brc_verification_sessions_status_check
        CHECK (status IN ('prepared', 'running', 'paused', 'stopped', 'completed')),
    ADD COLUMN last_error TEXT;
ALTER TABLE public.nj_brc_verification_session_members ADD COLUMN reason TEXT;
CREATE UNIQUE INDEX nj_brc_verification_member_one_request
    ON public.nj_brc_verification_session_members(request_id) WHERE request_id IS NOT NULL;
ALTER TABLE public.nj_brc_verification_session_events
    ALTER COLUMN actor_id DROP NOT NULL,
    DROP CONSTRAINT nj_brc_verification_session_events_action_check,
    DROP CONSTRAINT nj_brc_verification_session_events_from_status_check,
    DROP CONSTRAINT nj_brc_verification_session_events_to_status_check,
    ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'admin' CHECK (actor_kind IN ('admin', 'worker')),
    ADD COLUMN worker_instance_id UUID,
    ADD CONSTRAINT nj_brc_verification_session_events_action_check
        CHECK (action IN ('prepared', 'start', 'pause', 'resume', 'stop', 'complete')),
    ADD CONSTRAINT nj_brc_verification_session_events_from_status_check
        CHECK (from_status IS NULL OR from_status IN ('prepared','running','paused','stopped','completed')),
    ADD CONSTRAINT nj_brc_verification_session_events_to_status_check
        CHECK (to_status IN ('prepared','running','paused','stopped','completed')),
    ADD CONSTRAINT nj_brc_verification_session_events_actor_check
        CHECK ((actor_kind = 'admin' AND actor_id IS NOT NULL AND worker_instance_id IS NULL)
            OR (actor_kind = 'worker' AND actor_id IS NULL AND worker_instance_id IS NOT NULL));

CREATE FUNCTION public.audit_nj_brc_batch_transition(
    p_session UUID, p_action TEXT, p_from TEXT, p_to TEXT, p_actor UUID, p_instance UUID
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE actor public.user_profiles%ROWTYPE;
BEGIN
    IF p_actor IS NOT NULL THEN
        SELECT * INTO actor FROM public.user_profiles WHERE auth_user_id = p_actor;
    END IF;
    INSERT INTO public.nj_brc_verification_session_events(
        session_id, actor_id, actor_kind, worker_instance_id, action, from_status, to_status)
    VALUES (p_session, p_actor, CASE WHEN p_actor IS NULL THEN 'worker' ELSE 'admin' END,
        p_instance, p_action, p_from, p_to);
    INSERT INTO public.administration_audit_log(
        user_id,user_name,user_email,action,object_type,object_id,object_label,details)
    VALUES (p_actor, CASE WHEN p_actor IS NULL THEN 'NJ BRC Worker' ELSE actor.name END,
        coalesce(actor.email,''), 'NJ_BRC_BATCH_' || upper(p_action),
        'nj_brc_verification_sessions',p_session::TEXT,'NJ BRC attended session',
        jsonb_build_object('from_status',p_from,'to_status',p_to,'worker_instance_id',p_instance));
END;
$$;

CREATE OR REPLACE FUNCTION public.set_nj_brc_verification_session_state(p_session_id UUID, p_action TEXT)
RETURNS TABLE(id UUID, status TEXT, updated_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    actor public.user_profiles%ROWTYPE;
    s public.nj_brc_verification_sessions%ROWTYPE;
    next_status TEXT;
BEGIN
    IF NOT coalesce(public.user_has_module_permission('compliance_sync','manage'),FALSE) THEN
        RAISE EXCEPTION 'Compliance Sync manage permission required' USING ERRCODE = '42501';
    END IF;
    SELECT profile.* INTO actor FROM public.user_profiles profile
    WHERE profile.auth_user_id = auth.uid() AND profile.status = 'Active';
    IF NOT FOUND THEN RAISE EXCEPTION 'Active user profile required' USING ERRCODE = '42501'; END IF;
    IF p_action IS NULL OR p_action NOT IN ('start','pause','resume','stop') THEN
        RAISE EXCEPTION 'Action must be start, pause, resume, or stop.' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO s FROM public.nj_brc_verification_sessions q WHERE q.id = p_session_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ BRC verification session not found.' USING ERRCODE = 'P0002'; END IF;
    IF (p_action = 'start' AND s.status <> 'prepared')
       OR (p_action = 'resume' AND s.status <> 'paused')
       OR (p_action = 'pause' AND s.status NOT IN ('prepared','running'))
       OR (p_action = 'stop' AND s.status NOT IN ('prepared','running','paused')) THEN
        RAISE EXCEPTION 'The requested session transition is not valid from its current state.' USING ERRCODE = '55000';
    END IF;
    next_status := CASE p_action WHEN 'start' THEN 'running' WHEN 'resume' THEN 'running'
        WHEN 'pause' THEN 'paused' ELSE 'stopped' END;
    UPDATE public.nj_brc_verification_sessions q
    SET status = next_status, updated_by = actor.auth_user_id, updated_at = now(), last_error = NULL
    WHERE q.id = p_session_id;
    PERFORM public.audit_nj_brc_batch_transition(p_session_id,p_action,s.status,next_status,actor.auth_user_id,NULL);
    RETURN QUERY SELECT q.id,q.status,q.updated_at FROM public.nj_brc_verification_sessions q WHERE q.id = p_session_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_nj_brc_verification_session(p_session_id UUID)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT jsonb_build_object(
        'id',s.id,'status',s.status,'created_at',s.created_at,'updated_at',s.updated_at,
        'member_count',s.member_count,'last_error',s.last_error,
        'completed_count',(SELECT count(*) FROM public.nj_brc_verification_session_members m WHERE m.session_id=s.id AND m.state='completed'),
        'skipped_count',(SELECT count(*) FROM public.nj_brc_verification_session_members m WHERE m.session_id=s.id AND m.state='skipped'),
        'current_ordinal',(SELECT min(m.ordinal) FROM public.nj_brc_verification_session_members m WHERE m.session_id=s.id AND m.state='prepared'),
        'members',coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                'contractor_id',m.contractor_id,'ordinal',m.ordinal,'request_id',m.request_id,
                'state',m.state,'reason',m.reason,'skip_reason',CASE WHEN m.state='skipped' THEN m.reason END,
                'completed_at',m.completed_at,'skipped_at',m.skipped_at,
                'company_name',c.company_name,'request_status',r.status,'request_result',r.result_type,
                'result_type',r.result_type,'error_code',r.error_code,'review_queue_id',r.review_queue_id
            ) ORDER BY m.ordinal)
            FROM public.nj_brc_verification_session_members m
            JOIN public.contractors c ON c.id=m.contractor_id
            LEFT JOIN public.nj_brc_search_requests r ON r.id=m.request_id
            WHERE m.session_id=s.id
        ),'[]'::JSONB))
    FROM public.nj_brc_verification_sessions s WHERE s.id=p_session_id;
$$;

CREATE FUNCTION public.list_nj_brc_verification_sessions()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH recent AS MATERIALIZED (
        SELECT s.id,s.status,s.created_at,s.updated_at,s.member_count,s.last_error
        FROM public.nj_brc_verification_sessions s
        ORDER BY s.created_at DESC,s.id DESC LIMIT 100
    ), summaries AS (
        SELECT s.*,counts.completed_count,counts.skipped_count,counts.current_ordinal
        FROM recent s
        CROSS JOIN LATERAL (
            SELECT count(*) FILTER (WHERE m.state='completed') AS completed_count,
                count(*) FILTER (WHERE m.state='skipped') AS skipped_count,
                min(m.ordinal) FILTER (WHERE m.state='prepared') AS current_ordinal
            FROM public.nj_brc_verification_session_members m WHERE m.session_id=s.id
        ) counts
    )
    SELECT jsonb_build_object(
        'sessions',coalesce((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.created_at DESC,s.id DESC)
            FROM summaries s),'[]'::JSONB),
        'total',(SELECT count(*) FROM public.nj_brc_verification_sessions));
$$;

-- This internal formatter never exposes FEIN, raw evidence, or worker keys.
-- Only next's newly claimed row includes the immutable NJ submission input.
CREATE FUNCTION public.nj_brc_batch_response(p_session UUID, p_member BIGINT DEFAULT NULL, p_new_request BOOLEAN DEFAULT FALSE)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT jsonb_build_object(
        'session',public.get_nj_brc_verification_session(p_session) - 'members',
        'member',CASE WHEN m.id IS NOT NULL THEN jsonb_build_object(
            'ordinal',m.ordinal,'contractor_id',m.contractor_id,'request_id',m.request_id,
            'state',m.state,'reason',m.reason,'skip_reason',CASE WHEN m.state='skipped' THEN m.reason END,
            'request_status',r.status,'request_result',r.result_type,'result_type',r.result_type,
            'error_code',r.error_code,'review_queue_id',r.review_queue_id) END,
        'request',CASE WHEN p_new_request AND r.id IS NOT NULL THEN jsonb_build_object(
            'id',r.id,'contractor_id',r.contractor_id,'company_name',r.company_name,
            'nj_brc_number',r.nj_brc_number,'brc_name_control',r.brc_name_control,
            'taxpayer_id_submission',r.taxpayer_id_submission,'status',r.status,
            'created_at',r.created_at,'claimed_at',r.claimed_at,'processing_started_at',r.processing_started_at) END)
    FROM (SELECT 1) singleton
    LEFT JOIN public.nj_brc_verification_session_members m ON m.id = coalesce(p_member,(
        SELECT q.id FROM public.nj_brc_verification_session_members q
        WHERE q.session_id=p_session AND q.state='prepared' ORDER BY q.ordinal LIMIT 1))
        AND m.session_id=p_session
    LEFT JOIN public.nj_brc_search_requests r ON r.id=m.request_id;
$$;

CREATE FUNCTION public.get_owned_nj_brc_batch(p_instance UUID, p_session UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_instance);
    IF NOT EXISTS(SELECT 1 FROM public.nj_brc_verification_sessions WHERE id=p_session) THEN
        RAISE EXCEPTION 'NJ BRC verification session not found.' USING ERRCODE = 'P0002';
    END IF;
    RETURN public.nj_brc_batch_response(p_session);
END;
$$;

CREATE FUNCTION public.finish_nj_brc_batch_if_done(p_session UUID, p_instance UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.nj_brc_verification_session_members WHERE session_id=p_session AND state='prepared') THEN
        UPDATE public.nj_brc_verification_sessions SET status='completed',updated_at=now()
        WHERE id=p_session AND status='running';
        IF FOUND THEN PERFORM public.audit_nj_brc_batch_transition(p_session,'complete','running','completed',NULL,p_instance); END IF;
    END IF;
END;
$$;

CREATE FUNCTION public.control_nj_brc_batch(
    p_instance UUID, p_session UUID, p_action TEXT, p_request UUID DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    s public.nj_brc_verification_sessions%ROWTYPE;
    m public.nj_brc_verification_session_members%ROWTYPE;
    r public.nj_brc_search_requests%ROWTYPE;
    c public.contractors%ROWTYPE;
    actor public.user_profiles%ROWTYPE;
    bucket TEXT;
    skip_reason TEXT;
    interrupted BOOLEAN;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_instance);
    IF p_action IS NULL OR p_action NOT IN ('next','complete','pause')
       OR (p_action='complete' AND p_request IS NULL)
       OR (p_action<>'complete' AND p_request IS NOT NULL) THEN
        RAISE EXCEPTION 'Invalid NJ BRC batch action.' USING ERRCODE='22023';
    END IF;
    SELECT * INTO s FROM public.nj_brc_verification_sessions WHERE id=p_session FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ BRC verification session not found.' USING ERRCODE='P0002'; END IF;
    IF p_action='pause' THEN
        IF s.status='running' THEN
            UPDATE public.nj_brc_verification_sessions SET status='paused',updated_at=now(),
                last_error='Worker paused attended session; explicit administrative resume required.'
            WHERE id=p_session;
            PERFORM public.audit_nj_brc_batch_transition(p_session,'pause','running','paused',NULL,p_instance);
        END IF;
        RETURN public.nj_brc_batch_response(p_session);
    END IF;
    IF p_action='complete' THEN
        SELECT * INTO m FROM public.nj_brc_verification_session_members
        WHERE session_id=p_session AND request_id=p_request FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Request is not a member of this session.' USING ERRCODE='55000'; END IF;
    ELSE
        IF s.status<>'running' THEN RETURN public.nj_brc_batch_response(p_session); END IF;
        SELECT * INTO m FROM public.nj_brc_verification_session_members
        WHERE session_id=p_session AND state='prepared' ORDER BY ordinal LIMIT 1 FOR UPDATE;
        IF NOT FOUND THEN
            PERFORM public.finish_nj_brc_batch_if_done(p_session,p_instance);
            RETURN public.nj_brc_batch_response(p_session);
        END IF;
    END IF;

    IF m.request_id IS NOT NULL THEN
        SELECT * INTO r FROM public.nj_brc_search_requests WHERE id=m.request_id FOR UPDATE;
        IF r.result_type IS NOT NULL AND (
            (r.status='review_required' AND r.result_type='successful_certificate' AND EXISTS(
                SELECT 1 FROM public.compliance_sync_review_queue q WHERE q.id=r.review_queue_id
                AND q.nj_brc_request_id=r.id AND q.contractor_id=r.contractor_id
                AND q.compliance_name='NJ BRC' AND q.status='pending' AND q.approval_source='nj-brc-review'))
            OR (r.status IN ('completed','no_match','invalid_input','identity_mismatch','ambiguous_result','website_error','failed')
                AND r.completed_at IS NOT NULL)
        ) THEN
            IF m.state='completed' THEN RETURN public.nj_brc_batch_response(p_session,m.id); END IF;
            interrupted := r.error_code IN ('worker_shutdown','worker_lease_expired','batch_interrupted')
                OR r.result_evidence ? 'interruption';
            IF m.state='prepared' THEN
                UPDATE public.nj_brc_verification_session_members SET state='completed',completed_at=now(),
                    reason=CASE WHEN interrupted THEN 'Interrupted source outcome; never replayed.' ELSE NULL END WHERE id=m.id;
            END IF;
            IF interrupted AND s.status='running' THEN
                UPDATE public.nj_brc_verification_sessions SET status='paused',updated_at=now(),
                    last_error='Interrupted source outcome; administrative review and resume required.' WHERE id=p_session;
                PERFORM public.audit_nj_brc_batch_transition(p_session,'pause','running','paused',NULL,p_instance);
            ELSE
                PERFORM public.finish_nj_brc_batch_if_done(p_session,p_instance);
            END IF;
            RETURN public.nj_brc_batch_response(p_session,m.id);
        END IF;
        IF p_action='complete' THEN
            RAISE EXCEPTION 'Linked NJ BRC result has not safely persisted.' USING ERRCODE='55000';
        END IF;
        -- A second next cannot distinguish a lost delivery from an interrupted
        -- submission. Fail safely and pause, even if the instance ID is reused.
        IF r.status IN ('claimed','processing','human_verification_required') AND r.result_type IS NULL THEN
            PERFORM public.close_interrupted_nj_brc_requests(r.worker_instance_id,'batch_interrupted');
            UPDATE public.nj_brc_verification_session_members SET state='completed',completed_at=now(),
                reason='Interrupted source outcome; never replayed.' WHERE id=m.id AND EXISTS(
                    SELECT 1 FROM public.nj_brc_search_requests q WHERE q.id=m.request_id
                    AND q.status='failed' AND q.result_type='failed' AND q.completed_at IS NOT NULL);
        END IF;
        UPDATE public.nj_brc_verification_sessions SET status='paused',updated_at=now(),
            last_error='Uncertain linked request; administrative review required.' WHERE id=p_session;
        PERFORM public.audit_nj_brc_batch_transition(p_session,'pause','running','paused',NULL,p_instance);
        RETURN public.nj_brc_batch_response(p_session,m.id);
    END IF;
    IF p_action='complete' THEN RAISE EXCEPTION 'Request is not linked.' USING ERRCODE='55000'; END IF;

    IF EXISTS(SELECT 1 FROM public.nj_brc_search_requests
        WHERE status IN ('claimed','processing','human_verification_required') AND result_type IS NULL) THEN
        UPDATE public.nj_brc_verification_sessions SET status='paused',updated_at=now(),
            last_error='Another source request is in flight; administrative review required.' WHERE id=p_session;
        PERFORM public.audit_nj_brc_batch_transition(p_session,'pause','running','paused',NULL,p_instance);
        RETURN public.nj_brc_batch_response(p_session,m.id);
    END IF;

    -- Lease checks include the enabled worker. Settings and creator authorization
    -- are revalidated without impersonating a browser JWT or changing claims.
    SELECT * INTO actor FROM public.user_profiles WHERE auth_user_id=s.created_by AND status='Active';
    IF NOT FOUND OR NOT EXISTS(
        SELECT 1 FROM public.compliance_sync_settings WHERE compliance_name='NJ BRC' AND enabled
    ) OR NOT EXISTS(SELECT 1 FROM public.compliance_types WHERE compliance_name='NJ BRC' AND active) THEN
        UPDATE public.nj_brc_verification_sessions SET status='paused',updated_at=now(),
            last_error='NJ BRC configuration or session creator is no longer active.' WHERE id=p_session;
        PERFORM public.audit_nj_brc_batch_transition(p_session,'pause','running','paused',NULL,p_instance);
        RETURN public.nj_brc_batch_response(p_session,m.id);
    END IF;
    SELECT * INTO c FROM public.contractors WHERE id=m.contractor_id FOR UPDATE;
    SELECT q.bucket INTO bucket FROM public.nj_brc_verification_queue q WHERE q.contractor_id=m.contractor_id;
    skip_reason := CASE
        WHEN c.active IS DISTINCT FROM TRUE THEN 'Contractor is no longer active.'
        WHEN nullif(trim(c.company_name),'') IS NULL
          OR coalesce(c.brc_name_control,'') !~ '^[A-Za-z0-9&-]{4}$'
          OR coalesce(c.federal_tax_id,'') !~ '^[0-9[:space:]().-]+$'
          OR length(regexp_replace(coalesce(c.federal_tax_id,''),'[^0-9]','','g'))<>9
            THEN 'Current contractor lookup inputs are missing or invalid.'
        WHEN bucket IS NULL OR bucket NOT IN ('ready','no_result','failed')
            THEN 'Current NJ BRC data, request, or review requires attention; no request created.'
        ELSE NULL END;
    IF skip_reason IS NOT NULL THEN
        UPDATE public.nj_brc_verification_session_members SET state='skipped',skipped_at=now(),reason=skip_reason WHERE id=m.id;
        PERFORM public.finish_nj_brc_batch_if_done(p_session,p_instance);
        RETURN public.nj_brc_batch_response(p_session,m.id);
    END IF;
    -- Reuse the canonical immutable request table, identifier CHECK, active
    -- contractor unique index, ownership fields, and existing report/review RPCs.
    INSERT INTO public.nj_brc_search_requests(
        contractor_id,company_name,nj_brc_number,brc_name_control,federal_tax_id,taxpayer_id_submission,
        status,claim_worker_key,worker_instance_id,claimed_at)
    VALUES(c.id,c.company_name,c.nj_brc_number,c.brc_name_control,c.federal_tax_id,
        regexp_replace(c.federal_tax_id,'[^0-9]','','g') || '000','claimed','nj-brc',p_instance,now())
    RETURNING * INTO r;
    UPDATE public.nj_brc_verification_session_members SET request_id=r.id WHERE id=m.id;
    INSERT INTO public.administration_audit_log(
        user_id,user_name,user_email,action,object_type,object_id,object_label,details)
    VALUES(s.created_by,actor.name,actor.email,'NJ_BRC_BATCH_REQUEST','nj_brc_search_requests',
        r.id::TEXT,'NJ BRC attended request',jsonb_build_object('session_id',p_session,
            'ordinal',m.ordinal,'contractor_id',m.contractor_id,'worker_instance_id',p_instance));
    RETURN public.nj_brc_batch_response(p_session,m.id,TRUE);
END;
$$;

-- The legacy single-request worker must never claim or recover batch members.
CREATE OR REPLACE FUNCTION public.claim_nj_brc_search_request(p_worker_instance_id UUID)
RETURNS TABLE(id UUID, contractor_id INTEGER, company_name TEXT, nj_brc_number TEXT,
    brc_name_control TEXT, taxpayer_id_submission TEXT, status TEXT, created_at TIMESTAMPTZ,
    claimed_at TIMESTAMPTZ, processing_started_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE r public.nj_brc_search_requests%ROWTYPE;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    IF EXISTS(SELECT 1 FROM public.nj_brc_search_requests q
        JOIN public.nj_brc_verification_session_members m ON m.request_id=q.id
        WHERE q.status IN ('claimed','processing','human_verification_required')) THEN RETURN; END IF;
    SELECT * INTO r FROM public.nj_brc_search_requests q
    WHERE q.worker_instance_id=p_worker_instance_id
      AND q.status IN ('claimed','processing','human_verification_required')
      AND NOT EXISTS(SELECT 1 FROM public.nj_brc_verification_session_members m WHERE m.request_id=q.id)
    ORDER BY q.claimed_at DESC LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
        SELECT * INTO r FROM public.nj_brc_search_requests q WHERE q.status='pending'
          AND NOT EXISTS(SELECT 1 FROM public.nj_brc_verification_session_members m WHERE m.request_id=q.id)
        ORDER BY q.created_at,q.id LIMIT 1 FOR UPDATE SKIP LOCKED;
        IF NOT FOUND THEN RETURN; END IF;
        UPDATE public.nj_brc_search_requests q SET status='claimed',claim_worker_key='nj-brc',
            worker_instance_id=p_worker_instance_id,claimed_at=now(),updated_at=now()
        WHERE q.id=r.id RETURNING * INTO r;
    END IF;
    RETURN QUERY SELECT r.id,r.contractor_id,r.company_name::TEXT,r.nj_brc_number::TEXT,
        r.brc_name_control::TEXT,r.taxpayer_id_submission::TEXT,r.status,r.created_at,r.claimed_at,r.processing_started_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_nj_brc_search_request_state(
    p_request_id UUID, p_worker_instance_id UUID, p_status TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s public.nj_brc_verification_sessions%ROWTYPE;
BEGIN
    PERFORM public.assert_nj_brc_worker_lease(p_worker_instance_id);
    SELECT q.* INTO s FROM public.nj_brc_verification_sessions q
    JOIN public.nj_brc_verification_session_members m ON m.session_id=q.id
    WHERE m.request_id=p_request_id FOR UPDATE OF q;
    IF FOUND AND s.status<>'running' THEN
        RAISE EXCEPTION 'NJ BRC attended session is not running.' USING ERRCODE='55000';
    END IF;
    IF p_status IS NULL OR p_status NOT IN ('processing','human_verification_required') THEN
        RAISE EXCEPTION 'Invalid NJ BRC transition' USING ERRCODE='22023';
    END IF;
    UPDATE public.nj_brc_search_requests q SET status=p_status,updated_at=now(),
        processing_started_at=CASE WHEN p_status='processing' THEN coalesce(q.processing_started_at,now()) ELSE q.processing_started_at END
    WHERE q.id=p_request_id AND q.worker_instance_id=p_worker_instance_id AND q.claim_worker_key='nj-brc'
      AND q.status IN ('claimed','processing','human_verification_required') AND q.result_type IS NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'NJ BRC request state or ownership changed' USING ERRCODE='55000'; END IF;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_nj_brc_batch_transition(UUID,TEXT,TEXT,TEXT,UUID,UUID) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.nj_brc_batch_response(UUID,BIGINT,BOOLEAN) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.finish_nj_brc_batch_if_done(UUID,UUID) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.get_owned_nj_brc_batch(UUID,UUID) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.list_nj_brc_verification_sessions() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.control_nj_brc_batch(UUID,UUID,TEXT,UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.get_owned_nj_brc_batch(UUID,UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.list_nj_brc_verification_sessions() TO service_role;
GRANT EXECUTE ON FUNCTION public.control_nj_brc_batch(UUID,UUID,TEXT,UUID) TO service_role;

COMMIT;
