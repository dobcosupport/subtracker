BEGIN;

CREATE TABLE public.notification_reminder_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    days_before_expiration INTEGER NOT NULL CHECK (days_before_expiration > 0),
    email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    template_reference TEXT CHECK (length(template_reference) <= 500),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX notification_reminder_active_offset
    ON public.notification_reminder_rules(days_before_expiration)
    WHERE email_enabled OR sms_enabled;

-- Initial configuration only. Neither channel is enabled by displaying a rule.
INSERT INTO public.notification_reminder_rules(days_before_expiration)
VALUES (90), (60), (30);

ALTER TABLE public.notification_reminder_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.notification_reminder_rules FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.notification_reminder_rules TO service_role;

CREATE FUNCTION public.save_notification_automation(p_actor UUID, p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    c TEXT;
    settings JSONB;
    current_revision INTEGER;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE = '42501';
    END IF;
    IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k NOT IN ('email','sms')) THEN
        RAISE EXCEPTION 'Invalid notification automation settings' USING ERRCODE = '22023';
    END IF;
    FOREACH c IN ARRAY ARRAY['email','sms'] LOOP
        settings := p_input->c;
        IF settings IS NULL OR jsonb_typeof(settings) <> 'object' THEN
            RAISE EXCEPTION 'Both channel automation settings are required' USING ERRCODE = '22023';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(settings) k WHERE k NOT IN ('automated_enabled','revision'))
          OR jsonb_typeof(settings->'automated_enabled') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(settings->'revision') IS DISTINCT FROM 'number'
          OR (settings->>'revision') !~ '^[1-9][0-9]*$' THEN
            RAISE EXCEPTION 'Invalid channel automation settings' USING ERRCODE = '22023';
        END IF;
        SELECT revision INTO current_revision FROM public.communication_channel_settings WHERE channel=c FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Channel configuration is missing' USING ERRCODE = 'P0002'; END IF;
        IF current_revision IS DISTINCT FROM (settings->>'revision')::INTEGER THEN
            RAISE EXCEPTION 'Channel settings changed; reload before saving automation' USING ERRCODE = '40001';
        END IF;
        UPDATE public.communication_channel_settings SET
            automated_enabled=(settings->>'automated_enabled')::BOOLEAN,
            revision=revision+1, updated_at=now(), updated_by=p_actor
        WHERE channel=c;
    END LOOP;
END;
$$;

CREATE FUNCTION public.save_notification_reminder(p_actor UUID, p_id UUID, p_input JSONB, p_remove BOOLEAN)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    current_revision INTEGER;
    result_id UUID;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE = '42501';
    END IF;
    IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' OR p_remove IS NULL THEN
        RAISE EXCEPTION 'Invalid reminder configuration' USING ERRCODE = '22023';
    END IF;
    IF p_remove THEN
        IF p_id IS NULL OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k <> 'revision') THEN
            RAISE EXCEPTION 'Invalid reminder removal' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k <> ALL(
            CASE WHEN p_id IS NULL THEN ARRAY['days_before_expiration','email_enabled','sms_enabled','template_reference']
            ELSE ARRAY['days_before_expiration','email_enabled','sms_enabled','template_reference','revision'] END))
          OR jsonb_typeof(p_input->'days_before_expiration') IS DISTINCT FROM 'number'
          OR (p_input->>'days_before_expiration') !~ '^[1-9][0-9]*$'
          OR jsonb_typeof(p_input->'email_enabled') IS DISTINCT FROM 'boolean'
          OR jsonb_typeof(p_input->'sms_enabled') IS DISTINCT FROM 'boolean'
          OR (p_input ? 'template_reference' AND jsonb_typeof(p_input->'template_reference') NOT IN ('string','null')) THEN
            RAISE EXCEPTION 'Days must be a positive integer and channels must be boolean' USING ERRCODE = '22023';
        END IF;
    END IF;
    IF p_id IS NOT NULL THEN
        IF jsonb_typeof(p_input->'revision') IS DISTINCT FROM 'number'
          OR (p_input->>'revision') !~ '^[1-9][0-9]*$' THEN
            RAISE EXCEPTION 'A valid reminder revision is required' USING ERRCODE = '22023';
        END IF;
        SELECT revision INTO current_revision FROM public.notification_reminder_rules WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Reminder not found' USING ERRCODE = 'P0002'; END IF;
        IF current_revision IS DISTINCT FROM (p_input->>'revision')::INTEGER THEN
            RAISE EXCEPTION 'Reminder changed; reload before saving' USING ERRCODE = '40001';
        END IF;
    END IF;
    IF p_remove THEN
        DELETE FROM public.notification_reminder_rules WHERE id=p_id;
        RETURN p_id;
    ELSIF p_id IS NULL THEN
        INSERT INTO public.notification_reminder_rules(days_before_expiration,email_enabled,sms_enabled,template_reference,updated_by)
        VALUES ((p_input->>'days_before_expiration')::INTEGER,(p_input->>'email_enabled')::BOOLEAN,
            (p_input->>'sms_enabled')::BOOLEAN,nullif(btrim(p_input->>'template_reference'),''),p_actor)
        RETURNING id INTO result_id;
    ELSE
        UPDATE public.notification_reminder_rules SET
            days_before_expiration=(p_input->>'days_before_expiration')::INTEGER,
            email_enabled=(p_input->>'email_enabled')::BOOLEAN, sms_enabled=(p_input->>'sms_enabled')::BOOLEAN,
            template_reference=nullif(btrim(p_input->>'template_reference'),''),
            revision=revision+1, updated_at=now(), updated_by=p_actor
        WHERE id=p_id RETURNING id INTO result_id;
    END IF;
    RETURN result_id;
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'An active reminder already uses this expiration offset. Edit it or clear both channels before activating another.'
        USING ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.save_notification_automation(UUID,JSONB),
    public.save_notification_reminder(UUID,UUID,JSONB,BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_notification_automation(UUID,JSONB),
    public.save_notification_reminder(UUID,UUID,JSONB,BOOLEAN) TO service_role;

COMMENT ON TABLE public.notification_reminder_rules IS
    'Installation configuration only. Active is derived from email_enabled OR sms_enabled. No scanning, message generation, queueing, dispatch or workers. Master automation flags remain in communication_channel_settings.';

COMMIT;
