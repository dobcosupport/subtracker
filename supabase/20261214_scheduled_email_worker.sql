BEGIN;

CREATE TABLE public.communication_email_worker_settings (
    singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK(singleton),
    enabled BOOLEAN NOT NULL DEFAULT false,
    activated_at TIMESTAMPTZ,
    batch_size INTEGER NOT NULL DEFAULT 5 CHECK(batch_size BETWEEN 1 AND 5),
    retry_policy TEXT NOT NULL DEFAULT 'pre_dispatch_only' CHECK(retry_policy IN('none','pre_dispatch_only')),
    retry_delay_seconds INTEGER NOT NULL DEFAULT 300 CHECK(retry_delay_seconds BETWEEN 30 AND 86400),
    maximum_attempts INTEGER NOT NULL DEFAULT 5 CHECK(maximum_attempts BETWEEN 1 AND 20),
    stale_claim_seconds INTEGER NOT NULL DEFAULT 600 CHECK(stale_claim_seconds BETWEEN 120 AND 86400),
    last_polled_at TIMESTAMPTZ,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_by UUID REFERENCES public.user_profiles(auth_user_id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.communication_email_worker_settings(singleton) VALUES(true);

CREATE TABLE public.communication_email_schedule_state (
    message_id UUID PRIMARY KEY REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    scheduled_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id),
    claim_token UUID,
    claimed_at TIMESTAMPTZ,
    dispatch_started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    blocked_reason TEXT,
    outcome TEXT
);
CREATE TABLE public.communication_email_schedule_attempts (
    claim_token UUID PRIMARY KEY,
    message_id UUID NOT NULL REFERENCES public.communication_email_schedule_state(message_id),
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    dispatch_started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    outcome TEXT,
    reason TEXT
);
CREATE INDEX communication_email_schedule_pending ON public.communication_email_schedule_state(next_attempt_at,message_id)
    WHERE finished_at IS NULL AND claim_token IS NULL;
CREATE INDEX communication_email_schedule_stale ON public.communication_email_schedule_state(claimed_at,message_id)
    WHERE finished_at IS NULL AND claim_token IS NOT NULL;
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['communication_email_worker_settings','communication_email_schedule_state','communication_email_schedule_attempts'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
        EXECUTE format('GRANT SELECT ON public.%I TO service_role',t);
    END LOOP;
END $$;

CREATE FUNCTION public.save_communication_email_worker_settings(p_actor UUID,p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s communication_email_worker_settings; k TEXT;
BEGIN
    IF NOT communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO s FROM communication_email_worker_settings WHERE singleton FOR UPDATE;
    IF jsonb_typeof(p_input) IS DISTINCT FROM 'object'
        OR p_input->'revision' IS DISTINCT FROM to_jsonb(s.revision) THEN
        RAISE EXCEPTION 'Worker settings changed; reload before saving' USING ERRCODE='40001';
    END IF;
    FOR k IN SELECT jsonb_object_keys(p_input) LOOP
        IF k NOT IN('revision','enabled','batch_size','retry_policy','retry_delay_seconds','maximum_attempts','stale_claim_seconds') THEN
            RAISE EXCEPTION 'Unsupported worker setting' USING ERRCODE='22023';
        END IF;
        IF k='enabled' AND jsonb_typeof(p_input->k) IS DISTINCT FROM 'boolean'
            OR k IN('batch_size','retry_delay_seconds','maximum_attempts','stale_claim_seconds')
                AND (jsonb_typeof(p_input->k) IS DISTINCT FROM 'number' OR p_input->>k !~ '^[0-9]+$')
            OR k='retry_policy' AND coalesce(p_input->>k,'') NOT IN('none','pre_dispatch_only') THEN
            RAISE EXCEPTION 'Invalid worker setting' USING ERRCODE='22023';
        END IF;
    END LOOP;
    IF s.activated_at IS NULL AND coalesce((p_input->>'enabled')::boolean,false)
        AND EXISTS(SELECT 1 FROM communication_messages WHERE channel='email' AND status='Scheduled') THEN
        RAISE EXCEPTION 'Activation stopped: existing Scheduled communications require review; activate only with zero Scheduled records'
            USING ERRCODE='PT409';
    END IF;
    UPDATE communication_email_worker_settings SET
        enabled=coalesce((p_input->>'enabled')::boolean,enabled),
        activated_at=CASE WHEN coalesce((p_input->>'enabled')::boolean,false) THEN coalesce(activated_at,now()) ELSE activated_at END,
        batch_size=coalesce((p_input->>'batch_size')::integer,batch_size),
        retry_policy=coalesce(p_input->>'retry_policy',retry_policy),
        retry_delay_seconds=coalesce((p_input->>'retry_delay_seconds')::integer,retry_delay_seconds),
        maximum_attempts=coalesce((p_input->>'maximum_attempts')::integer,maximum_attempts),
        stale_claim_seconds=coalesce((p_input->>'stale_claim_seconds')::integer,stale_claim_seconds),
        revision=revision+1,updated_by=p_actor,updated_at=now() WHERE singleton;
END $$;

ALTER FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) RENAME TO save_communication_settings_before_scheduler;
REVOKE ALL ON FUNCTION public.save_communication_settings_before_scheduler(UUID,TEXT,JSONB)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_settings(p_actor UUID,p_channel TEXT,p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous communication_channel_settings; current_settings communication_channel_settings;
BEGIN
    IF p_channel='email' THEN
        SELECT * INTO previous FROM communication_channel_settings WHERE channel='email' FOR UPDATE;
    END IF;
    PERFORM save_communication_settings_before_scheduler(p_actor,p_channel,p_input);
    IF p_channel='email' THEN
        SELECT * INTO current_settings FROM communication_channel_settings WHERE channel='email';
        IF previous.automated_enabled IS DISTINCT FROM current_settings.automated_enabled
            AND (to_jsonb(previous)-ARRAY['automated_enabled','contractor_email_enabled','internal_email_enabled','revision','updated_at','updated_by'])
                IS NOT DISTINCT FROM
                (to_jsonb(current_settings)-ARRAY['automated_enabled','contractor_email_enabled','internal_email_enabled','revision','updated_at','updated_by']) THEN
            UPDATE microsoft_email_connection_state SET settings_revision=current_settings.revision
                WHERE channel='email' AND settings_revision=previous.revision
                AND authentication_status='Verified' AND delivery_status='Accepted by Graph';
        END IF;
    END IF;
END $$;

ALTER FUNCTION public.plan_communication(UUID,UUID,INTEGER,TEXT,TIMESTAMPTZ) RENAME TO plan_communication_before_worker;
REVOKE ALL ON FUNCTION public.plan_communication_before_worker(UUID,UUID,INTEGER,TEXT,TIMESTAMPTZ)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.plan_communication(p_actor UUID,p_message UUID,p_revision INTEGER,p_action TEXT,p_scheduled_at TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    -- Serialize scheduling with activation's zero-Scheduled-record check.
    PERFORM 1 FROM communication_email_worker_settings WHERE singleton FOR SHARE;
    PERFORM plan_communication_before_worker(p_actor,p_message,p_revision,p_action,p_scheduled_at);
    IF p_action='schedule' THEN
        INSERT INTO communication_email_schedule_state(message_id,scheduled_by) VALUES(p_message,p_actor);
    ELSIF p_action='cancel' THEN
        UPDATE communication_email_schedule_attempts SET finished_at=now(),outcome='cancelled'
            WHERE claim_token=(SELECT claim_token FROM communication_email_schedule_state WHERE message_id=p_message)
            AND dispatch_started_at IS NULL AND finished_at IS NULL;
        UPDATE communication_email_schedule_state SET finished_at=now(),outcome='cancelled'
            WHERE message_id=p_message AND dispatch_started_at IS NULL;
    END IF;
END $$;

-- One authoritative reservation for both manual and scheduled Email. The entry
-- points below, not callers, select the permitted source status.
CREATE FUNCTION public.reserve_communication_email_state(p_actor UUID,p_message_id UUID,p_settings_revision INTEGER,p_status TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s communication_channel_settings; m communication_messages; r communication_recipients; reason TEXT; n INTEGER;
BEGIN
    IF NOT communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO s FROM communication_channel_settings WHERE channel='email' FOR SHARE;
    IF s.revision IS DISTINCT FROM p_settings_revision OR s.provider IS DISTINCT FROM 'microsoft_365' OR NOT s.enabled
        OR s.from_address IS NULL OR s.microsoft_tenant_id IS NULL OR s.microsoft_client_id IS NULL THEN
        RAISE EXCEPTION 'Enabled Microsoft Email configuration required' USING ERRCODE='40001';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM microsoft_email_connection_state WHERE channel='email'
        AND settings_revision=s.revision AND authentication_status='Verified' AND delivery_status='Accepted by Graph') THEN
        RAISE EXCEPTION 'Complete Microsoft authentication and test Email before sending Compose Email' USING ERRCODE='22023';
    END IF;
    SELECT * INTO m FROM communication_messages WHERE id=p_message_id FOR UPDATE;
    IF NOT FOUND OR m.channel IS DISTINCT FROM 'email' OR m.direction IS DISTINCT FROM 'outbound'
        OR m.source IS DISTINCT FROM 'manual' OR m.status IS DISTINCT FROM p_status OR m.sent_at IS NOT NULL
        OR p_status NOT IN('Draft','Scheduled') THEN
        RAISE EXCEPTION 'Only an unsent manual Email in the reserved state can be sent' USING ERRCODE='22023';
    END IF;
    IF p_status='Scheduled' AND (NOT s.automated_enabled OR m.scheduled_at>clock_timestamp()) THEN
        RAISE EXCEPTION 'Automatic Delivery is disabled or this message is not due' USING ERRCODE='22023';
    END IF;
    IF m.provider IS DISTINCT FROM 'microsoft_365' OR m.sender_address IS DISTINCT FROM s.from_address
        OR nullif(btrim(m.subject),'') IS NULL OR nullif(btrim(m.body),'') IS NULL
        OR m.body ~ '\{\{|\}\}' OR m.subject ~ '\{\{|\}\}' THEN
        RAISE EXCEPTION 'Resolve all template fields and verify the saved subject, body and sender against current Email settings' USING ERRCODE='22023';
    END IF;
    SELECT count(*)::integer INTO n FROM communication_recipients WHERE message_id=p_message_id
        AND status=p_status AND email IS NOT NULL AND length(email)<=254
        AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' AND recipient_role IN('to','cc','bcc');
    IF n NOT BETWEEN 1 AND 100 OR n<>(SELECT count(*) FROM communication_recipients WHERE message_id=p_message_id)
        OR n<>(SELECT count(DISTINCT lower(email)) FROM communication_recipients WHERE message_id=p_message_id) THEN
        RAISE EXCEPTION 'Email requires 1 to 100 distinct valid recipients across To, Cc and Bcc' USING ERRCODE='22023';
    END IF;
    PERFORM 1 FROM contractor_contacts c WHERE EXISTS(
        SELECT 1 FROM communication_recipients target WHERE target.message_id=p_message_id
        AND (target.contractor_contact_id=c.id OR lower(target.email)=lower(c.email))) ORDER BY c.id FOR SHARE;
    PERFORM 1 FROM dobco_contacts c WHERE EXISTS(
        SELECT 1 FROM communication_recipients target WHERE target.message_id=p_message_id
        AND (target.dobco_contact_id=c.id OR lower(target.email)=lower(c.email))) ORDER BY c.id FOR SHARE;
    FOR r IN SELECT * FROM communication_recipients WHERE message_id=p_message_id LOOP
        reason:=communication_email_exclusion(r.recipient_type,coalesce(r.contractor_contact_id,r.dobco_contact_id),r.email);
        IF reason IS NOT NULL THEN RAISE EXCEPTION '%',reason USING ERRCODE='22023'; END IF;
    END LOOP;
    UPDATE communication_messages SET status='Sending',sent_by=p_actor,
        queued_at=CASE WHEN p_status='Scheduled' THEN now() ELSE queued_at END,
        failure_reason=NULL,updated_at=now(),revision=revision+1 WHERE id=p_message_id;
    UPDATE communication_recipients SET status='Sending',
        queued_at=CASE WHEN p_status='Scheduled' THEN now() ELSE queued_at END,failure_reason=NULL WHERE message_id=p_message_id;
    RETURN jsonb_build_object('id',m.id,'subject',m.subject,'body',m.body,'sender_address',m.sender_address,
        'reply_to_address',s.reply_to_address,'recipients',(SELECT jsonb_agg(
            jsonb_build_object('email',email,'recipient_role',recipient_role) ORDER BY id)
            FROM communication_recipients WHERE message_id=p_message_id));
END $$;
CREATE OR REPLACE FUNCTION public.reserve_communication_email_send_before_workspace(p_actor UUID,p_message_id UUID,p_settings_revision INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    RETURN reserve_communication_email_state(p_actor,p_message_id,p_settings_revision,'Draft');
END $$;

-- Reuse requirement-notice freshness and duplicate-identity checks for both
-- entry points without turning scheduling into a separate notice-send engine.
CREATE FUNCTION public.validate_communication_email_review(p_actor UUID,p_message_id UUID,p_message_revision INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_revision INTEGER; n requirement_notice_communications; current_preview JSONB;
BEGIN
    IF NOT communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('company_merge'));
    PERFORM 1 FROM communication_channel_settings WHERE channel='email' FOR SHARE;
    SELECT revision INTO current_revision FROM communication_messages WHERE id=p_message_id FOR UPDATE;
    IF NOT FOUND OR p_message_revision IS NULL OR current_revision IS DISTINCT FROM p_message_revision THEN
        RAISE EXCEPTION 'Draft changed since review; reload and review it again' USING ERRCODE='40001';
    END IF;
    SELECT * INTO n FROM requirement_notice_communications WHERE message_id=p_message_id;
    IF FOUND THEN
        IF NOT n.is_test THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(
                concat_ws(':',n.contractor_id,n.rule_id,n.expiration_date,n.interval_days,n.contact_id),0));
        END IF;
        current_preview:=preview_requirement_notice(p_actor,n.rule_id,n.contractor_id,n.contact_id,n.project_id);
        IF n.preview_snapshot IS DISTINCT FROM current_preview-ARRAY['duplicate','other_recipient_sent'] THEN
            RAISE EXCEPTION 'Notice context changed; generate and review a new preview' USING ERRCODE='40001';
        END IF;
        IF NOT n.is_test AND (current_preview->>'duplicate')::boolean THEN
            RAISE EXCEPTION 'This notice identity is already reserved or sent' USING ERRCODE='PT409';
        END IF;
        IF (SELECT count(*) FROM communication_recipients WHERE message_id=p_message_id)<>1
            OR NOT EXISTS(SELECT 1 FROM communication_recipients WHERE message_id=p_message_id AND
                CASE WHEN n.is_test THEN recipient_type='external' AND email='richg@dobcogroup.com'
                    AND contractor_contact_id IS NULL AND dobco_contact_id IS NULL
                ELSE recipient_type='contractor_contact' AND contractor_contact_id=n.contact_id
                    AND email=n.intended_email AND dobco_contact_id IS NULL END)
            OR NOT EXISTS(SELECT 1 FROM communication_messages WHERE id=p_message_id
                AND template_id=n.template_id AND template_revision=n.template_revision
                AND (NOT n.is_test OR subject LIKE '[TEST]%')) THEN
            RAISE EXCEPTION 'Notice recipient or template changed; review a new draft' USING ERRCODE='40001';
        END IF;
    END IF;
END $$;
CREATE OR REPLACE FUNCTION public.reserve_reviewed_communication_email_send(
    p_actor UUID,p_message_id UUID,p_settings_revision INTEGER,p_message_revision INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    PERFORM validate_communication_email_review(p_actor,p_message_id,p_message_revision);
    RETURN reserve_communication_email_send_before_notice(p_actor,p_message_id,p_settings_revision);
END $$;

CREATE FUNCTION public.complete_reserved_communication_email(p_actor UUID,p_message_id UUID,p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE next_status TEXT; reason TEXT;
BEGIN
    IF p_outcome IS NULL OR p_outcome NOT IN('accepted','graph_rejected','outcome_unknown','authentication_failed','identity_configuration') THEN
        RAISE EXCEPTION 'Invalid Email send outcome' USING ERRCODE='22023';
    END IF;
    next_status:=CASE WHEN p_outcome='accepted' THEN 'Sent' ELSE 'Failed' END;
    reason:=CASE WHEN p_outcome='accepted' THEN NULL WHEN p_outcome='outcome_unknown'
        THEN 'Provider outcome unknown. Do not retry automatically; review Logs and the mailbox before further action.'
        ELSE 'Microsoft Email send failed: '||p_outcome END;
    UPDATE communication_messages SET status=next_status,sent_at=CASE WHEN p_outcome='accepted' THEN now() END,
        failed_at=CASE WHEN p_outcome<>'accepted' THEN now() END,failure_reason=reason,updated_at=now(),revision=revision+1
        WHERE id=p_message_id AND sent_by=p_actor AND provider='microsoft_365'
        AND channel='email' AND direction='outbound' AND source='manual' AND status='Sending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Email send cannot be finalized' USING ERRCODE='22023'; END IF;
    UPDATE communication_recipients SET status=next_status,sent_at=CASE WHEN p_outcome='accepted' THEN now() END,
        failed_at=CASE WHEN p_outcome<>'accepted' THEN now() END,failure_reason=reason
        WHERE message_id=p_message_id AND status='Sending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Email recipient send cannot be finalized' USING ERRCODE='22023'; END IF;
    INSERT INTO requirement_notice_delivery_outcomes(message_id,outcome)
        SELECT p_message_id,p_outcome WHERE EXISTS(SELECT 1 FROM requirement_notice_communications WHERE message_id=p_message_id);
END $$;
CREATE OR REPLACE FUNCTION public.finish_communication_email_send(p_actor UUID,p_message_id UUID,p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF NOT communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    PERFORM complete_reserved_communication_email(p_actor,p_message_id,p_outcome);
END $$;

CREATE FUNCTION public.finish_scheduled_communication_email(p_message UUID,p_claim UUID,p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job communication_email_schedule_state;
BEGIN
    PERFORM 1 FROM communication_messages WHERE id=p_message FOR UPDATE;
    SELECT * INTO job FROM communication_email_schedule_state WHERE message_id=p_message FOR UPDATE;
    IF NOT FOUND OR job.claim_token IS DISTINCT FROM p_claim OR p_claim IS NULL
        OR job.dispatch_started_at IS NULL OR job.finished_at IS NOT NULL THEN
        RAISE EXCEPTION 'Scheduled delivery claim is no longer available' USING ERRCODE='PT409';
    END IF;
    -- Completion must still record the actual provider outcome if the actor's
    -- access changes after the authoritative reservation.
    PERFORM complete_reserved_communication_email(job.scheduled_by,p_message,p_outcome);
    UPDATE communication_email_schedule_state SET finished_at=now(),outcome=p_outcome,
        blocked_reason=NULL WHERE message_id=p_message;
    UPDATE communication_email_schedule_attempts SET finished_at=now(),outcome=p_outcome WHERE claim_token=p_claim;
END $$;

CREATE FUNCTION public.defer_scheduled_communication_email(p_message UUID,p_claim UUID,p_reason TEXT,p_blocked BOOLEAN)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE job communication_email_schedule_state; policy communication_email_worker_settings; terminal BOOLEAN;
BEGIN
    SELECT * INTO policy FROM communication_email_worker_settings WHERE singleton FOR SHARE;
    PERFORM 1 FROM communication_messages WHERE id=p_message FOR UPDATE;
    SELECT * INTO job FROM communication_email_schedule_state WHERE message_id=p_message FOR UPDATE;
    IF NOT FOUND OR p_claim IS NULL OR job.claim_token IS DISTINCT FROM p_claim OR job.dispatch_started_at IS NOT NULL
        OR job.finished_at IS NOT NULL OR nullif(btrim(p_reason),'') IS NULL OR p_blocked IS NULL THEN
        RAISE EXCEPTION 'Invalid pre-delivery deferral' USING ERRCODE='PT409';
    END IF;
    terminal:=NOT p_blocked AND (policy.retry_policy='none' OR job.attempt_count>=policy.maximum_attempts);
    UPDATE communication_email_schedule_attempts SET finished_at=now(),
        outcome=CASE WHEN p_blocked THEN 'blocked' ELSE 'pre_dispatch_failed' END,reason=left(p_reason,1000)
        WHERE claim_token=p_claim;
    UPDATE communication_email_schedule_state SET claim_token=NULL,claimed_at=NULL,
        attempt_count=CASE WHEN p_blocked THEN greatest(0,attempt_count-1) ELSE attempt_count END,
        next_attempt_at=clock_timestamp()+make_interval(secs=>policy.retry_delay_seconds),
        blocked_reason=left(p_reason,1000),finished_at=CASE WHEN terminal THEN now() END,
        outcome=CASE WHEN terminal THEN 'pre_dispatch_failed' END WHERE message_id=p_message;
END $$;

CREATE FUNCTION public.claim_due_scheduled_communications()
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE policy communication_email_worker_settings; job RECORD; token UUID; result JSONB:='[]'; remaining INTEGER;
BEGIN
    SELECT * INTO policy FROM communication_email_worker_settings WHERE singleton FOR UPDATE;
    IF NOT policy.enabled THEN RETURN result; END IF;
    UPDATE communication_email_worker_settings SET last_polled_at=clock_timestamp() WHERE singleton;
    remaining:=policy.batch_size;
    FOR job IN SELECT m.id,s.claim_token,s.dispatch_started_at FROM communication_messages m
        JOIN communication_email_schedule_state s ON s.message_id=m.id
        WHERE m.channel='email' AND m.status IN('Scheduled','Sending') AND s.finished_at IS NULL AND s.claim_token IS NOT NULL
            AND s.claimed_at<clock_timestamp()-make_interval(secs=>policy.stale_claim_seconds)
        ORDER BY s.claimed_at,m.id LIMIT remaining FOR UPDATE OF m,s SKIP LOCKED LOOP
        IF job.dispatch_started_at IS NOT NULL THEN
            PERFORM finish_scheduled_communication_email(job.id,job.claim_token,'outcome_unknown');
        ELSE
            PERFORM defer_scheduled_communication_email(job.id,job.claim_token,
                'Worker stopped before delivery reservation; no provider call was authorized.',false);
        END IF;
        remaining:=remaining-1;
    END LOOP;
    FOR job IN SELECT m.id,s.scheduled_by FROM communication_messages m
        JOIN communication_email_schedule_state s ON s.message_id=m.id
        WHERE m.channel='email' AND m.status='Scheduled' AND m.scheduled_at<=clock_timestamp()
            AND s.claim_token IS NULL AND s.finished_at IS NULL AND s.next_attempt_at<=clock_timestamp()
        ORDER BY s.next_attempt_at,m.scheduled_at,m.id LIMIT remaining FOR UPDATE OF m,s SKIP LOCKED LOOP
        token:=gen_random_uuid();
        UPDATE communication_email_schedule_state SET claim_token=token,claimed_at=clock_timestamp(),
            attempt_count=attempt_count+1 WHERE message_id=job.id;
        INSERT INTO communication_email_schedule_attempts(claim_token,message_id) VALUES(token,job.id);
        result:=result||jsonb_build_array(jsonb_build_object('id',job.id,'claim_token',token));
    END LOOP;
    RETURN result;
END $$;

CREATE FUNCTION public.reserve_scheduled_communication_email(p_message UUID,p_claim UUID,p_settings_revision INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE policy communication_email_worker_settings; s communication_channel_settings; m communication_messages;
    job communication_email_schedule_state; snapshot JSONB; reason TEXT;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('company_merge'));
    SELECT * INTO policy FROM communication_email_worker_settings WHERE singleton FOR SHARE;
    SELECT * INTO s FROM communication_channel_settings WHERE channel='email' FOR SHARE;
    SELECT * INTO m FROM communication_messages WHERE id=p_message FOR UPDATE;
    SELECT * INTO job FROM communication_email_schedule_state WHERE message_id=p_message FOR UPDATE;
    IF NOT FOUND OR p_claim IS NULL OR job.claim_token IS DISTINCT FROM p_claim OR job.dispatch_started_at IS NOT NULL
        OR job.finished_at IS NOT NULL OR m.status IS DISTINCT FROM 'Scheduled' OR m.sent_at IS NOT NULL
        OR job.claimed_at<clock_timestamp()-make_interval(secs=>policy.stale_claim_seconds) THEN
        RAISE EXCEPTION 'Scheduled delivery claim is no longer available' USING ERRCODE='PT409';
    END IF;
    BEGIN
        IF NOT policy.enabled OR NOT s.automated_enabled THEN
            RAISE EXCEPTION 'Automatic Delivery is disabled. Message remains Scheduled.' USING ERRCODE='22023';
        END IF;
        PERFORM validate_communication_email_review(job.scheduled_by,p_message,m.revision);
        snapshot:=reserve_communication_email_state(job.scheduled_by,p_message,p_settings_revision,'Scheduled');
    EXCEPTION WHEN SQLSTATE '22023' OR SQLSTATE '42501' OR SQLSTATE '40001' OR SQLSTATE 'PT409' THEN
        GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
        PERFORM defer_scheduled_communication_email(p_message,p_claim,reason,true);
        RETURN jsonb_build_object('blocked',true,'reason',reason);
    END;
    UPDATE communication_email_schedule_state SET dispatch_started_at=clock_timestamp(),blocked_reason=NULL WHERE message_id=p_message;
    UPDATE communication_email_schedule_attempts SET dispatch_started_at=clock_timestamp() WHERE claim_token=p_claim;
    RETURN jsonb_build_object('blocked',false,'reservation',snapshot);
END $$;

CREATE OR REPLACE FUNCTION public.communication_email_workspace_controls(p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF NOT (communication_actor_allowed(p_actor,'communications_content','add')
        OR communication_actor_allowed(p_actor,'communications_content','edit')
        OR communication_actor_allowed(p_actor,'settings','view')) THEN
        RAISE EXCEPTION 'Email workspace permission required' USING ERRCODE='42501';
    END IF;
    RETURN (SELECT jsonb_build_object('enabled',s.enabled,'contractor_email_enabled',s.contractor_email_enabled,
        'internal_email_enabled',s.internal_email_enabled,'automatic_delivery_enabled',s.automated_enabled,
        'scheduled_worker_enabled',w.enabled,'scheduled_worker_healthy',w.enabled AND w.last_polled_at IS NOT NULL
            AND w.last_polled_at>now()-make_interval(secs=>w.stale_claim_seconds))
        FROM communication_channel_settings s CROSS JOIN communication_email_worker_settings w WHERE s.channel='email');
END $$;

CREATE FUNCTION public.communication_scheduled_email_status()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT jsonb_build_object('enabled',w.enabled,'healthy',w.enabled AND w.last_polled_at IS NOT NULL
        AND w.last_polled_at>now()-make_interval(secs=>w.stale_claim_seconds),
        'automatic_delivery_enabled',s.automated_enabled,'global_email_enabled',s.enabled)
    FROM communication_email_worker_settings w CROSS JOIN communication_channel_settings s WHERE s.channel='email'
$$;

DO $$
DECLARE f TEXT;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'reserve_communication_email_state(uuid,uuid,integer,text)',
        'validate_communication_email_review(uuid,uuid,integer)',
        'complete_reserved_communication_email(uuid,uuid,text)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated,service_role',f);
    END LOOP;
    FOREACH f IN ARRAY ARRAY[
        'save_communication_email_worker_settings(uuid,jsonb)',
        'save_communication_settings(uuid,text,jsonb)',
        'plan_communication(uuid,uuid,integer,text,timestamp with time zone)',
        'communication_scheduled_email_status()',
        'claim_due_scheduled_communications()',
        'reserve_scheduled_communication_email(uuid,uuid,integer)',
        'defer_scheduled_communication_email(uuid,uuid,text,boolean)',
        'finish_scheduled_communication_email(uuid,uuid,text)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC,anon,authenticated',f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO service_role',f);
    END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
