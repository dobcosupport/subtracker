-- Local review candidate only. Does not enable delivery or alter existing template configuration.
BEGIN;

ALTER TABLE public.communication_templates
    ADD COLUMN purpose TEXT NOT NULL DEFAULT '' CHECK(length(purpose)<=200),
    ADD COLUMN followup_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN followup_status TEXT NOT NULL DEFAULT 'Open'
        CHECK(followup_status IN('Open','Waiting Response','Resolved','Closed')),
    ADD COLUMN followup_delay_days INTEGER NOT NULL DEFAULT 30 CHECK(followup_delay_days BETWEEN 0 AND 36500),
    ADD COLUMN followup_subject TEXT NOT NULL DEFAULT '' CHECK(length(followup_subject)<=200),
    ADD COLUMN followup_related_item TEXT NOT NULL DEFAULT 'originating_compliance_record'
        CHECK(followup_related_item IN('contractor','originating_compliance_record')),
    ADD CONSTRAINT communication_template_followup_valid CHECK
        (NOT followup_enabled OR (channel='email' AND length(btrim(followup_subject))>0));

ALTER FUNCTION public.save_communication_template(UUID,UUID,JSONB) RENAME TO save_communication_template_before_actions;
REVOKE ALL ON FUNCTION public.save_communication_template_before_actions(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_template(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result UUID; config JSONB;
BEGIN
    IF NOT communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE='42501';
    END IF;
    config:=p_input-ARRAY['name','category','channel','subject','body','is_active','revision'];
    IF jsonb_typeof(config)<>'object'
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(config) k WHERE k NOT IN
            ('purpose','followup_enabled','followup_status','followup_delay_days','followup_subject','followup_related_item'))
        OR (config ? 'purpose' AND jsonb_typeof(config->'purpose')<>'string')
        OR (config ? 'followup_enabled' AND jsonb_typeof(config->'followup_enabled')<>'boolean')
        OR (config ? 'followup_status' AND jsonb_typeof(config->'followup_status')<>'string')
        OR (config ? 'followup_subject' AND jsonb_typeof(config->'followup_subject')<>'string')
        OR (config ? 'followup_related_item' AND jsonb_typeof(config->'followup_related_item')<>'string')
        OR (config ? 'followup_delay_days' AND (jsonb_typeof(config->'followup_delay_days')<>'number'
            OR config->>'followup_delay_days' !~ '^[0-9]{1,5}$')) THEN
        RAISE EXCEPTION 'Invalid template Follow-Up configuration' USING ERRCODE='22023';
    END IF;
    result:=save_communication_template_before_actions(p_actor,p_id,p_input-ARRAY
        ['purpose','followup_enabled','followup_status','followup_delay_days','followup_subject','followup_related_item']);
    UPDATE communication_templates SET
        purpose=coalesce(config->>'purpose',purpose),
        followup_enabled=coalesce((config->>'followup_enabled')::boolean,followup_enabled),
        followup_status=coalesce(config->>'followup_status',followup_status),
        followup_delay_days=coalesce((config->>'followup_delay_days')::integer,followup_delay_days),
        followup_subject=coalesce(config->>'followup_subject',followup_subject),
        followup_related_item=coalesce(config->>'followup_related_item',followup_related_item)
        WHERE id=result;
    RETURN result;
END $$;

CREATE FUNCTION public.communication_template_context(p_actor UUID,p_input JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE values JSONB; row_data JSONB; contractor_ids JSONB:=coalesce(p_input->'contractor_ids','[]');
    records JSONB:=coalesce(p_input->'compliance_record_ids','[]'); recipients JSONB:=coalesce(p_input->'recipients','[]');
    project_ids JSONB:=coalesce(p_input->'project_ids','[]'); recipient JSONB; template communication_templates;
    policies JSONB:=coalesce(p_input->'mycoi_policy_ids','[]');
BEGIN
    IF NOT (communication_actor_allowed(p_actor,'communications_content','add')
        OR communication_actor_allowed(p_actor,'communications_content','edit')
        OR communication_actor_allowed(p_actor,'communications_delivery','manage')) THEN
        RAISE EXCEPTION 'Communication rendering permission required' USING ERRCODE='42501';
    END IF;
    IF jsonb_typeof(contractor_ids)<>'array' OR jsonb_typeof(records)<>'array'
        OR jsonb_typeof(recipients)<>'array' OR jsonb_typeof(project_ids)<>'array' THEN
        RAISE EXCEPTION 'Invalid rendering context' USING ERRCODE='22023';
    END IF;
    SELECT jsonb_build_object('organization_name',s.organization_name,'application_name',s.application_name,
        'sender_name',c.from_name,'sender_email',c.from_address) INTO values
        FROM user_invitation_email_settings s CROSS JOIN communication_channel_settings c WHERE c.channel='email';
    values:=coalesce(values,'{}');
    IF jsonb_array_length(contractor_ids)>0 AND NOT communication_actor_allowed(p_actor,'contractors','view') THEN
        RAISE EXCEPTION 'Contractors View permission required' USING ERRCODE='42501';
    END IF;
    IF jsonb_array_length(contractor_ids)=1 THEN
        SELECT jsonb_build_object('contractor_name',company_name,'contractor_dba',dba_name) INTO row_data
            FROM public.contractors WHERE id=(contractor_ids->>0)::integer;
        IF row_data IS NULL THEN RAISE EXCEPTION 'Selected contractor is unavailable' USING ERRCODE='22023'; END IF;
        values:=values||row_data;
    END IF;
    IF jsonb_array_length(records)>0 THEN
        IF NOT communication_actor_allowed(p_actor,'compliance','view') OR NOT communication_actor_allowed(p_actor,'contractors','view') THEN
            RAISE EXCEPTION 'Compliance and Contractors View permissions required' USING ERRCODE='42501';
        END IF;
        IF jsonb_array_length(records)=1 THEN
            SELECT to_jsonb(c) INTO row_data FROM contractor_compliance_status c
                WHERE compliance_record_id=(records->>0)::integer;
            IF row_data IS NULL OR jsonb_array_length(contractor_ids)<>1
                OR row_data->>'contractor_id' IS DISTINCT FROM contractor_ids->>0 THEN
                RAISE EXCEPTION 'Select the contractor that owns the exact compliance record' USING ERRCODE='22023';
            END IF;
            values:=values||jsonb_build_object('compliance_type',row_data->>'compliance_name',
                'compliance_status',row_data->>'calculated_status','registration_number',row_data->>'registration_number',
                'expiration_date',row_data->>'expiration_date','days_until_expiration',row_data->>'days_remaining');
        END IF;
    END IF;
    IF jsonb_array_length(policies)>0 THEN
        IF NOT communication_actor_allowed(p_actor,'insurance','view') THEN
            RAISE EXCEPTION 'Insurance View permission required' USING ERRCODE='42501';
        END IF;
        IF jsonb_array_length(policies)=1 AND jsonb_array_length(records)=0 THEN
            SELECT to_jsonb(p) INTO row_data FROM mycoi_policies p WHERE id=(policies->>0)::integer;
            IF row_data IS NULL OR jsonb_array_length(contractor_ids)<>1
                OR row_data->>'contractor_id' IS DISTINCT FROM contractor_ids->>0 THEN
                RAISE EXCEPTION 'Select the contractor that owns the exact imported policy' USING ERRCODE='22023';
            END IF;
            values:=values||jsonb_build_object('compliance_type',row_data->>'policy_line',
                'expiration_date',row_data->>'expiration_date',
                'days_until_expiration',((row_data->>'expiration_date')::date-current_date)::text);
        END IF;
    END IF;
    IF jsonb_array_length(project_ids)>0 AND NOT communication_actor_allowed(p_actor,'projects','view') THEN
        RAISE EXCEPTION 'Projects View permission required' USING ERRCODE='42501';
    END IF;
    IF jsonb_array_length(project_ids)=1 THEN
        SELECT jsonb_build_object('project_number',project_number,'project_name',project_name) INTO row_data
            FROM public.projects WHERE id=(project_ids->>0)::integer;
        IF row_data IS NULL THEN RAISE EXCEPTION 'Selected project is unavailable' USING ERRCODE='22023'; END IF;
        values:=values||row_data;
    END IF;
    IF jsonb_array_length(recipients)=1 THEN
        recipient:=recipients->0; row_data:=NULL;
        IF recipient->>'recipient_type'='contractor_contact' THEN
            IF NOT communication_actor_allowed(p_actor,'contractors','view') THEN
                RAISE EXCEPTION 'Contractors View permission required' USING ERRCODE='42501';
            END IF;
            SELECT to_jsonb(c) INTO row_data FROM contractor_contacts c
                WHERE id=(recipient->>'contractor_contact_id')::uuid
                    AND contractor_ids @> jsonb_build_array(c.contractor_id);
            IF row_data IS NULL THEN RAISE EXCEPTION 'Selected contractor contact is unavailable or belongs to another contractor' USING ERRCODE='22023'; END IF;
        ELSIF recipient->>'recipient_type'='dobco_contact' THEN
            IF NOT communication_actor_allowed(p_actor,'settings','view') THEN
                RAISE EXCEPTION 'Settings View permission required' USING ERRCODE='42501';
            END IF;
            SELECT to_jsonb(c) INTO row_data FROM dobco_contacts c WHERE id=(recipient->>'dobco_contact_id')::uuid;
            IF row_data IS NULL THEN RAISE EXCEPTION 'Selected Dobco contact is unavailable' USING ERRCODE='22023'; END IF;
        END IF;
        IF row_data IS NOT NULL THEN
            IF lower(row_data->>'email') IS DISTINCT FROM lower(recipient->>'email') THEN
                RAISE EXCEPTION 'Contact address changed; select the contact again' USING ERRCODE='40001';
            END IF;
            values:=values||jsonb_build_object('contact_name',row_data->>'contact_name','contact_email',row_data->>'email',
                'contact_mobile',row_data->>'mobile_phone','contact_first_name',row_data->>'first_name');
        ELSE
            -- External addresses have no authoritative name fields.
            values:=values||jsonb_build_object('contact_email',recipient->>'email');
        END IF;
    END IF;
    IF nullif(p_input->>'template_id','') IS NOT NULL THEN
        SELECT * INTO template FROM communication_templates WHERE id=(p_input->>'template_id')::uuid;
        IF NOT FOUND OR (p_input ? 'template_revision' AND template.revision IS DISTINCT FROM (p_input->>'template_revision')::integer) THEN
            RAISE EXCEPTION 'Template changed; reload before rendering' USING ERRCODE='40001';
        END IF;
    END IF;
    RETURN jsonb_build_object('values',values,'template',CASE WHEN template.id IS NULL THEN NULL ELSE to_jsonb(template) END);
END $$;

ALTER FUNCTION public.save_communication_draft(UUID,UUID,JSONB) RENAME TO save_communication_draft_before_actions;
REVOKE ALL ON FUNCTION public.save_communication_draft_before_actions(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_draft(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result UUID; previous communication_messages; resolved JSONB; snapshot JSONB; saved communication_messages;
BEGIN
    IF p_id IS NOT NULL THEN SELECT * INTO previous FROM communication_messages WHERE id=p_id FOR UPDATE; END IF;
    result:=save_communication_draft_before_actions(p_actor,p_id,p_input);
    SELECT * INTO saved FROM communication_messages WHERE id=result;
    -- Legacy drafts without a reviewed template revision cannot acquire new post-send actions.
    IF saved.template_revision IS NOT NULL AND saved.channel='email' THEN
        IF previous.template_id IS NOT DISTINCT FROM saved.template_id AND previous.template_revision=saved.template_revision
            AND previous.context_snapshot ? 'template_render' THEN
            resolved:=communication_template_context(p_actor,p_input-ARRAY['template_id','template_revision']);
            resolved:=jsonb_set(resolved,'{template}',previous.context_snapshot->'template_render'->'template');
        ELSE
            resolved:=communication_template_context(p_actor,p_input);
        END IF;
        snapshot:=jsonb_build_object('template',resolved->'template','values',resolved->'values',
            'contractor_id',CASE WHEN jsonb_array_length(p_input->'contractor_ids')=1 THEN p_input->'contractor_ids'->0 END,
            'compliance_record_id',CASE WHEN jsonb_array_length(p_input->'compliance_record_ids')=1 THEN p_input->'compliance_record_ids'->0 END,
            'recipients',p_input->'recipients');
        UPDATE communication_messages SET context_snapshot=jsonb_set(context_snapshot,'{template_render}',snapshot) WHERE id=result;
    END IF;
    RETURN result;
END $$;

CREATE TABLE public.communication_followup_actions (
    message_id UUID PRIMARY KEY REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    compliance_record_id INTEGER REFERENCES public.compliance_records(id) ON DELETE RESTRICT,
    snapshot JSONB NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN('pending','recoverable','completed')),
    followup_id INTEGER UNIQUE REFERENCES public.contractor_followups(id) ON DELETE RESTRICT,
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK((state='completed')=(followup_id IS NOT NULL))
);
ALTER TABLE public.communication_followup_actions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.communication_followup_actions FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.communication_followup_actions TO service_role;
CREATE INDEX communication_followup_actions_pending ON public.communication_followup_actions(updated_at,message_id) WHERE state<>'completed';
ALTER TABLE public.contractor_followups ADD COLUMN origin_communication_id UUID UNIQUE
    REFERENCES public.communication_messages(id) ON DELETE RESTRICT;

CREATE FUNCTION public.guard_generated_communication_followup() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE parent communication_messages; message UUID;
BEGIN
    message:=CASE WHEN TG_OP='DELETE' THEN OLD.message_id ELSE NEW.message_id END;
    SELECT * INTO parent FROM communication_messages WHERE id=message FOR UPDATE;
    IF TG_OP='UPDATE' AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
        RAISE EXCEPTION 'Communication relationship identity is immutable' USING ERRCODE='23514';
    END IF;
    IF parent.status<>'Draft' AND NOT (TG_OP='INSERT' AND parent.status='Sent' AND EXISTS(
        SELECT 1 FROM communication_followup_actions a JOIN contractor_followups f ON f.id=a.followup_id
        WHERE a.message_id=message AND a.followup_id=NEW.followup_id AND a.state='completed'
            AND f.origin_communication_id=message AND f.contractor_id=a.contractor_id
            AND f.compliance_record_id IS NOT DISTINCT FROM a.compliance_record_id)) THEN
        RAISE EXCEPTION 'Frozen communication relationships cannot be rewritten' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
DROP TRIGGER communication_history_guard ON public.communication_followups;
CREATE TRIGGER communication_history_guard BEFORE INSERT OR UPDATE OR DELETE ON public.communication_followups
    FOR EACH ROW EXECUTE FUNCTION public.guard_generated_communication_followup();
REVOKE ALL ON FUNCTION public.guard_generated_communication_followup() FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.complete_reserved_communication_email(UUID,UUID,TEXT) RENAME TO complete_reserved_communication_email_before_actions;
REVOKE ALL ON FUNCTION public.complete_reserved_communication_email_before_actions(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.complete_reserved_communication_email(p_actor UUID,p_message_id UUID,p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m communication_messages; config JSONB; context JSONB;
BEGIN
    PERFORM complete_reserved_communication_email_before_actions(p_actor,p_message_id,p_outcome);
    IF p_outcome<>'accepted' THEN RETURN; END IF;
    SELECT * INTO m FROM communication_messages WHERE id=p_message_id;
    context:=m.context_snapshot->'template_render'; config:=context->'template';
    IF coalesce((config->>'followup_enabled')::boolean,false) THEN
        INSERT INTO communication_followup_actions(message_id,contractor_id,compliance_record_id,snapshot,accepted_at)
        VALUES(m.id,(context->>'contractor_id')::integer,
            CASE WHEN config->>'followup_related_item'='originating_compliance_record' THEN (context->>'compliance_record_id')::integer END,
            context,m.sent_at) ON CONFLICT(message_id) DO NOTHING;
    END IF;
END $$;

CREATE FUNCTION public.process_communication_followup(p_message UUID,p_subject TEXT,p_error TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE action communication_followup_actions; result INTEGER; reason TEXT;
BEGIN
    SELECT * INTO action FROM communication_followup_actions WHERE message_id=p_message FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('state','not_configured'); END IF;
    IF action.state='completed' THEN RETURN jsonb_build_object('state','completed','followup_id',action.followup_id); END IF;
    IF NOT EXISTS(SELECT 1 FROM communication_messages WHERE id=p_message AND status='Sent' AND sent_at=action.accepted_at) THEN
        RAISE EXCEPTION 'Accepted communication required for Follow-Up processing' USING ERRCODE='22023';
    END IF;
    BEGIN
        IF p_error IS NOT NULL THEN RAISE EXCEPTION '%',p_error USING ERRCODE='22023'; END IF;
        IF nullif(btrim(p_subject),'') IS NULL OR length(p_subject)>200
            OR p_subject ~ '\{\{|\}\}' OR p_subject ~* '\[(Company Name|Compliance Type|Registration Number|Expiration Date|Contact First Name)\]' THEN
            RAISE EXCEPTION 'Follow-Up subject is unavailable or unresolved' USING ERRCODE='22023';
        END IF;
        INSERT INTO contractor_followups(contractor_id,compliance_record_id,followup_date,followup_method,subject,status,origin_communication_id)
        VALUES(action.contractor_id,action.compliance_record_id,
            (action.accepted_at AT TIME ZONE 'America/New_York')::date+(action.snapshot->'template'->>'followup_delay_days')::integer,
            'Email',p_subject,action.snapshot->'template'->>'followup_status',action.message_id)
        RETURNING id INTO result;
        UPDATE communication_followup_actions SET state='completed',followup_id=result,attempts=attempts+1,
            last_error=NULL,updated_at=now() WHERE message_id=p_message;
        INSERT INTO communication_followups(message_id,followup_id) VALUES(p_message,result);
    EXCEPTION WHEN OTHERS THEN
        -- Provider acceptance is already committed. Persist a visible retryable action, never roll it back or resend.
        GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
        UPDATE communication_followup_actions SET state='recoverable',attempts=attempts+1,
            last_error=left(reason,1000),updated_at=now() WHERE message_id=p_message;
    END;
    SELECT * INTO action FROM communication_followup_actions WHERE message_id=p_message;
    RETURN jsonb_build_object('state',action.state,'followup_id',action.followup_id,'error',action.last_error);
END $$;

CREATE FUNCTION public.assert_communication_rendered(p_message UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m communication_messages; text_value TEXT; context JSONB; config JSONB;
BEGIN
    SELECT * INTO m FROM communication_messages WHERE id=p_message FOR UPDATE;
    FOREACH text_value IN ARRAY ARRAY[m.subject,m.body] LOOP
        IF text_value ~ '\{\{|\}\}' OR text_value ~* '\[(Company Name|Compliance Type|Registration Number|Expiration Date|Contact First Name)\]' THEN
            RAISE EXCEPTION 'Cannot send or schedule: unresolved merge field in Subject or Body; save fully rendered content' USING ERRCODE='22023';
        END IF;
    END LOOP;
    context:=m.context_snapshot->'template_render'; config:=context->'template';
    IF coalesce((config->>'followup_enabled')::boolean,false) THEN
        IF context->>'contractor_id' IS NULL OR
            (config->>'followup_related_item'='originating_compliance_record' AND context->>'compliance_record_id' IS NULL) THEN
            RAISE EXCEPTION 'Configured Follow-Up requires one authoritative contractor and originating compliance record' USING ERRCODE='22023';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM communication_contractors WHERE message_id=m.id AND contractor_id=(context->>'contractor_id')::integer)
            OR (context->>'compliance_record_id' IS NOT NULL AND NOT EXISTS
                (SELECT 1 FROM communication_compliance_items WHERE message_id=m.id AND compliance_record_id=(context->>'compliance_record_id')::integer)) THEN
            RAISE EXCEPTION 'Reviewed Follow-Up context changed; render a new draft' USING ERRCODE='40001';
        END IF;
    END IF;
END $$;
ALTER FUNCTION public.plan_communication(UUID,UUID,INTEGER,TEXT,TIMESTAMPTZ) RENAME TO plan_communication_before_actions;
REVOKE ALL ON FUNCTION public.plan_communication_before_actions(UUID,UUID,INTEGER,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.plan_communication(p_actor UUID,p_message UUID,p_revision INTEGER,p_action TEXT,p_scheduled_at TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF NOT communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    IF p_action='schedule' THEN PERFORM assert_communication_rendered(p_message); END IF;
    PERFORM plan_communication_before_actions(p_actor,p_message,p_revision,p_action,p_scheduled_at);
END $$;
-- All manual and scheduled reservations converge on this existing protected primitive.
ALTER FUNCTION public.reserve_communication_email_state(UUID,UUID,INTEGER,TEXT) RENAME TO reserve_communication_email_state_before_actions;
REVOKE ALL ON FUNCTION public.reserve_communication_email_state_before_actions(UUID,UUID,INTEGER,TEXT) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.reserve_communication_email_state(p_actor UUID,p_message_id UUID,p_settings_revision INTEGER,p_status TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    PERFORM assert_communication_rendered(p_message_id);
    RETURN reserve_communication_email_state_before_actions(p_actor,p_message_id,p_settings_revision,p_status);
END $$;

DO $$
DECLARE signature TEXT;
BEGIN
    FOREACH signature IN ARRAY ARRAY[
        'save_communication_template(uuid,uuid,jsonb)','communication_template_context(uuid,jsonb)',
        'save_communication_draft(uuid,uuid,jsonb)','process_communication_followup(uuid,text,text)',
        'plan_communication(uuid,uuid,integer,text,timestamptz)'] LOOP
        EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC,anon,authenticated';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO service_role';
    END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.complete_reserved_communication_email(UUID,UUID,TEXT),
    public.assert_communication_rendered(UUID),public.reserve_communication_email_state(UUID,UUID,INTEGER,TEXT)
    FROM PUBLIC,anon,authenticated,service_role;

-- Register the new contractor FK with the existing merge dependency checks; preserve original accepted-message context.
DO $$
DECLARE definition TEXT; signature TEXT; fragment TEXT;
BEGIN
    IF to_regprocedure('public.company_merge_snapshot(integer,integer)') IS NULL THEN RETURN; END IF;
    FOREACH signature IN ARRAY ARRAY['public.company_merge_snapshot(integer,integer)',
        'public.company_merge_preview(integer,integer,uuid)'] LOOP
        definition:=pg_get_functiondef(signature::regprocedure);
        fragment:=$part$'requirement_notice_communications',$part$;
        IF length(definition)-length(replace(definition,fragment,''))<>length(fragment) THEN
            RAISE EXCEPTION 'Company Merge dependency list differs from the verified definition';
        END IF;
        EXECUTE replace(definition,fragment,fragment||$part$'communication_followup_actions',$part$);
    END LOOP;
    signature:='public.company_merge_execute(integer,integer,text,jsonb,jsonb,uuid,uuid,boolean,uuid)';
    definition:=pg_get_functiondef(signature::regprocedure);
    fragment:='public.requirement_notice_communications,public.requirement_notice_delivery_outcomes,';
    IF length(definition)-length(replace(definition,fragment,''))<>length(fragment) THEN
        RAISE EXCEPTION 'Company Merge lock list differs from the verified definition';
    END IF;
    definition:=replace(definition,fragment,fragment||'public.communication_followup_actions,');
    fragment:='UPDATE mycoi_vendor_mappings SET active=false,updated_at=now() WHERE contractor_id IN(p_primary,p_secondary) AND active;';
    IF length(definition)-length(replace(definition,fragment,''))<>length(fragment) THEN
        RAISE EXCEPTION 'Company Merge preservation section differs from the verified definition';
    END IF;
    EXECUTE replace(definition,fragment,$part$
        UPDATE company_merge_lineage SET after_row=before_row||jsonb_build_object('preserved_on_predecessor',true)
            WHERE merge_id=p_operation AND category='communication_followup_actions';
    $part$||fragment);
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
