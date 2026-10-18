BEGIN;

CREATE TABLE public.communication_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
    category TEXT NOT NULL CHECK (category IN ('Expiration Reminder','Out of Compliance','Compliance Restored','General Contractor Communication','Internal Alert')),
    channel TEXT NOT NULL CHECK (channel IN ('email','sms')),
    subject TEXT CHECK (length(subject) <= 1000),
    body TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 100000),
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL,
    CHECK (channel <> 'sms' OR subject IS NULL)
);
ALTER TABLE public.communication_templates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.communication_templates FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.communication_templates TO service_role;

ALTER TABLE public.communication_messages ADD COLUMN template_id UUID REFERENCES public.communication_templates(id) ON DELETE RESTRICT;
ALTER TABLE public.notification_reminder_rules
    ADD COLUMN email_template_id UUID REFERENCES public.communication_templates(id) ON DELETE RESTRICT,
    ADD COLUMN sms_template_id UUID REFERENCES public.communication_templates(id) ON DELETE RESTRICT;

CREATE FUNCTION public.save_communication_template(p_actor UUID, p_id UUID, p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE result_id UUID; current_revision INTEGER;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE='42501';
    END IF;
    IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
      OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('name','category','channel','subject','body','is_active','revision'))
      OR jsonb_typeof(p_input->'name') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_input->'body') IS DISTINCT FROM 'string'
      OR jsonb_typeof(p_input->'is_active') IS DISTINCT FROM 'boolean'
      OR p_input->>'category' IS NULL OR p_input->>'channel' IS NULL THEN
        RAISE EXCEPTION 'Invalid template configuration' USING ERRCODE='22023';
    END IF;
    IF p_id IS NOT NULL THEN
        SELECT revision INTO current_revision FROM public.communication_templates WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Template not found' USING ERRCODE='P0002'; END IF;
        IF current_revision IS DISTINCT FROM (p_input->>'revision')::INTEGER THEN
            RAISE EXCEPTION 'Template changed; reload before saving' USING ERRCODE='40001';
        END IF;
        IF EXISTS(SELECT 1 FROM public.notification_reminder_rules WHERE
            (email_template_id=p_id AND p_input->>'channel'<>'email') OR (sms_template_id=p_id AND p_input->>'channel'<>'sms'))
            OR EXISTS(SELECT 1 FROM public.communication_messages WHERE template_id=p_id AND channel<>p_input->>'channel') THEN
            RAISE EXCEPTION 'A referenced template cannot change channel' USING ERRCODE='22023';
        END IF;
        UPDATE public.communication_templates SET name=btrim(p_input->>'name'), category=p_input->>'category',
            channel=p_input->>'channel', subject=nullif(p_input->>'subject',''), body=p_input->>'body',
            is_active=(p_input->>'is_active')::BOOLEAN, revision=revision+1, updated_at=now(), updated_by=p_actor
        WHERE id=p_id RETURNING id INTO result_id;
    ELSE
        INSERT INTO public.communication_templates(name,category,channel,subject,body,is_active,updated_by)
        VALUES(btrim(p_input->>'name'),p_input->>'category',p_input->>'channel',nullif(p_input->>'subject',''),
            p_input->>'body',(p_input->>'is_active')::BOOLEAN,p_actor) RETURNING id INTO result_id;
    END IF;
    RETURN result_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_communication_template(UUID,UUID,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_template(UUID,UUID,JSONB) TO service_role;

ALTER FUNCTION public.save_notification_reminder(UUID,UUID,JSONB,BOOLEAN) RENAME TO save_notification_reminder_base;
REVOKE ALL ON FUNCTION public.save_notification_reminder_base(UUID,UUID,JSONB,BOOLEAN) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_notification_reminder(p_actor UUID, p_id UUID, p_input JSONB, p_remove BOOLEAN)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result_id UUID; c TEXT; template UUID; previous UUID;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE='42501';
    END IF;
    IF p_id IS NOT NULL THEN PERFORM 1 FROM public.notification_reminder_rules WHERE id=p_id FOR UPDATE; END IF;
    IF NOT p_remove THEN
        FOREACH c IN ARRAY ARRAY['email','sms'] LOOP
            template := (p_input->>(c || '_template_id'))::UUID;
            IF template IS NOT NULL THEN
                SELECT CASE WHEN c='email' THEN email_template_id ELSE sms_template_id END INTO previous
                    FROM public.notification_reminder_rules WHERE id=p_id;
                IF NOT EXISTS(SELECT 1 FROM public.communication_templates WHERE id=template AND channel=c AND (is_active OR id=previous)) THEN
                    RAISE EXCEPTION 'Choose an active template for the matching channel' USING ERRCODE='22023';
                END IF;
            END IF;
        END LOOP;
    END IF;
    result_id := public.save_notification_reminder_base(p_actor,p_id,p_input-'email_template_id'-'sms_template_id',p_remove);
    IF NOT p_remove THEN
        UPDATE public.notification_reminder_rules SET
            email_template_id=CASE WHEN p_input ? 'email_template_id' THEN (p_input->>'email_template_id')::UUID ELSE email_template_id END,
            sms_template_id=CASE WHEN p_input ? 'sms_template_id' THEN (p_input->>'sms_template_id')::UUID ELSE sms_template_id END
        WHERE id=result_id;
    END IF;
    RETURN result_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_notification_reminder(UUID,UUID,JSONB,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_reminder(UUID,UUID,JSONB,BOOLEAN) TO service_role;

ALTER FUNCTION public.save_communication_draft(UUID,UUID,JSONB) RENAME TO save_communication_draft_base;
REVOKE ALL ON FUNCTION public.save_communication_draft_base(UUID,UUID,JSONB) FROM PUBLIC, anon, authenticated, service_role;
CREATE FUNCTION public.save_communication_draft(p_actor UUID, p_id UUID, p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE result_id UUID; existing public.communication_messages; r JSONB; t UUID; preserved BOOLEAN;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'communications_content',CASE WHEN p_id IS NULL THEN 'add' ELSE 'edit' END) THEN
        RAISE EXCEPTION 'Communications Content mutation permission required' USING ERRCODE='42501';
    END IF;
    IF p_id IS NOT NULL THEN
        SELECT * INTO existing FROM public.communication_messages WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Communication not found' USING ERRCODE='P0002'; END IF;
        IF existing.status<>'Draft' OR existing.source<>'manual' OR existing.direction<>'outbound' THEN
            RAISE EXCEPTION 'Only manual outbound Draft communications can be edited' USING ERRCODE='22023';
        END IF;
        IF existing.revision IS DISTINCT FROM (p_input->>'revision')::INTEGER THEN
            RAISE EXCEPTION 'Draft changed; reload before saving' USING ERRCODE='40001';
        END IF;
    END IF;
    t := (p_input->>'template_id')::UUID;
    IF t IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.communication_templates WHERE id=t
        AND channel=p_input->>'channel' AND (is_active OR id=existing.template_id)) THEN
        RAISE EXCEPTION 'Choose an active template for the matching channel' USING ERRCODE='22023';
    END IF;
    IF p_input->>'channel'='sms' AND nullif(p_input->>'subject','') IS NOT NULL THEN
        RAISE EXCEPTION 'SMS drafts do not have subjects' USING ERRCODE='22023';
    END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_input->'recipients') LOOP
        SELECT EXISTS(SELECT 1 FROM public.communication_recipients old WHERE old.message_id=p_id
            AND existing.channel=p_input->>'channel' AND old.recipient_type=r->>'recipient_type'
            AND old.recipient_name=r->>'recipient_name' AND old.email IS NOT DISTINCT FROM r->>'email'
            AND old.mobile_phone IS NOT DISTINCT FROM r->>'mobile_phone'
            AND old.contractor_contact_id IS NOT DISTINCT FROM (r->>'contractor_contact_id')::UUID
            AND old.dobco_contact_id IS NOT DISTINCT FROM (r->>'dobco_contact_id')::UUID) INTO preserved;
        IF NOT preserved AND r->>'recipient_type'='contractor_contact' AND NOT EXISTS(
            SELECT 1 FROM public.contractor_contacts c WHERE c.id=(r->>'contractor_contact_id')::UUID
            AND c.is_active AND c.contact_name=r->>'recipient_name'
            AND c.email IS NOT DISTINCT FROM r->>'email' AND c.mobile_phone IS NOT DISTINCT FROM r->>'mobile_phone'
            AND CASE WHEN p_input->>'channel'='email' THEN c.receives_compliance_email AND nullif(btrim(c.email),'') IS NOT NULL
                ELSE c.receives_compliance_sms AND c.sms_consent_recorded AND nullif(btrim(c.mobile_phone),'') IS NOT NULL END) THEN
            RAISE EXCEPTION 'Contractor recipient is ineligible or changed; reselect the contact' USING ERRCODE='22023';
        END IF;
        IF NOT preserved AND r->>'recipient_type'='dobco_contact' AND NOT EXISTS(
            SELECT 1 FROM public.dobco_contacts c WHERE c.id=(r->>'dobco_contact_id')::UUID
            AND c.is_active AND c.contact_name=r->>'recipient_name'
            AND c.email IS NOT DISTINCT FROM r->>'email' AND c.mobile_phone IS NOT DISTINCT FROM r->>'mobile_phone'
            AND CASE WHEN p_input->>'channel'='email' THEN c.receives_internal_email AND nullif(btrim(c.email),'') IS NOT NULL
                ELSE c.receives_internal_sms AND c.sms_consent_recorded AND nullif(btrim(c.mobile_phone),'') IS NOT NULL END) THEN
            RAISE EXCEPTION 'Internal recipient is ineligible or changed; reselect the contact' USING ERRCODE='22023';
        END IF;
    END LOOP;
    result_id := public.save_communication_draft_base(p_actor,p_id,p_input-'template_id');
    UPDATE public.communication_messages SET template_id=CASE WHEN p_input ? 'template_id' THEN t ELSE template_id END
        WHERE id=result_id;
    IF p_id IS NOT NULL AND existing.channel=p_input->>'channel' THEN
        UPDATE public.communication_messages SET provider=existing.provider,sender_name=existing.sender_name,sender_address=existing.sender_address WHERE id=result_id;
    END IF;
    RETURN result_id;
END;
$$;
REVOKE ALL ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) TO service_role;

COMMENT ON TABLE public.communication_templates IS 'Editable installation templates. No automatic execution, seeding, rendering engine, or delivery. Deactivate rather than delete.';
COMMIT;
