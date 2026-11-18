-- Upgrades the existing template-only actions to reviewed per-message choices.
-- No settings, templates, messages, delivery rules or verification rows are changed.
BEGIN;

CREATE FUNCTION public.communication_followup_configuration(p_input JSONB,p_template JSONB)
RETURNS JSONB LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE config JSONB;
BEGIN
    config:=coalesce(p_input,jsonb_build_object('enabled',coalesce((p_template->>'followup_enabled')::boolean,false),
        'status',coalesce(p_template->>'followup_status','Open'),'timing','relative',
        'delay_days',coalesce((p_template->>'followup_delay_days')::integer,30),'date',NULL,
        'subject',coalesce(p_template->>'followup_subject','')));
    IF jsonb_typeof(config)<>'object'
        OR NOT config ?& ARRAY['enabled','status','timing','delay_days','date','subject']
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(config) k WHERE k NOT IN('enabled','status','timing','delay_days','date','subject'))
        OR jsonb_typeof(config->'enabled')<>'boolean'
        OR jsonb_typeof(config->'status')<>'string' OR config->>'status' NOT IN('Open','Waiting Response','Resolved','Closed')
        OR jsonb_typeof(config->'timing')<>'string' OR config->>'timing' NOT IN('relative','specific_date')
        OR jsonb_typeof(config->'delay_days')<>'number' OR config->>'delay_days' !~ '^[0-9]{1,5}$'
        OR (config->>'delay_days')::integer>36500
        OR jsonb_typeof(config->'subject')<>'string' OR length(config->>'subject')>200
        OR (config->'date'<>'null'::jsonb AND (jsonb_typeof(config->'date')<>'string' OR config->>'date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
        OR ((config->>'enabled')::boolean AND (nullif(btrim(config->>'subject'),'') IS NULL
            OR (config->>'timing'='specific_date' AND config->'date'='null'::jsonb))) THEN
        RAISE EXCEPTION 'Invalid message Follow-Up configuration' USING ERRCODE='22023';
    END IF;
    IF config->'date'<>'null'::jsonb THEN
        IF to_char((config->>'date')::date,'YYYY-MM-DD')<>config->>'date' THEN
            RAISE EXCEPTION 'Invalid Follow-Up date' USING ERRCODE='22023';
        END IF;
    END IF;
    RETURN config;
END $$;
REVOKE ALL ON FUNCTION public.communication_followup_configuration(JSONB,JSONB) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.communication_template_context(UUID,JSONB) RENAME TO communication_template_context_before_message_followup;
REVOKE ALL ON FUNCTION public.communication_template_context_before_message_followup(UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.communication_template_context(p_actor UUID,p_input JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE resolved JSONB; config JSONB;
BEGIN
    resolved:=communication_template_context_before_message_followup(p_actor,p_input-'followup');
    config:=communication_followup_configuration(p_input->'followup',resolved->'template');
    IF (config->>'enabled')::boolean
        AND (jsonb_array_length(coalesce(p_input->'contractor_ids','[]'))<>1
            OR jsonb_array_length(coalesce(p_input->'compliance_record_ids','[]'))>1) THEN
        RAISE EXCEPTION 'Follow-Up requires one authoritative contractor and at most one exact compliance record; Project-only Follow-Ups are unsupported' USING ERRCODE='22023';
    END IF;
    RETURN resolved||jsonb_build_object('followup',config);
END $$;
REVOKE ALL ON FUNCTION public.communication_template_context(UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.communication_template_context(UUID,JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.save_communication_draft(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result UUID; previous communication_messages; resolved JSONB; snapshot JSONB; saved communication_messages; config JSONB;
BEGIN
    IF p_id IS NOT NULL THEN SELECT * INTO previous FROM communication_messages WHERE id=p_id FOR UPDATE; END IF;
    IF p_input ? 'followup' AND p_input->>'channel'<>'email' THEN
        RAISE EXCEPTION 'Post-send Follow-Up options require Email' USING ERRCODE='22023';
    END IF;
    result:=save_communication_draft_before_actions(p_actor,p_id,p_input-'followup');
    SELECT * INTO saved FROM communication_messages WHERE id=result;
    IF saved.channel='email' THEN
        IF previous.template_id IS NOT DISTINCT FROM saved.template_id AND previous.template_revision=saved.template_revision
            AND previous.context_snapshot ? 'template_render' THEN
            resolved:=communication_template_context_before_message_followup(p_actor,p_input-ARRAY['template_id','template_revision','followup']);
            resolved:=jsonb_set(resolved,'{template}',previous.context_snapshot->'template_render'->'template');
        ELSE
            resolved:=communication_template_context_before_message_followup(p_actor,p_input-'followup');
        END IF;
        config:=p_input->'followup';
        IF NOT p_input ? 'followup' AND previous.template_id IS NOT DISTINCT FROM saved.template_id THEN
            config:=previous.context_snapshot->'template_render'->'followup';
        END IF;
        config:=communication_followup_configuration(config,resolved->'template');
        IF (config->>'enabled')::boolean
            AND (jsonb_array_length(p_input->'contractor_ids')<>1 OR jsonb_array_length(p_input->'compliance_record_ids')>1) THEN
            RAISE EXCEPTION 'Follow-Up requires one authoritative contractor and at most one exact compliance record; Project-only Follow-Ups are unsupported' USING ERRCODE='22023';
        END IF;
        snapshot:=jsonb_build_object('template',resolved->'template','values',resolved->'values','followup',config,
            'contractor_id',CASE WHEN jsonb_array_length(p_input->'contractor_ids')=1 THEN p_input->'contractor_ids'->0 END,
            'compliance_record_id',CASE WHEN jsonb_array_length(p_input->'compliance_record_ids')=1 THEN p_input->'compliance_record_ids'->0 END,
            'project_ids',p_input->'project_ids','projects',saved.context_snapshot->'projects','recipients',p_input->'recipients');
        UPDATE communication_messages SET context_snapshot=jsonb_set(context_snapshot,'{template_render}',snapshot) WHERE id=result;
    END IF;
    RETURN result;
END $$;

CREATE OR REPLACE FUNCTION public.complete_reserved_communication_email(p_actor UUID,p_message_id UUID,p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m communication_messages; config JSONB; context JSONB;
BEGIN
    PERFORM complete_reserved_communication_email_before_actions(p_actor,p_message_id,p_outcome);
    IF p_outcome<>'accepted' THEN RETURN; END IF;
    SELECT * INTO m FROM communication_messages WHERE id=p_message_id;
    context:=m.context_snapshot->'template_render';
    config:=communication_followup_configuration(context->'followup',context->'template');
    IF (config->>'enabled')::boolean THEN
        INSERT INTO communication_followup_actions(message_id,contractor_id,compliance_record_id,snapshot,accepted_at)
        VALUES(m.id,(context->>'contractor_id')::integer,
            CASE WHEN context ? 'followup' OR context->'template'->>'followup_related_item'='originating_compliance_record'
                THEN (context->>'compliance_record_id')::integer END,
            context,m.sent_at) ON CONFLICT(message_id) DO NOTHING;
    END IF;
END $$;

CREATE OR REPLACE FUNCTION public.process_communication_followup(p_message UUID,p_subject TEXT,p_error TEXT DEFAULT NULL)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE action communication_followup_actions; result INTEGER; reason TEXT; config JSONB;
BEGIN
    SELECT * INTO action FROM communication_followup_actions WHERE message_id=p_message FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('state','not_configured'); END IF;
    IF action.state='completed' THEN RETURN jsonb_build_object('state','completed','followup_id',action.followup_id); END IF;
    IF NOT EXISTS(SELECT 1 FROM communication_messages WHERE id=p_message AND status='Sent' AND sent_at=action.accepted_at) THEN
        RAISE EXCEPTION 'Accepted communication required for Follow-Up processing' USING ERRCODE='22023';
    END IF;
    BEGIN
        IF p_error IS NOT NULL THEN RAISE EXCEPTION '%',p_error USING ERRCODE='22023'; END IF;
        config:=communication_followup_configuration(action.snapshot->'followup',action.snapshot->'template');
        IF NOT (config->>'enabled')::boolean THEN
            RAISE EXCEPTION 'Reviewed Follow-Up is not enabled' USING ERRCODE='22023';
        END IF;
        IF nullif(btrim(p_subject),'') IS NULL OR length(p_subject)>200
            OR p_subject ~ '\{\{|\}\}' OR p_subject ~* '\[(Company Name|Compliance Type|Registration Number|Expiration Date|Contact First Name)\]' THEN
            RAISE EXCEPTION 'Follow-Up subject is unavailable or unresolved' USING ERRCODE='22023';
        END IF;
        INSERT INTO contractor_followups(contractor_id,compliance_record_id,followup_date,followup_method,subject,status,origin_communication_id,notes)
        VALUES(action.contractor_id,action.compliance_record_id,
            CASE WHEN config->>'timing'='specific_date' THEN (config->>'date')::date
                ELSE (action.accepted_at AT TIME ZONE 'America/New_York')::date+(config->>'delay_days')::integer END,
            'Email',p_subject,config->>'status',action.message_id,
            CASE WHEN jsonb_array_length(coalesce(action.snapshot->'project_ids','[]'))>0 THEN
                'Project context retained on originating communication '||action.message_id::text||': '||coalesce(action.snapshot->>'projects',action.snapshot->>'project_ids') END)
        RETURNING id INTO result;
        UPDATE communication_followup_actions SET state='completed',followup_id=result,attempts=attempts+1,
            last_error=NULL,updated_at=now() WHERE message_id=p_message;
        INSERT INTO communication_followups(message_id,followup_id) VALUES(p_message,result);
    EXCEPTION WHEN OTHERS THEN
        -- Acceptance is committed. Persist the action error; recovery never resends.
        GET STACKED DIAGNOSTICS reason=MESSAGE_TEXT;
        UPDATE communication_followup_actions SET state='recoverable',attempts=attempts+1,
            last_error=left(reason,1000),updated_at=now() WHERE message_id=p_message;
    END;
    SELECT * INTO action FROM communication_followup_actions WHERE message_id=p_message;
    RETURN jsonb_build_object('state',action.state,'followup_id',action.followup_id,'error',action.last_error);
END $$;

CREATE OR REPLACE FUNCTION public.assert_communication_rendered(p_message UUID) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m communication_messages; text_value TEXT; context JSONB; config JSONB;
BEGIN
    SELECT * INTO m FROM communication_messages WHERE id=p_message FOR UPDATE;
    FOREACH text_value IN ARRAY ARRAY[m.subject,m.body] LOOP
        IF text_value ~ '\{\{|\}\}' OR text_value ~* '\[(Company Name|Compliance Type|Registration Number|Expiration Date|Contact First Name)\]' THEN
            RAISE EXCEPTION 'Cannot send or schedule: unresolved merge field in Subject or Body; save fully rendered content' USING ERRCODE='22023';
        END IF;
    END LOOP;
    context:=m.context_snapshot->'template_render';
    config:=communication_followup_configuration(context->'followup',context->'template');
    IF (config->>'enabled')::boolean THEN
        IF context->>'contractor_id' IS NULL OR
            (NOT context ? 'followup' AND context->'template'->>'followup_related_item'='originating_compliance_record'
                AND context->>'compliance_record_id' IS NULL) THEN
            RAISE EXCEPTION 'Configured Follow-Up requires authoritative contractor/record context' USING ERRCODE='22023';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM communication_contractors WHERE message_id=m.id AND contractor_id=(context->>'contractor_id')::integer)
            OR (context->>'compliance_record_id' IS NOT NULL AND NOT EXISTS
                (SELECT 1 FROM communication_compliance_items WHERE message_id=m.id AND compliance_record_id=(context->>'compliance_record_id')::integer)) THEN
            RAISE EXCEPTION 'Reviewed Follow-Up context changed; render a new draft' USING ERRCODE='40001';
        END IF;
    END IF;
END $$;

NOTIFY pgrst,'reload schema';
COMMIT;
