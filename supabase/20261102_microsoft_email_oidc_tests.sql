BEGIN;

CREATE TABLE public.microsoft_email_connection_state (
    channel TEXT PRIMARY KEY DEFAULT 'email' CHECK (channel='email'),
    settings_revision INTEGER NOT NULL,
    authentication_status TEXT NOT NULL CHECK (authentication_status IN ('Verified','Test Failed')),
    diagnostic_category TEXT CHECK (diagnostic_category IN ('identity_configuration','authentication_failed')),
    tested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    tested_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id),
    last_test_message_id UUID REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    delivery_status TEXT NOT NULL DEFAULT 'Not Tested' CHECK (delivery_status IN ('Not Tested','In Progress','Accepted by Graph','Test Failed','Outcome Unknown'))
);
ALTER TABLE public.microsoft_email_connection_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.microsoft_email_connection_state FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.microsoft_email_connection_state TO service_role;

CREATE FUNCTION public.record_microsoft_authentication(p_actor UUID, p_revision INTEGER, p_category TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s public.communication_channel_settings;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO s FROM public.communication_channel_settings WHERE channel='email' FOR UPDATE;
    IF s.revision IS DISTINCT FROM p_revision OR s.provider IS DISTINCT FROM 'microsoft_365' OR NOT s.enabled THEN
        RAISE EXCEPTION 'Email settings changed; save and test again' USING ERRCODE='40001';
    END IF;
    IF p_category IS NOT NULL AND p_category NOT IN ('identity_configuration','authentication_failed') THEN
        RAISE EXCEPTION 'Invalid diagnostic category' USING ERRCODE='22023';
    END IF;
    INSERT INTO public.microsoft_email_connection_state(channel,settings_revision,authentication_status,diagnostic_category,tested_by)
        VALUES('email',p_revision,CASE WHEN p_category IS NULL THEN 'Verified' ELSE 'Test Failed' END,p_category,p_actor)
    ON CONFLICT(channel) DO UPDATE SET settings_revision=excluded.settings_revision,
        authentication_status=excluded.authentication_status,diagnostic_category=excluded.diagnostic_category,
        tested_at=now(),tested_by=p_actor,
        delivery_status=CASE WHEN microsoft_email_connection_state.settings_revision=p_revision THEN microsoft_email_connection_state.delivery_status ELSE 'Not Tested' END;
END;
$$;

CREATE FUNCTION public.reserve_microsoft_test_email(p_actor UUID, p_revision INTEGER, p_request_id UUID, p_recipient TEXT)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s public.communication_channel_settings;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO s FROM public.communication_channel_settings WHERE channel='email' FOR UPDATE;
    IF s.revision IS DISTINCT FROM p_revision OR s.provider IS DISTINCT FROM 'microsoft_365' OR NOT s.enabled
        OR s.from_address IS NULL OR s.microsoft_tenant_id IS NULL OR s.microsoft_client_id IS NULL THEN
        RAISE EXCEPTION 'Saved Microsoft Email configuration required' USING ERRCODE='40001';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.microsoft_email_connection_state WHERE channel='email'
        AND settings_revision=p_revision AND authentication_status='Verified') THEN
        RAISE EXCEPTION 'Test authentication first' USING ERRCODE='22023';
    END IF;
    IF p_request_id IS NULL OR p_recipient IS NULL OR length(p_recipient)>254
        OR p_recipient !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
        RAISE EXCEPTION 'Explicit valid test recipient required' USING ERRCODE='22023';
    END IF;
    IF EXISTS(SELECT 1 FROM public.microsoft_email_connection_state connection_state
        JOIN public.communication_messages m ON m.id=connection_state.last_test_message_id
        WHERE connection_state.channel='email' AND m.status='Sending') THEN
        RAISE EXCEPTION 'A test Email is already in progress; review Logs before another test' USING ERRCODE='22023';
    END IF;
    -- The client request ID is also the authoritative message ID; replay cannot dispatch twice.
    INSERT INTO public.communication_messages(id,channel,direction,source,status,subject,body,
        sender_name,sender_address,provider,created_by,sent_by)
    VALUES(p_request_id,'email','outbound','manual','Sending','SubTracker Email connection test',
        'This is a deliberately requested SubTracker Email connection test. Microsoft Graph acceptance does not confirm recipient delivery or reading.',
        s.from_name,s.from_address,'microsoft_365',p_actor,p_actor);
    INSERT INTO public.communication_recipients(message_id,recipient_type,recipient_name,email,status)
        VALUES(p_request_id,'external',p_recipient,p_recipient,'Sending');
    UPDATE public.microsoft_email_connection_state SET last_test_message_id=p_request_id,delivery_status='In Progress' WHERE channel='email';
    RETURN p_request_id;
END;
$$;

CREATE FUNCTION public.finish_microsoft_test_email(p_actor UUID, p_revision INTEGER, p_message_id UUID, p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE next_status TEXT; reason TEXT;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage required' USING ERRCODE='42501';
    END IF;
    IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','graph_rejected','outcome_unknown','authentication_failed','identity_configuration') THEN
        RAISE EXCEPTION 'Invalid test outcome' USING ERRCODE='22023';
    END IF;
    next_status := CASE WHEN p_outcome='accepted' THEN 'Sent' ELSE 'Failed' END;
    reason := CASE WHEN p_outcome='accepted' THEN NULL WHEN p_outcome='outcome_unknown'
        THEN 'Provider outcome unknown. Do not retry automatically; review before another deliberate test.'
        ELSE 'Microsoft Email test failed: '||p_outcome END;
    UPDATE public.communication_messages SET status=next_status,
        sent_at=CASE WHEN p_outcome='accepted' THEN now() END,
        failed_at=CASE WHEN p_outcome<>'accepted' THEN now() END,failure_reason=reason,updated_at=now(),revision=revision+1
        WHERE id=p_message_id AND created_by=p_actor AND provider='microsoft_365'
        AND channel='email' AND status='Sending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Test message cannot be finalized' USING ERRCODE='22023'; END IF;
    UPDATE public.communication_recipients SET status=next_status,
        sent_at=CASE WHEN p_outcome='accepted' THEN now() END,
        failed_at=CASE WHEN p_outcome<>'accepted' THEN now() END,failure_reason=reason WHERE message_id=p_message_id;
    UPDATE public.microsoft_email_connection_state SET delivery_status=CASE WHEN p_outcome='accepted'
        THEN 'Accepted by Graph' WHEN p_outcome='outcome_unknown' THEN 'Outcome Unknown' ELSE 'Test Failed' END
        WHERE channel='email' AND settings_revision=p_revision AND last_test_message_id=p_message_id;
END;
$$;

CREATE FUNCTION public.reserve_communication_email_send(p_actor UUID, p_message_id UUID, p_settings_revision INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE s public.communication_channel_settings; m public.communication_messages; recipient_count INTEGER; snapshot JSONB;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO s FROM public.communication_channel_settings WHERE channel='email' FOR SHARE;
    IF s.revision IS DISTINCT FROM p_settings_revision OR s.provider IS DISTINCT FROM 'microsoft_365' OR NOT s.enabled
        OR s.from_address IS NULL OR s.microsoft_tenant_id IS NULL OR s.microsoft_client_id IS NULL THEN
        RAISE EXCEPTION 'Enabled Microsoft Email configuration required' USING ERRCODE='40001';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM public.microsoft_email_connection_state WHERE channel='email'
        AND settings_revision=s.revision AND authentication_status='Verified' AND delivery_status='Accepted by Graph') THEN
        RAISE EXCEPTION 'Complete Microsoft authentication and test Email before sending Compose Email' USING ERRCODE='22023';
    END IF;
    SELECT * INTO m FROM public.communication_messages WHERE id=p_message_id FOR UPDATE;
    IF NOT FOUND OR m.channel IS DISTINCT FROM 'email' OR m.direction IS DISTINCT FROM 'outbound'
        OR m.source IS DISTINCT FROM 'manual' OR m.status IS DISTINCT FROM 'Draft' THEN
        RAISE EXCEPTION 'Only an unsent manual Email Draft can be sent' USING ERRCODE='22023';
    END IF;
    IF m.provider IS DISTINCT FROM 'microsoft_365' OR m.sender_address IS DISTINCT FROM s.from_address
        OR m.subject IS NULL OR btrim(m.subject)='' THEN
        RAISE EXCEPTION 'Draft sender/provider or subject does not match current Email configuration' USING ERRCODE='22023';
    END IF;
    SELECT count(*)::INTEGER INTO recipient_count FROM public.communication_recipients
        WHERE message_id=p_message_id AND status='Draft' AND email IS NOT NULL
        AND length(email)<=254 AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
    IF recipient_count NOT BETWEEN 1 AND 100 OR recipient_count <>
        (SELECT count(*)::INTEGER FROM public.communication_recipients WHERE message_id=p_message_id) THEN
        RAISE EXCEPTION 'Draft must contain 1 to 100 valid Email recipient snapshots' USING ERRCODE='22023';
    END IF;

    UPDATE public.communication_messages SET status='Sending',sent_by=p_actor,updated_at=now(),revision=revision+1
        WHERE id=p_message_id AND status='Draft';
    IF NOT FOUND THEN RAISE EXCEPTION 'Email Draft is no longer available to send' USING ERRCODE='40001'; END IF;
    UPDATE public.communication_recipients SET status='Sending' WHERE message_id=p_message_id AND status='Draft';
    SELECT jsonb_build_object(
        'id',m.id,'subject',m.subject,'body',m.body,'sender_address',m.sender_address,
        'reply_to_address',s.reply_to_address,
        'recipients',(SELECT jsonb_agg(jsonb_build_object('email',r.email) ORDER BY r.created_at,r.id)
            FROM public.communication_recipients r WHERE r.message_id=p_message_id)
    ) INTO snapshot;
    RETURN snapshot;
END;
$$;

CREATE FUNCTION public.finish_communication_email_send(p_actor UUID, p_message_id UUID, p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE next_status TEXT; reason TEXT;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    IF p_outcome IS NULL OR p_outcome NOT IN ('accepted','graph_rejected','outcome_unknown','authentication_failed','identity_configuration') THEN
        RAISE EXCEPTION 'Invalid Email send outcome' USING ERRCODE='22023';
    END IF;
    next_status := CASE WHEN p_outcome='accepted' THEN 'Sent' ELSE 'Failed' END;
    reason := CASE WHEN p_outcome='accepted' THEN NULL WHEN p_outcome='outcome_unknown'
        THEN 'Provider outcome unknown. Do not retry automatically; review Logs and the mailbox before further action.'
        ELSE 'Microsoft Email send failed: '||p_outcome END;
    UPDATE public.communication_messages SET status=next_status,
        sent_at=CASE WHEN p_outcome='accepted' THEN now() END,
        failed_at=CASE WHEN p_outcome<>'accepted' THEN now() END,
        failure_reason=reason,updated_at=now(),revision=revision+1
        WHERE id=p_message_id AND sent_by=p_actor AND provider='microsoft_365'
        AND channel='email' AND direction='outbound' AND source='manual' AND status='Sending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Email send cannot be finalized' USING ERRCODE='22023'; END IF;
    UPDATE public.communication_recipients SET status=next_status,
        sent_at=CASE WHEN p_outcome='accepted' THEN now() END,
        failed_at=CASE WHEN p_outcome<>'accepted' THEN now() END,failure_reason=reason
        WHERE message_id=p_message_id AND status='Sending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Email recipient send cannot be finalized' USING ERRCODE='22023'; END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_microsoft_authentication(UUID,INTEGER,TEXT),
    public.reserve_microsoft_test_email(UUID,INTEGER,UUID,TEXT),
    public.finish_microsoft_test_email(UUID,INTEGER,UUID,TEXT),
    public.reserve_communication_email_send(UUID,UUID,INTEGER),
    public.finish_communication_email_send(UUID,UUID,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_microsoft_authentication(UUID,INTEGER,TEXT),
    public.reserve_microsoft_test_email(UUID,INTEGER,UUID,TEXT),
    public.finish_microsoft_test_email(UUID,INTEGER,UUID,TEXT),
    public.reserve_communication_email_send(UUID,UUID,INTEGER),
    public.finish_communication_email_send(UUID,UUID,TEXT) TO service_role;
COMMIT;
