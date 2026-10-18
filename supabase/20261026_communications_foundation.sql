BEGIN;

CREATE TABLE public.communication_channel_settings (
    channel TEXT PRIMARY KEY CHECK (channel IN ('email', 'sms')),
    provider TEXT CHECK (provider IS NULL OR provider = 'azure_communication_services'),
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    automated_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    from_name TEXT,
    from_address TEXT,
    reply_to_address TEXT,
    sending_domain TEXT,
    sending_phone_number TEXT,
    incoming_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    two_way_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL,
    CHECK (channel <> 'email' OR (sending_phone_number IS NULL AND NOT incoming_enabled AND NOT two_way_enabled)),
    CHECK (channel <> 'sms' OR (from_name IS NULL AND from_address IS NULL AND reply_to_address IS NULL AND sending_domain IS NULL))
);
INSERT INTO public.communication_channel_settings(channel) VALUES ('email'), ('sms');

CREATE TABLE public.communication_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
    direction TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound', 'inbound')),
    source TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automated')),
    status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Queued', 'Sending', 'Sent', 'Delivered', 'Failed', 'Cancelled')),
    subject TEXT,
    body TEXT NOT NULL CHECK (length(body) <= 100000),
    sender_name TEXT,
    sender_address TEXT,
    provider TEXT,
    provider_message_id TEXT,
    created_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL,
    sent_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revision INTEGER NOT NULL DEFAULT 1,
    queued_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    failure_reason TEXT
);
CREATE INDEX communication_messages_history ON public.communication_messages(created_at DESC, id);
CREATE INDEX communication_messages_filters ON public.communication_messages(channel, source, status);

CREATE TABLE public.communication_recipients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    recipient_type TEXT NOT NULL CHECK (recipient_type IN ('contractor_contact', 'dobco_contact', 'external')),
    recipient_name TEXT NOT NULL CHECK (btrim(recipient_name) <> ''),
    email TEXT,
    mobile_phone TEXT,
    contractor_contact_id UUID REFERENCES public.contractor_contacts(id) ON DELETE RESTRICT,
    dobco_contact_id UUID REFERENCES public.dobco_contacts(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'Draft' CHECK (status IN ('Draft', 'Queued', 'Sending', 'Sent', 'Delivered', 'Failed', 'Cancelled')),
    provider_recipient_id TEXT,
    failure_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    queued_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    cancelled_at TIMESTAMPTZ,
    CHECK ((recipient_type = 'contractor_contact' AND contractor_contact_id IS NOT NULL AND dobco_contact_id IS NULL)
        OR (recipient_type = 'dobco_contact' AND dobco_contact_id IS NOT NULL AND contractor_contact_id IS NULL)
        OR (recipient_type = 'external' AND contractor_contact_id IS NULL AND dobco_contact_id IS NULL))
);
CREATE INDEX communication_recipients_message ON public.communication_recipients(message_id);
CREATE INDEX communication_recipients_contractor_contact ON public.communication_recipients(contractor_contact_id) WHERE contractor_contact_id IS NOT NULL;
CREATE INDEX communication_recipients_dobco_contact ON public.communication_recipients(dobco_contact_id) WHERE dobco_contact_id IS NOT NULL;

CREATE TABLE public.communication_contractors (
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    PRIMARY KEY (message_id, contractor_id)
);
CREATE INDEX communication_contractors_lookup ON public.communication_contractors(contractor_id);
CREATE TABLE public.communication_projects (
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    project_id INTEGER NOT NULL REFERENCES public.projects(id) ON DELETE RESTRICT,
    PRIMARY KEY (message_id, project_id)
);
CREATE INDEX communication_projects_lookup ON public.communication_projects(project_id);
CREATE TABLE public.communication_compliance_items (
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    compliance_record_id INTEGER NOT NULL REFERENCES public.compliance_records(id) ON DELETE RESTRICT,
    PRIMARY KEY (message_id, compliance_record_id)
);
CREATE INDEX communication_compliance_lookup ON public.communication_compliance_items(compliance_record_id);
CREATE TABLE public.communication_mycoi_items (
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    policy_id INTEGER NOT NULL REFERENCES public.mycoi_policies(id) ON DELETE RESTRICT,
    PRIMARY KEY (message_id, policy_id)
);
CREATE INDEX communication_mycoi_lookup ON public.communication_mycoi_items(policy_id);
CREATE TABLE public.communication_insurance_items (
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    contractor_id INTEGER NOT NULL REFERENCES public.contractor_insurance(contractor_id) ON DELETE RESTRICT,
    item_key TEXT NOT NULL CHECK (item_key IN ('certificate_of_insurance', 'general_liability', 'workers_compensation')),
    PRIMARY KEY (message_id, contractor_id, item_key)
);
CREATE INDEX communication_insurance_lookup ON public.communication_insurance_items(contractor_id);

-- Server-only tables: no authenticated full-row policy can bypass the API projections.
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['communication_channel_settings','communication_messages','communication_recipients',
        'communication_contractors','communication_projects','communication_compliance_items',
        'communication_mycoi_items','communication_insurance_items']
    LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated, service_role', t);
        EXECUTE format('GRANT SELECT ON public.%I TO service_role', t);
    END LOOP;
END;
$$;

-- Actor IDs come only from getRequestContext, never the request body.
CREATE FUNCTION public.communication_actor_allowed(p_actor UUID, p_module TEXT, p_action TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_profiles u
        LEFT JOIN public.role_permissions p ON p.role = u.role AND p.module = p_module
        WHERE u.auth_user_id = p_actor AND u.status = 'Active'
          AND (u.system_administrator OR CASE p_action
            WHEN 'view' THEN p.can_view WHEN 'add' THEN p.can_add
            WHEN 'edit' THEN p.can_edit WHEN 'manage' THEN p.can_manage ELSE FALSE END)
    );
$$;
REVOKE ALL ON FUNCTION public.communication_actor_allowed(UUID,TEXT,TEXT) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.save_communication_settings(p_actor UUID, p_channel TEXT, p_input JSONB)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE current_revision INTEGER;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE = '42501';
    END IF;
    IF p_channel NOT IN ('email','sms') OR jsonb_typeof(p_input) <> 'object' OR p_input IS NULL THEN
        RAISE EXCEPTION 'Invalid channel settings' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k <> ALL(
        CASE WHEN p_channel = 'email' THEN ARRAY['provider','enabled','automated_enabled','from_name','from_address','reply_to_address','sending_domain','revision']
        ELSE ARRAY['provider','enabled','automated_enabled','sending_phone_number','incoming_enabled','two_way_enabled','revision'] END)) THEN
        RAISE EXCEPTION 'Unsupported settings field' USING ERRCODE = '22023';
    END IF;
    SELECT revision INTO current_revision FROM public.communication_channel_settings WHERE channel=p_channel FOR UPDATE;
    IF current_revision IS DISTINCT FROM (p_input->>'revision')::INTEGER THEN
        RAISE EXCEPTION 'Settings changed; reload before saving' USING ERRCODE = '40001';
    END IF;
    UPDATE public.communication_channel_settings SET
        provider=p_input->>'provider', enabled=(p_input->>'enabled')::BOOLEAN,
        automated_enabled=(p_input->>'automated_enabled')::BOOLEAN,
        from_name=p_input->>'from_name', from_address=p_input->>'from_address',
        reply_to_address=p_input->>'reply_to_address', sending_domain=p_input->>'sending_domain',
        sending_phone_number=p_input->>'sending_phone_number',
        incoming_enabled=coalesce((p_input->>'incoming_enabled')::BOOLEAN,FALSE),
        two_way_enabled=coalesce((p_input->>'two_way_enabled')::BOOLEAN,FALSE),
        revision=revision+1, updated_at=now(), updated_by=p_actor
    WHERE channel=p_channel;
END;
$$;

CREATE FUNCTION public.save_communication_draft(p_actor UUID, p_id UUID, p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    message_id UUID := p_id;
    existing public.communication_messages;
    r JSONB;
    channel_settings public.communication_channel_settings;
    c_ids INTEGER[];
    p_ids INTEGER[];
    compliance_ids INTEGER[];
    policy_ids INTEGER[];
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'communications_content',CASE WHEN p_id IS NULL THEN 'add' ELSE 'edit' END) THEN
        RAISE EXCEPTION 'Communications Content mutation permission required' USING ERRCODE = '42501';
    END IF;
    IF p_input IS NULL OR jsonb_typeof(p_input) <> 'object'
      OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k <> ALL(ARRAY[
        'channel','subject','body','recipients','contractor_ids','project_ids','compliance_record_ids','mycoi_policy_ids','insurance_items','revision']))
      OR p_input->>'channel' NOT IN ('email','sms')
      OR jsonb_typeof(p_input->'body') IS DISTINCT FROM 'string'
      OR length(p_input->>'body') NOT BETWEEN 1 AND 100000 THEN
        RAISE EXCEPTION 'Invalid draft input' USING ERRCODE = '22023';
    END IF;
    IF p_id IS NOT NULL THEN
        SELECT * INTO existing FROM public.communication_messages WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Communication not found' USING ERRCODE = 'P0002'; END IF;
        IF existing.status <> 'Draft' OR existing.source <> 'manual' OR existing.direction <> 'outbound' THEN
            RAISE EXCEPTION 'Only manual outbound Draft communications can be edited' USING ERRCODE = '22023';
        END IF;
        IF existing.revision IS DISTINCT FROM (p_input->>'revision')::INTEGER THEN
            RAISE EXCEPTION 'Draft changed; reload before saving' USING ERRCODE = '40001';
        END IF;
    END IF;
    FOREACH r IN ARRAY ARRAY[p_input->'recipients',p_input->'contractor_ids',p_input->'project_ids',
        p_input->'compliance_record_ids',p_input->'mycoi_policy_ids',p_input->'insurance_items'] LOOP
        IF jsonb_typeof(r) IS DISTINCT FROM 'array' OR jsonb_array_length(r)>100 THEN
            RAISE EXCEPTION 'Expected bounded relationship arrays' USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF jsonb_array_length(p_input->'recipients')=0 THEN
        RAISE EXCEPTION 'At least one recipient snapshot required' USING ERRCODE = '22023';
    END IF;
    SELECT coalesce(array_agg(value::INTEGER),ARRAY[]::INTEGER[]) INTO c_ids FROM jsonb_array_elements_text(p_input->'contractor_ids');
    SELECT coalesce(array_agg(value::INTEGER),ARRAY[]::INTEGER[]) INTO p_ids FROM jsonb_array_elements_text(p_input->'project_ids');
    SELECT coalesce(array_agg(value::INTEGER),ARRAY[]::INTEGER[]) INTO compliance_ids FROM jsonb_array_elements_text(p_input->'compliance_record_ids');
    SELECT coalesce(array_agg(value::INTEGER),ARRAY[]::INTEGER[]) INTO policy_ids FROM jsonb_array_elements_text(p_input->'mycoi_policy_ids');
    IF (cardinality(c_ids)>0 AND NOT public.communication_actor_allowed(p_actor,'contractors','view'))
      OR (cardinality(p_ids)>0 AND NOT public.communication_actor_allowed(p_actor,'projects','view'))
      OR (cardinality(compliance_ids)>0 AND NOT public.communication_actor_allowed(p_actor,'compliance','view'))
      OR ((cardinality(policy_ids)>0 OR jsonb_array_length(p_input->'insurance_items')>0)
          AND NOT public.communication_actor_allowed(p_actor,'insurance','view')) THEN
        RAISE EXCEPTION 'Related business-record View permission required' USING ERRCODE = '42501';
    END IF;
    IF EXISTS(SELECT 1 FROM unnest(compliance_ids) i LEFT JOIN public.compliance_records c ON c.id=i WHERE c.id IS NULL OR NOT(c.contractor_id=ANY(c_ids)))
      OR EXISTS(SELECT 1 FROM unnest(policy_ids) i LEFT JOIN public.mycoi_policies p ON p.id=i WHERE p.id IS NULL OR NOT(p.contractor_id=ANY(c_ids))) THEN
        RAISE EXCEPTION 'Related item does not belong to a linked contractor' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO channel_settings FROM public.communication_channel_settings WHERE channel=p_input->>'channel';
    IF p_id IS NULL THEN
        INSERT INTO public.communication_messages(channel,subject,body,provider,sender_name,sender_address,created_by)
        VALUES(p_input->>'channel',p_input->>'subject',p_input->>'body',channel_settings.provider,
          CASE WHEN channel_settings.channel='email' THEN channel_settings.from_name END,
          CASE WHEN channel_settings.channel='email' THEN channel_settings.from_address ELSE channel_settings.sending_phone_number END,p_actor)
        RETURNING id INTO message_id;
    ELSE
        UPDATE public.communication_messages SET channel=p_input->>'channel',subject=p_input->>'subject',body=p_input->>'body',
          provider=channel_settings.provider,sender_name=CASE WHEN channel_settings.channel='email' THEN channel_settings.from_name END,
          sender_address=CASE WHEN channel_settings.channel='email' THEN channel_settings.from_address ELSE channel_settings.sending_phone_number END,
          revision=revision+1,updated_at=now() WHERE id=p_id;
        DELETE FROM public.communication_recipients WHERE communication_recipients.message_id=p_id;
        DELETE FROM public.communication_contractors WHERE communication_contractors.message_id=p_id;
        DELETE FROM public.communication_projects WHERE communication_projects.message_id=p_id;
        DELETE FROM public.communication_compliance_items WHERE communication_compliance_items.message_id=p_id;
        DELETE FROM public.communication_mycoi_items WHERE communication_mycoi_items.message_id=p_id;
        DELETE FROM public.communication_insurance_items WHERE communication_insurance_items.message_id=p_id;
    END IF;
    INSERT INTO public.communication_contractors SELECT message_id,unnest(c_ids);
    INSERT INTO public.communication_projects SELECT message_id,unnest(p_ids);
    INSERT INTO public.communication_compliance_items SELECT message_id,unnest(compliance_ids);
    INSERT INTO public.communication_mycoi_items SELECT message_id,unnest(policy_ids);
    FOR r IN SELECT value FROM jsonb_array_elements(p_input->'insurance_items') LOOP
        IF NOT((r->>'contractor_id')::INTEGER=ANY(c_ids)) OR
          EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN ('contractor_id','item_key')) THEN
            RAISE EXCEPTION 'Insurance item must belong to a linked contractor' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.communication_insurance_items VALUES(message_id,(r->>'contractor_id')::INTEGER,r->>'item_key');
    END LOOP;
    FOR r IN SELECT value FROM jsonb_array_elements(p_input->'recipients') LOOP
        IF jsonb_typeof(r) <> 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN
            ('recipient_type','recipient_name','email','mobile_phone','contractor_contact_id','dobco_contact_id'))
          OR nullif(btrim(CASE WHEN p_input->>'channel'='email' THEN r->>'email' ELSE r->>'mobile_phone' END),'') IS NULL THEN
            RAISE EXCEPTION 'Invalid recipient snapshot' USING ERRCODE = '22023';
        END IF;
        IF r->>'contractor_contact_id' IS NOT NULL AND (NOT public.communication_actor_allowed(p_actor,'contractors','view')
          OR NOT EXISTS(SELECT 1 FROM public.contractor_contacts c WHERE c.id=(r->>'contractor_contact_id')::UUID AND c.contractor_id=ANY(c_ids))) THEN
            RAISE EXCEPTION 'Contractor contact does not belong to a linked contractor' USING ERRCODE = '22023';
        END IF;
        IF r->>'dobco_contact_id' IS NOT NULL AND NOT public.communication_actor_allowed(p_actor,'settings','view') THEN
            RAISE EXCEPTION 'Settings View permission required for Dobco contact reference' USING ERRCODE = '42501';
        END IF;
        INSERT INTO public.communication_recipients(message_id,recipient_type,recipient_name,email,mobile_phone,contractor_contact_id,dobco_contact_id)
        VALUES(message_id,r->>'recipient_type',r->>'recipient_name',r->>'email',r->>'mobile_phone',
          (r->>'contractor_contact_id')::UUID,(r->>'dobco_contact_id')::UUID);
    END LOOP;
    RETURN message_id;
END;
$$;

REVOKE ALL ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB), public.save_communication_draft(UUID,UUID,JSONB) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_communication_settings(UUID,TEXT,JSONB), public.save_communication_draft(UUID,UUID,JSONB) TO service_role;

COMMENT ON TABLE public.communication_messages IS
  'Authoritative provider-independent history. Step 5 exposes only manual outbound Draft mutations. Future sending must freeze final body, sender and recipient snapshots before leaving Draft.';
COMMENT ON TABLE public.communication_channel_settings IS
  'Installation-level nonsecret configuration only. No credential columns. Enablement records intent; no sending or automation is implemented.';
COMMENT ON TABLE public.communication_recipients IS
  'Explicit destination snapshots, never reconstructed from current contacts. Draft save may replace snapshots; no post-Draft edit path exists.';

COMMIT;
