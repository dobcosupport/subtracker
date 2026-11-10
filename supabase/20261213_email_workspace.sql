BEGIN;

ALTER TABLE public.communication_channel_settings
    ADD COLUMN contractor_email_enabled BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN internal_email_enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.communication_recipients
    ADD COLUMN recipient_role TEXT NOT NULL DEFAULT 'to'
        CHECK (recipient_role IN ('to','cc','bcc'));

ALTER FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) RENAME TO save_communication_settings_before_workspace;
REVOKE ALL ON FUNCTION public.save_communication_settings_before_workspace(UUID,TEXT,JSONB)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_settings(p_actor UUID,p_channel TEXT,p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE k TEXT; previous communication_channel_settings; current_settings communication_channel_settings;
BEGIN
    FOREACH k IN ARRAY ARRAY['contractor_email_enabled','internal_email_enabled'] LOOP
        IF p_input ? k AND (p_channel<>'email' OR jsonb_typeof(p_input->k) IS DISTINCT FROM 'boolean') THEN
            RAISE EXCEPTION 'Email controls must be boolean Email settings' USING ERRCODE='22023';
        END IF;
    END LOOP;
    IF p_channel='email' THEN
        SELECT * INTO previous FROM communication_channel_settings WHERE channel='email' FOR UPDATE;
    END IF;
    PERFORM save_communication_settings_before_workspace(p_actor,p_channel,
        p_input-ARRAY['contractor_email_enabled','internal_email_enabled']);
    IF p_channel='email' THEN
        UPDATE communication_channel_settings SET
            contractor_email_enabled=coalesce((p_input->>'contractor_email_enabled')::boolean,contractor_email_enabled),
            internal_email_enabled=coalesce((p_input->>'internal_email_enabled')::boolean,internal_email_enabled)
        WHERE channel='email';
        SELECT * INTO current_settings FROM communication_channel_settings WHERE channel='email';
        IF (previous.contractor_email_enabled IS DISTINCT FROM current_settings.contractor_email_enabled
            OR previous.internal_email_enabled IS DISTINCT FROM current_settings.internal_email_enabled)
            AND (to_jsonb(previous)-ARRAY['contractor_email_enabled','internal_email_enabled','revision','updated_at','updated_by'])
                IS NOT DISTINCT FROM
                (to_jsonb(current_settings)-ARRAY['contractor_email_enabled','internal_email_enabled','revision','updated_at','updated_by']) THEN
            -- Recipient switches do not change the already-tested Microsoft sender/identity.
            UPDATE microsoft_email_connection_state SET settings_revision=current_settings.revision
                WHERE channel='email' AND settings_revision=previous.revision
                AND authentication_status='Verified' AND delivery_status='Accepted by Graph';
        END IF;
    END IF;
END $$;
REVOKE ALL ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB) TO service_role;

CREATE FUNCTION public.communication_email_exclusion(p_type TEXT,p_contact UUID,p_email TEXT)
RETURNS TEXT LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s communication_channel_settings; c contractor_contacts; d dobco_contacts;
BEGIN
    SELECT * INTO s FROM communication_channel_settings WHERE channel='email';
    IF NOT FOUND OR NOT s.enabled THEN RETURN 'Email is currently disabled in Email Settings.'; END IF;
    IF p_email IS NULL OR p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' THEN
        RETURN 'A valid email address is required.';
    END IF;
    IF p_type='dobco_contact' THEN
        IF NOT s.internal_email_enabled THEN RETURN 'Dobco internal email is currently disabled in Email Settings.'; END IF;
        SELECT * INTO d FROM dobco_contacts WHERE id=p_contact;
        IF NOT FOUND OR NOT d.is_active OR NOT d.receives_internal_email
            OR lower(d.email) IS DISTINCT FROM lower(p_email) THEN
            RETURN 'This Dobco contact has email disabled, is inactive, or has changed.';
        END IF;
    ELSIF p_type='contractor_contact' THEN
        IF NOT s.contractor_email_enabled THEN RETURN 'Contractor email is currently disabled in Email Settings.'; END IF;
        SELECT * INTO c FROM contractor_contacts WHERE id=p_contact;
        IF NOT FOUND OR NOT c.is_active OR NOT c.receives_compliance_email
            OR lower(c.email) IS DISTINCT FROM lower(p_email) THEN
            RETURN 'This contractor contact has email disabled, is inactive, or has changed.';
        END IF;
    ELSIF p_type='external' THEN
        IF NOT s.contractor_email_enabled THEN RETURN 'Contractor email is currently disabled in Email Settings.'; END IF;
        -- Raw addresses cannot disguise a disabled contact or bypass the internal master.
        IF EXISTS(SELECT 1 FROM dobco_contacts WHERE lower(email)=lower(p_email)
            AND (NOT s.internal_email_enabled OR NOT is_active OR NOT receives_internal_email))
            OR EXISTS(SELECT 1 FROM contractor_contacts WHERE lower(email)=lower(p_email)
                AND (NOT is_active OR NOT receives_compliance_email)) THEN
            RETURN 'This address is excluded by an existing contact email preference.';
        END IF;
    ELSE RETURN 'Unsupported email recipient type.';
    END IF;
    RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION public.communication_email_exclusion(TEXT,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_email_exclusion(TEXT,UUID,TEXT) TO service_role;

CREATE FUNCTION public.communication_email_workspace_controls(p_actor UUID)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF NOT (communication_actor_allowed(p_actor,'communications_content','add')
        OR communication_actor_allowed(p_actor,'communications_content','edit')
        OR communication_actor_allowed(p_actor,'settings','view')) THEN
        RAISE EXCEPTION 'Email workspace permission required' USING ERRCODE='42501';
    END IF;
    RETURN (SELECT jsonb_build_object('enabled',enabled,'contractor_email_enabled',contractor_email_enabled,
        'internal_email_enabled',internal_email_enabled) FROM communication_channel_settings WHERE channel='email');
END $$;
REVOKE ALL ON FUNCTION public.communication_email_workspace_controls(UUID) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_email_workspace_controls(UUID) TO service_role;

CREATE FUNCTION public.communication_email_eligibility(p_actor UUID,p_recipients JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r JSONB; result JSONB:='[]'; contact UUID;
BEGIN
    IF NOT (communication_actor_allowed(p_actor,'communications_content','add')
        OR communication_actor_allowed(p_actor,'communications_content','edit')) THEN
        RAISE EXCEPTION 'Composition permission required' USING ERRCODE='42501';
    END IF;
    IF jsonb_typeof(p_recipients) IS DISTINCT FROM 'array' OR jsonb_array_length(p_recipients)>100 THEN
        RAISE EXCEPTION 'At most 100 recipients across To, Cc and Bcc' USING ERRCODE='22023';
    END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_recipients) LOOP
        IF (r->>'recipient_type'='dobco_contact' AND NOT communication_actor_allowed(p_actor,'settings','view'))
            OR (r->>'recipient_type'='contractor_contact' AND NOT communication_actor_allowed(p_actor,'contractors','view')) THEN
            RAISE EXCEPTION 'Recipient source permission required' USING ERRCODE='42501';
        END IF;
        contact:=coalesce((r->>'contractor_contact_id')::uuid,(r->>'dobco_contact_id')::uuid);
        result:=result||jsonb_build_array(jsonb_build_object('email',r->>'email','recipient_role',coalesce(r->>'recipient_role','to'),
            'reason',communication_email_exclusion(r->>'recipient_type',contact,r->>'email')));
    END LOOP;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.communication_email_eligibility(UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_email_eligibility(UUID,JSONB) TO service_role;

ALTER FUNCTION public.save_communication_draft(UUID,UUID,JSONB) RENAME TO save_communication_draft_before_workspace;
REVOKE ALL ON FUNCTION public.save_communication_draft_before_workspace(UUID,UUID,JSONB)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_draft(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r JSONB; stripped JSONB; result UUID;
BEGIN
    IF jsonb_typeof(p_input->'recipients') IS DISTINCT FROM 'array'
        OR jsonb_array_length(p_input->'recipients') NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'Choose between 1 and 100 recipients across To, Cc and Bcc' USING ERRCODE='22023';
    END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(p_input->'recipients') LOOP
        IF r ? 'recipient_role' AND (jsonb_typeof(r->'recipient_role') IS DISTINCT FROM 'string'
            OR r->>'recipient_role' NOT IN ('to','cc','bcc')
            OR (p_input->>'channel'<>'email' AND r->>'recipient_role'<>'to')) THEN
            RAISE EXCEPTION 'Invalid recipient role' USING ERRCODE='22023';
        END IF;
    END LOOP;
    IF p_input->>'channel'='email' AND
        (SELECT count(*)<>count(DISTINCT lower(value->>'email')) FROM jsonb_array_elements(p_input->'recipients')) THEN
        RAISE EXCEPTION 'Duplicate email addresses across To, Cc and Bcc are not allowed' USING ERRCODE='22023';
    END IF;
    SELECT jsonb_agg(value-'recipient_role') INTO stripped FROM jsonb_array_elements(p_input->'recipients');
    result:=save_communication_draft_before_workspace(p_actor,p_id,jsonb_set(p_input,'{recipients}',stripped));
    IF p_input->>'channel'='email' THEN
        FOR r IN SELECT value FROM jsonb_array_elements(p_input->'recipients') LOOP
            UPDATE communication_recipients SET recipient_role=coalesce(r->>'recipient_role','to')
                WHERE message_id=result AND lower(email)=lower(r->>'email');
        END LOOP;
    END IF;
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) TO service_role;

-- Both reviewed notices and ordinary sends already converge on this reservation.
ALTER FUNCTION public.reserve_communication_email_send_before_notice(UUID,UUID,INTEGER)
    RENAME TO reserve_communication_email_send_before_workspace;
REVOKE ALL ON FUNCTION public.reserve_communication_email_send_before_workspace(UUID,UUID,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.reserve_communication_email_send_before_notice(p_actor UUID,p_message_id UUID,p_settings_revision INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r communication_recipients; reason TEXT; result JSONB;
BEGIN
    PERFORM 1 FROM communication_channel_settings WHERE channel='email' FOR SHARE;
    PERFORM 1 FROM communication_messages WHERE id=p_message_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM communication_messages WHERE id=p_message_id
        AND (body ~ '\{\{|\}\}' OR subject ~ '\{\{|\}\}')) THEN
        RAISE EXCEPTION 'Resolve all template fields before sending' USING ERRCODE='22023';
    END IF;
    -- Lock current contact preferences for the entire reservation transaction.
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
    result:=reserve_communication_email_send_before_workspace(p_actor,p_message_id,p_settings_revision);
    RETURN jsonb_set(result,'{recipients}',(SELECT jsonb_agg(jsonb_build_object('email',email,'recipient_role',recipient_role)
        ORDER BY id) FROM communication_recipients WHERE message_id=p_message_id));
END $$;
REVOKE ALL ON FUNCTION public.reserve_communication_email_send_before_notice(UUID,UUID,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
