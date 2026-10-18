BEGIN;

CREATE TABLE public.user_invitation_email_settings (
    channel TEXT PRIMARY KEY DEFAULT 'email' CHECK (channel = 'email'),
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    delivery_mode TEXT NOT NULL DEFAULT 'supabase_auth'
        CHECK (delivery_mode IN ('supabase_auth', 'application_email_provider')),
    organization_name TEXT CHECK (length(organization_name) <= 500),
    application_name TEXT CHECK (length(application_name) <= 500),
    subject TEXT CHECK (length(subject) <= 500 AND subject !~ E'[\\r\\n]'),
    application_base_url TEXT CHECK (length(application_base_url) <= 2048),
    invitation_path TEXT CHECK (length(invitation_path) <= 500),
    template_reference TEXT CHECK (length(template_reference) <= 500),
    template_content TEXT CHECK (length(template_content) <= 10000),
    sender_reference TEXT CHECK (length(sender_reference) <= 500),
    reply_to_reference TEXT CHECK (length(reply_to_reference) <= 500),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL
);
INSERT INTO public.user_invitation_email_settings(channel) VALUES ('email');
ALTER TABLE public.user_invitation_email_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.user_invitation_email_settings FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.user_invitation_email_settings TO service_role;

CREATE FUNCTION public.save_user_invitation_email_settings(p_actor UUID, p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_revision INTEGER;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE = '42501';
    END IF;
    IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object' THEN
        RAISE EXCEPTION 'Invalid invitation email settings' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k <> ALL(
        ARRAY['enabled','delivery_mode','organization_name','application_name','subject','application_base_url',
            'invitation_path','template_reference','template_content','sender_reference','reply_to_reference','revision']))
        OR jsonb_typeof(p_input->'enabled') IS DISTINCT FROM 'boolean'
        OR (p_input->>'delivery_mode') IS NULL
        OR (p_input->>'delivery_mode') NOT IN ('supabase_auth','application_email_provider')
        OR jsonb_typeof(p_input->'revision') IS DISTINCT FROM 'number'
        OR (p_input->>'revision') !~ '^[1-9][0-9]*$' THEN
        RAISE EXCEPTION 'Unsupported or invalid invitation settings field' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_each(p_input) e WHERE e.key IN
        ('organization_name','application_name','subject','application_base_url','invitation_path',
            'template_reference','template_content','sender_reference','reply_to_reference')
        AND jsonb_typeof(e.value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'Invitation configuration values must be text' USING ERRCODE = '22023';
    END IF;
    SELECT revision INTO current_revision FROM public.user_invitation_email_settings WHERE channel='email' FOR UPDATE;
    IF current_revision IS DISTINCT FROM (p_input->>'revision')::INTEGER THEN
        RAISE EXCEPTION 'Invitation settings changed; reload before saving' USING ERRCODE = '40001';
    END IF;
    UPDATE public.user_invitation_email_settings SET
        enabled=(p_input->>'enabled')::BOOLEAN, delivery_mode=p_input->>'delivery_mode',
        organization_name=p_input->>'organization_name', application_name=p_input->>'application_name',
        subject=p_input->>'subject', application_base_url=p_input->>'application_base_url',
        invitation_path=p_input->>'invitation_path', template_reference=p_input->>'template_reference',
        template_content=p_input->>'template_content', sender_reference=p_input->>'sender_reference',
        reply_to_reference=p_input->>'reply_to_reference',
        revision=revision+1, updated_at=now(), updated_by=p_actor
    WHERE channel='email';
END;
$$;
REVOKE ALL ON FUNCTION public.save_user_invitation_email_settings(UUID,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_user_invitation_email_settings(UUID,JSONB) TO service_role;

COMMENT ON TABLE public.user_invitation_email_settings IS
    'Installation-level non-secret configuration intent only. Step 5 does not dispatch, render templates, or change existing Supabase Auth invitation delivery.';

COMMIT;
