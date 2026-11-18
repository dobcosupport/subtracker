-- Reviewed Email Importance defaults and frozen message choices. No delivery or settings changes.
BEGIN;

ALTER TABLE public.communication_templates
    ADD COLUMN default_importance TEXT NOT NULL DEFAULT 'normal'
        CHECK(default_importance IN('normal','high','low'));

ALTER FUNCTION public.save_communication_template(UUID,UUID,JSONB) RENAME TO save_communication_template_before_importance;
REVOKE ALL ON FUNCTION public.save_communication_template_before_importance(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_template(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result UUID;
BEGIN
    IF p_input ? 'default_importance' AND (jsonb_typeof(p_input->'default_importance') IS DISTINCT FROM 'string'
        OR p_input->>'default_importance' NOT IN('normal','high','low')) THEN
        RAISE EXCEPTION 'Invalid Email Importance' USING ERRCODE='22023';
    END IF;
    result:=save_communication_template_before_importance(p_actor,p_id,p_input-'default_importance');
    UPDATE communication_templates SET default_importance=coalesce(p_input->>'default_importance',default_importance) WHERE id=result;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.save_communication_template(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_template(UUID,UUID,JSONB) TO service_role;

ALTER FUNCTION public.communication_template_context(UUID,JSONB) RENAME TO communication_template_context_before_importance;
REVOKE ALL ON FUNCTION public.communication_template_context_before_importance(UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.communication_template_context(p_actor UUID,p_input JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE resolved JSONB; importance TEXT;
BEGIN
    resolved:=communication_template_context_before_importance(p_actor,p_input-'importance');
    IF p_input ? 'importance' AND jsonb_typeof(p_input->'importance') IS DISTINCT FROM 'string' THEN
        RAISE EXCEPTION 'Invalid Email Importance' USING ERRCODE='22023';
    END IF;
    importance:=coalesce(p_input->>'importance',resolved->'template'->>'default_importance','normal');
    IF importance NOT IN('normal','high','low') THEN
        RAISE EXCEPTION 'Invalid Email Importance' USING ERRCODE='22023';
    END IF;
    RETURN resolved||jsonb_build_object('importance',importance);
END $$;
REVOKE ALL ON FUNCTION public.communication_template_context(UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_template_context(UUID,JSONB) TO service_role;

ALTER FUNCTION public.save_communication_draft(UUID,UUID,JSONB) RENAME TO save_communication_draft_before_importance;
REVOKE ALL ON FUNCTION public.save_communication_draft_before_importance(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_draft(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result UUID; previous communication_messages; saved communication_messages; importance TEXT;
BEGIN
    IF p_id IS NOT NULL THEN SELECT * INTO previous FROM communication_messages WHERE id=p_id FOR UPDATE; END IF;
    IF p_input ? 'importance' AND (p_input->>'channel' IS DISTINCT FROM 'email'
        OR jsonb_typeof(p_input->'importance') IS DISTINCT FROM 'string'
        OR p_input->>'importance' NOT IN('normal','high','low')) THEN
        RAISE EXCEPTION 'Invalid Email Importance' USING ERRCODE='22023';
    END IF;
    result:=save_communication_draft_before_importance(p_actor,p_id,p_input-'importance');
    SELECT * INTO saved FROM communication_messages WHERE id=result;
    IF saved.channel='email' THEN
        -- Editing an existing message never reloads a live template default.
        importance:=coalesce(p_input->>'importance',previous.context_snapshot->>'importance',
            CASE WHEN p_id IS NOT NULL THEN 'normal' END,
            saved.context_snapshot->'template_render'->'template'->>'default_importance','normal');
        UPDATE communication_messages SET context_snapshot=jsonb_set(context_snapshot,'{importance}',to_jsonb(importance)) WHERE id=result;
    END IF;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) TO service_role;

-- This reservation is shared by manual sends and the existing scheduled worker.
ALTER FUNCTION public.reserve_communication_email_state(UUID,UUID,INTEGER,TEXT) RENAME TO reserve_communication_email_state_before_importance;
REVOKE ALL ON FUNCTION public.reserve_communication_email_state_before_importance(UUID,UUID,INTEGER,TEXT) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.reserve_communication_email_state(p_actor UUID,p_message_id UUID,p_settings_revision INTEGER,p_status TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE reserved JSONB; importance TEXT;
BEGIN
    reserved:=reserve_communication_email_state_before_importance(p_actor,p_message_id,p_settings_revision,p_status);
    SELECT coalesce(context_snapshot->>'importance','normal') INTO importance FROM communication_messages WHERE id=p_message_id;
    IF importance NOT IN('normal','high','low') THEN
        RAISE EXCEPTION 'Invalid saved Email Importance' USING ERRCODE='22023';
    END IF;
    RETURN reserved||jsonb_build_object('importance',importance);
END $$;
REVOKE ALL ON FUNCTION public.reserve_communication_email_state(UUID,UUID,INTEGER,TEXT) FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
