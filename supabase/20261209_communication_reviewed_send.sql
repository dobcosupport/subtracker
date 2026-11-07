BEGIN;

CREATE FUNCTION public.reserve_reviewed_communication_email_send(
    p_actor UUID, p_message_id UUID, p_settings_revision INTEGER, p_message_revision INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_revision INTEGER;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    PERFORM 1 FROM public.communication_channel_settings WHERE channel='email' FOR SHARE;
    SELECT revision INTO current_revision FROM public.communication_messages WHERE id=p_message_id FOR UPDATE;
    IF NOT FOUND OR p_message_revision IS NULL OR current_revision IS DISTINCT FROM p_message_revision THEN
        RAISE EXCEPTION 'Draft changed since review; reload and review it again' USING ERRCODE='40001';
    END IF;
    RETURN public.reserve_communication_email_send(p_actor,p_message_id,p_settings_revision);
END $$;

REVOKE ALL ON FUNCTION public.reserve_reviewed_communication_email_send(UUID,UUID,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_reviewed_communication_email_send(UUID,UUID,INTEGER,INTEGER) TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
