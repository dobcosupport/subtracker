BEGIN;

ALTER TABLE public.communication_channel_settings
    ADD COLUMN sms_verification_status TEXT NOT NULL DEFAULT 'not_recorded',
    ADD CONSTRAINT communication_sms_verification_status_check CHECK (
        sms_verification_status IN ('not_recorded','not_submitted','under_review','approved','rejected')),
    ADD CONSTRAINT communication_sms_verification_channel_check CHECK (
        channel='sms' OR sms_verification_status='not_recorded');

ALTER FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) RENAME TO save_communication_settings_before_sms_verification;
REVOKE ALL ON FUNCTION public.save_communication_settings_before_sms_verification(UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_communication_settings(p_actor UUID, p_channel TEXT, p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE saved_phone TEXT; saved_status TEXT; next_status TEXT;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE='42501';
    END IF;
    IF p_channel IS NULL OR p_channel NOT IN ('email','sms') OR p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN
        RAISE EXCEPTION 'Invalid channel settings' USING ERRCODE='22023';
    END IF;
    IF p_input ? 'sms_verification_status' AND (
        p_channel<>'sms' OR jsonb_typeof(p_input->'sms_verification_status') IS DISTINCT FROM 'string'
        OR p_input->>'sms_verification_status' NOT IN ('not_recorded','not_submitted','under_review','approved','rejected')) THEN
        RAISE EXCEPTION 'Invalid SMS verification status' USING ERRCODE='22023';
    END IF;
    SELECT sending_phone_number,sms_verification_status INTO saved_phone,saved_status
        FROM public.communication_channel_settings WHERE channel=p_channel FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Channel settings not found' USING ERRCODE='P0002'; END IF;
    next_status := coalesce(p_input->>'sms_verification_status',saved_status);
    IF p_channel='sms' AND saved_phone IS DISTINCT FROM p_input->>'sending_phone_number' THEN
        IF p_input ? 'sms_verification_status' AND next_status<>'not_recorded' THEN
            RAISE EXCEPTION 'Save the changed sender before recording its verification status' USING ERRCODE='22023';
        END IF;
        next_status := 'not_recorded';
    END IF;
    IF p_channel='sms' AND next_status<>'not_recorded' AND nullif(btrim(p_input->>'sending_phone_number'),'') IS NULL THEN
        RAISE EXCEPTION 'SMS sender is required before recording verification' USING ERRCODE='22023';
    END IF;
    PERFORM public.save_communication_settings_before_sms_verification(p_actor,p_channel,p_input-'sms_verification_status');
    IF p_channel='sms' THEN
        UPDATE public.communication_channel_settings SET sms_verification_status=next_status WHERE channel=p_channel;
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) TO service_role;

COMMENT ON COLUMN public.communication_channel_settings.sms_verification_status IS
    'Administrator-recorded carrier/toll-free verification for the saved SMS sender; not an ACS connectivity test or delivery authorization. Resets when sender changes.';
COMMIT;
