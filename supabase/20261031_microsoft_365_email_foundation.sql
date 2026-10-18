BEGIN;

ALTER TABLE public.communication_channel_settings
    ADD COLUMN microsoft_tenant_id TEXT,
    ADD COLUMN microsoft_client_id TEXT,
    ADD CONSTRAINT communication_microsoft_email_only CHECK (
        channel='email' OR (microsoft_tenant_id IS NULL AND microsoft_client_id IS NULL)),
    ADD CONSTRAINT communication_microsoft_tenant_uuid CHECK (
        microsoft_tenant_id IS NULL OR microsoft_tenant_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
    ADD CONSTRAINT communication_microsoft_client_uuid CHECK (
        microsoft_client_id IS NULL OR microsoft_client_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

ALTER TABLE public.communication_channel_settings DROP CONSTRAINT communication_channel_settings_provider_check;
ALTER TABLE public.communication_channel_settings ADD CONSTRAINT communication_channel_settings_provider_check
    CHECK (provider IS NULL OR provider='azure_communication_services'
        OR (channel='email' AND provider='microsoft_365') OR (channel='sms' AND provider='twilio'));

ALTER FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) RENAME TO save_communication_settings_base;
REVOKE ALL ON FUNCTION public.save_communication_settings_base(UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_communication_settings(p_actor UUID, p_channel TEXT, p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE base_input JSONB; saved_domain TEXT;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE='42501';
    END IF;
    IF p_channel IS NULL OR p_channel NOT IN ('email','sms') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN
        RAISE EXCEPTION 'Invalid channel settings' USING ERRCODE='22023';
    END IF;
    IF p_channel='sms' AND (p_input ? 'microsoft_tenant_id' OR p_input ? 'microsoft_client_id') THEN
        RAISE EXCEPTION 'Microsoft 365 is an Email provider only' USING ERRCODE='22023';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_each(p_input) e WHERE e.key IN ('microsoft_tenant_id','microsoft_client_id') AND jsonb_typeof(e.value) NOT IN ('string','null')) THEN
        RAISE EXCEPTION 'Microsoft identifiers must be text or null' USING ERRCODE='22023';
    END IF;
    SELECT sending_domain INTO saved_domain FROM public.communication_channel_settings WHERE channel=p_channel FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Channel settings not found' USING ERRCODE='P0002'; END IF;
    base_input := p_input-'microsoft_tenant_id'-'microsoft_client_id';
    IF p_channel='email' AND NOT (base_input ? 'sending_domain') THEN
        base_input := base_input || jsonb_build_object('sending_domain',saved_domain);
    END IF;
    PERFORM public.save_communication_settings_base(p_actor,p_channel,base_input);
    IF p_channel='email' THEN
        UPDATE public.communication_channel_settings SET
            microsoft_tenant_id=CASE WHEN p_input ? 'microsoft_tenant_id' THEN nullif(btrim(p_input->>'microsoft_tenant_id'),'') ELSE microsoft_tenant_id END,
            microsoft_client_id=CASE WHEN p_input ? 'microsoft_client_id' THEN nullif(btrim(p_input->>'microsoft_client_id'),'') ELSE microsoft_client_id END
        WHERE channel=p_channel;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) TO service_role;

COMMENT ON COLUMN public.communication_channel_settings.microsoft_tenant_id IS 'Installation Microsoft Entra tenant ID (non-secret). Application credentials belong only in the external Key Vault.';
COMMENT ON COLUMN public.communication_channel_settings.microsoft_client_id IS 'Installation Microsoft Entra application/client ID (non-secret). No Microsoft 365 testing or delivery is implemented.';
COMMIT;
