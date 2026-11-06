-- Proposed Email Communications 1B. No delivery, automation or production backfill.
BEGIN;

ALTER TABLE public.communication_messages
    DROP CONSTRAINT communication_messages_status_check,
    ADD CONSTRAINT communication_messages_status_check CHECK
        (status IN('Draft','Scheduled','Queued','Sending','Sent','Delivered','Failed','Cancelled','Skipped')),
    ADD COLUMN communication_type TEXT NOT NULL DEFAULT 'General Contractor Communication'
        CHECK(communication_type IN('Expiration Reminder','Out of Compliance','Compliance Restored','General Contractor Communication','Internal Alert')),
    ADD COLUMN scheduled_at TIMESTAMPTZ,
    ADD COLUMN template_revision INTEGER CHECK(template_revision>0),
    ADD COLUMN context_snapshot JSONB CHECK(context_snapshot IS NULL OR jsonb_typeof(context_snapshot)='object'),
    ADD CONSTRAINT communication_schedule_required CHECK(status<>'Scheduled' OR scheduled_at IS NOT NULL);
ALTER TABLE public.communication_recipients DROP CONSTRAINT communication_recipients_status_check,
    ADD CONSTRAINT communication_recipients_status_check CHECK
        (status IN('Draft','Scheduled','Queued','Sending','Sent','Delivered','Failed','Cancelled','Skipped'));
CREATE INDEX communication_messages_schedule ON public.communication_messages(scheduled_at,id) WHERE status='Scheduled';

CREATE TABLE public.communication_followups (
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    followup_id INTEGER NOT NULL REFERENCES public.contractor_followups(id) ON DELETE RESTRICT,
    PRIMARY KEY(message_id,followup_id)
);
CREATE INDEX communication_followups_lookup ON public.communication_followups(followup_id);
CREATE TABLE public.communication_requirements (
    message_id UUID NOT NULL REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    compliance_type_id INTEGER NOT NULL REFERENCES public.compliance_types(id) ON DELETE RESTRICT,
    PRIMARY KEY(message_id,compliance_type_id)
);
CREATE INDEX communication_requirements_lookup ON public.communication_requirements(compliance_type_id);
ALTER TABLE public.communication_followups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.communication_requirements ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.communication_followups,public.communication_requirements FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.communication_followups,public.communication_requirements TO service_role;

CREATE FUNCTION public.communication_context_snapshot(p_message UUID) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    SELECT jsonb_build_object(
        'captured_at',m.updated_at,
        'created_by',jsonb_build_object('id',u.auth_user_id,'name',u.name),
        'contractors',coalesce((SELECT jsonb_agg(jsonb_build_object('contractor_id',c.id,'company_name',c.company_name,
            'dba_name',c.dba_name) ORDER BY c.id) FROM communication_contractors l JOIN contractors c ON c.id=l.contractor_id WHERE l.message_id=m.id),'[]'),
        'projects',coalesce((SELECT jsonb_agg(jsonb_build_object('project_id',p.id,'project_number',p.project_number,
            'project_name',p.project_name) ORDER BY p.id) FROM communication_projects l JOIN projects p ON p.id=l.project_id WHERE l.message_id=m.id),'[]'),
        'compliance',coalesce((SELECT jsonb_agg(jsonb_build_object('id',r.id,'contractor_id',r.contractor_id,
            'compliance_type_id',r.compliance_type_id,'registration_number',r.registration_number,'expiration_date',r.expiration_date)
            ORDER BY r.id) FROM communication_compliance_items l JOIN compliance_records r ON r.id=l.compliance_record_id WHERE l.message_id=m.id),'[]'),
        'requirements',coalesce((SELECT jsonb_agg(jsonb_build_object('id',t.id,'name',t.compliance_name) ORDER BY t.id)
            FROM communication_requirements l JOIN compliance_types t ON t.id=l.compliance_type_id WHERE l.message_id=m.id),'[]'),
        'insurance',coalesce((SELECT jsonb_agg(jsonb_build_object('contractor_id',l.contractor_id,'item_key',l.item_key)
            ORDER BY l.contractor_id,l.item_key)
            FROM communication_insurance_items l WHERE l.message_id=m.id),'[]'),
        'mycoi',coalesce((SELECT jsonb_agg(jsonb_build_object('id',p.id,'contractor_id',p.contractor_id,
            'policy_line',p.policy_line,'policy_number',p.policy_number,'expiration_date',p.expiration_date) ORDER BY p.id)
            FROM communication_mycoi_items l JOIN mycoi_policies p ON p.id=l.policy_id WHERE l.message_id=m.id),'[]'),
        'followups',coalesce((SELECT jsonb_agg(jsonb_build_object('id',f.id,'contractor_id',f.contractor_id,
            'subject',f.subject,'status',f.status,'followup_date',f.followup_date,'compliance_record_id',f.compliance_record_id,
            'compliance_type_id',f.compliance_type_id,'insurance_item_key',f.insurance_item_key) ORDER BY f.id)
            FROM communication_followups l JOIN contractor_followups f ON f.id=l.followup_id WHERE l.message_id=m.id),'[]'),
        'template',CASE WHEN t.id IS NOT NULL THEN jsonb_build_object('id',t.id,'name',t.name,
            'revision',t.revision,'subject',t.subject,'body',t.body) END)
    FROM communication_messages m LEFT JOIN user_profiles u ON u.auth_user_id=m.created_by
    LEFT JOIN communication_templates t ON t.id=m.template_id WHERE m.id=p_message;
$$;
REVOKE ALL ON FUNCTION public.communication_context_snapshot(UUID) FROM PUBLIC,anon,authenticated,service_role;

ALTER FUNCTION public.save_communication_draft(UUID,UUID,JSONB) RENAME TO save_communication_draft_compose;
REVOKE ALL ON FUNCTION public.save_communication_draft_compose(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_draft(p_actor UUID,p_id UUID,p_input JSONB) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result_id UUID; existing communication_messages; followups JSONB; requirements JSONB;
    f contractor_followups; item JSONB; kind TEXT; template communication_templates; preserve_template BOOLEAN;
BEGIN
    IF NOT communication_actor_allowed(p_actor,'communications_content',CASE WHEN p_id IS NULL THEN 'add' ELSE 'edit' END) THEN
        RAISE EXCEPTION 'Communications Content mutation permission required' USING ERRCODE='42501';
    END IF;
    IF p_input IS NULL OR jsonb_typeof(p_input)<>'object' THEN
        RAISE EXCEPTION 'Invalid draft input' USING ERRCODE='22023';
    END IF;
    IF p_id IS NOT NULL THEN
        SELECT * INTO existing FROM communication_messages WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Communication not found' USING ERRCODE='P0002'; END IF;
        IF existing.status<>'Draft' THEN RAISE EXCEPTION 'Only Draft communications can be edited' USING ERRCODE='22023'; END IF;
    END IF;
    followups:=coalesce(p_input->'followup_ids',(SELECT jsonb_agg(followup_id) FROM communication_followups WHERE message_id=p_id),'[]');
    requirements:=coalesce(p_input->'compliance_type_ids',(SELECT jsonb_agg(compliance_type_id) FROM communication_requirements WHERE message_id=p_id),'[]');
    FOREACH item IN ARRAY ARRAY[followups,requirements] LOOP
        IF jsonb_typeof(item)<>'array' OR jsonb_array_length(item)>100
            OR EXISTS(SELECT 1 FROM jsonb_array_elements(item) v WHERE jsonb_typeof(v)<>'number' OR v::text !~ '^[1-9][0-9]*$')
            OR (SELECT count(*)<>count(DISTINCT v) FROM jsonb_array_elements(item) v) THEN
            RAISE EXCEPTION 'Expected bounded unique relationship IDs' USING ERRCODE='22023';
        END IF;
    END LOOP;
    IF jsonb_array_length(followups)>0 AND NOT communication_actor_allowed(p_actor,'followups','view') THEN
        RAISE EXCEPTION 'Follow-Ups View permission required' USING ERRCODE='42501';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(followups) LOOP
        SELECT * INTO f FROM contractor_followups WHERE id=item::text::integer FOR SHARE;
        IF NOT FOUND OR NOT coalesce(p_input->'contractor_ids' @> jsonb_build_array(f.contractor_id),false) THEN
            RAISE EXCEPTION 'Follow-Up must belong to a linked contractor' USING ERRCODE='22023';
        END IF;
        IF f.compliance_record_id IS NOT NULL THEN
            IF NOT EXISTS(SELECT 1 FROM compliance_records r WHERE r.id=f.compliance_record_id AND r.contractor_id=f.contractor_id
                AND (f.compliance_type_id IS NULL OR r.compliance_type_id=f.compliance_type_id)) THEN
                RAISE EXCEPTION 'Follow-Up record and contractor/requirement disagree' USING ERRCODE='22023';
            END IF;
            p_input:=jsonb_set(p_input,'{compliance_record_ids}',
                (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(coalesce(p_input->'compliance_record_ids','[]')||jsonb_build_array(f.compliance_record_id)) v));
        END IF;
        IF f.compliance_type_id IS NOT NULL THEN
            SELECT jsonb_agg(DISTINCT v) INTO requirements FROM jsonb_array_elements(requirements||jsonb_build_array(f.compliance_type_id)) v;
        END IF;
        IF f.insurance_item_key IS NOT NULL THEN
            p_input:=jsonb_set(p_input,'{insurance_items}',
                (SELECT jsonb_agg(DISTINCT v) FROM jsonb_array_elements(coalesce(p_input->'insurance_items','[]')||
                    jsonb_build_array(jsonb_build_object('contractor_id',f.contractor_id,'item_key',f.insurance_item_key))) v));
        END IF;
    END LOOP;
    SELECT coalesce(jsonb_agg(DISTINCT value),'[]') INTO requirements FROM (
        SELECT value FROM jsonb_array_elements(requirements)
        UNION ALL SELECT to_jsonb(r.compliance_type_id) FROM compliance_records r
            WHERE coalesce(p_input->'compliance_record_ids','[]') @> jsonb_build_array(r.id)
    ) linked;
    IF jsonb_array_length(requirements)>0 AND NOT communication_actor_allowed(p_actor,'compliance','view') THEN
        RAISE EXCEPTION 'Compliance View permission required' USING ERRCODE='42501';
    END IF;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(requirements) i
        LEFT JOIN compliance_types t ON t.id=i::integer WHERE t.id IS NULL) THEN
        RAISE EXCEPTION 'Related requirement not found' USING ERRCODE='22023';
    END IF;
    SELECT * INTO template FROM communication_templates WHERE id=CASE WHEN p_input ? 'template_id'
        THEN (p_input->>'template_id')::uuid ELSE existing.template_id END FOR SHARE;
    preserve_template:=p_id IS NOT NULL AND existing.template_id IS NOT DISTINCT FROM template.id
        AND existing.template_revision IS NOT NULL AND
        (NOT p_input ? 'template_revision' OR existing.template_revision=(p_input->>'template_revision')::integer);
    IF p_input ? 'template_revision' AND NOT preserve_template AND (template.id IS NULL OR
        template.revision IS DISTINCT FROM (p_input->>'template_revision')::integer) THEN
        RAISE EXCEPTION 'Template changed; reload before rendering a new draft' USING ERRCODE='PT409';
    END IF;
    kind:=coalesce(p_input->>'communication_type',existing.communication_type,template.category,'General Contractor Communication');
    result_id:=save_communication_draft_compose(p_actor,p_id,p_input-ARRAY['followup_ids','compliance_type_ids','communication_type','template_revision']);
    DELETE FROM communication_followups WHERE message_id=result_id;
    DELETE FROM communication_requirements WHERE message_id=result_id;
    INSERT INTO communication_followups SELECT result_id,value::integer FROM jsonb_array_elements_text(followups);
    INSERT INTO communication_requirements SELECT result_id,value::integer FROM jsonb_array_elements_text(requirements);
    UPDATE communication_messages SET communication_type=kind,
        template_revision=CASE WHEN preserve_template THEN existing.template_revision
            WHEN p_input ? 'template_revision' THEN template.revision END WHERE id=result_id;
    UPDATE communication_messages SET context_snapshot=communication_context_snapshot(result_id) WHERE id=result_id;
    IF preserve_template THEN
        UPDATE communication_messages SET context_snapshot=jsonb_set(context_snapshot,'{template}',existing.context_snapshot->'template') WHERE id=result_id;
    ELSIF NOT p_input ? 'template_revision' THEN
        -- Older clients did not capture the version used to render their saved body.
        UPDATE communication_messages SET context_snapshot=jsonb_set(context_snapshot,'{template}','null'::jsonb) WHERE id=result_id;
    END IF;
    RETURN result_id;
END $$;
REVOKE ALL ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) TO service_role;

-- Lock the parent so relationship edits and scheduling/sending cannot race.
CREATE FUNCTION public.guard_communication_history() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE parent communication_messages; message UUID;
BEGIN
    IF TG_TABLE_NAME='communication_messages' THEN
        IF OLD.status='Draft' THEN
            IF TG_OP='UPDATE' AND NEW.status<>'Draft' AND NEW.context_snapshot IS NULL THEN
                -- A pre-1B Draft has no evidence of the template version used to render it.
                NEW.context_snapshot:=jsonb_set(communication_context_snapshot(OLD.id),'{template}','null'::jsonb);
                NEW.template_revision:=NULL;
            END IF;
            IF TG_OP='DELETE' THEN RETURN OLD; END IF;
            RETURN NEW;
        END IF;
        IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Communication history cannot be deleted' USING ERRCODE='23514'; END IF;
        IF (to_jsonb(NEW)-ARRAY['status','sent_by','queued_at','sent_at','delivered_at','failed_at','cancelled_at','failure_reason','provider_message_id','updated_at','revision'])
            IS DISTINCT FROM
            (to_jsonb(OLD)-ARRAY['status','sent_by','queued_at','sent_at','delivered_at','failed_at','cancelled_at','failure_reason','provider_message_id','updated_at','revision'])
            OR NEW.status='Draft' THEN
            RAISE EXCEPTION 'Frozen communication content and relationships cannot be rewritten' USING ERRCODE='23514';
        END IF;
        RETURN NEW;
    END IF;
    message:=CASE WHEN TG_OP='DELETE' THEN OLD.message_id ELSE NEW.message_id END;
    SELECT * INTO parent FROM communication_messages WHERE id=message FOR UPDATE;
    IF TG_OP='UPDATE' AND NEW.message_id IS DISTINCT FROM OLD.message_id THEN
        RAISE EXCEPTION 'Communication relationship identity is immutable' USING ERRCODE='23514';
    END IF;
    IF parent.status<>'Draft' THEN
        -- Existing provider reservation/completion may update delivery metadata only.
        IF TG_TABLE_NAME='communication_recipients' AND TG_OP='UPDATE' AND
            (to_jsonb(NEW)-ARRAY['status','provider_recipient_id','failure_reason','queued_at','sent_at','delivered_at','failed_at','cancelled_at'])
            IS NOT DISTINCT FROM
            (to_jsonb(OLD)-ARRAY['status','provider_recipient_id','failure_reason','queued_at','sent_at','delivered_at','failed_at','cancelled_at']) THEN
            RETURN NEW;
        END IF;
        -- Existing deliberately requested connection tests insert their recipient after Sending.
        IF TG_TABLE_NAME='communication_recipients' AND TG_OP='INSERT' AND parent.status='Sending'
            AND parent.source='manual' AND parent.channel='email' AND parent.provider='microsoft_365'
            AND parent.created_by=parent.sent_by AND parent.context_snapshot IS NULL
            AND NOT EXISTS(SELECT 1 FROM communication_recipients WHERE message_id=message) THEN RETURN NEW; END IF;
        RAISE EXCEPTION 'Frozen communication relationships cannot be rewritten' USING ERRCODE='23514';
    END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.guard_communication_history() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER communication_history_guard BEFORE UPDATE OR DELETE ON public.communication_messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_communication_history();
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['communication_recipients','communication_contractors','communication_projects',
        'communication_compliance_items','communication_mycoi_items','communication_insurance_items',
        'communication_followups','communication_requirements'] LOOP
        EXECUTE format('CREATE TRIGGER communication_history_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I
            FOR EACH ROW EXECUTE FUNCTION public.guard_communication_history()',t);
    END LOOP;
END $$;

CREATE FUNCTION public.plan_communication(p_actor UUID,p_message UUID,p_revision INTEGER,p_action TEXT,p_scheduled_at TIMESTAMPTZ DEFAULT NULL)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m communication_messages;
BEGIN
    IF NOT communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO m FROM communication_messages WHERE id=p_message FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Communication not found' USING ERRCODE='P0002'; END IF;
    IF m.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Communication changed; reload before planning' USING ERRCODE='PT409'; END IF;
    IF m.channel<>'email' OR m.source<>'manual' OR m.direction<>'outbound' THEN
        RAISE EXCEPTION 'Only manual outbound Email can be planned' USING ERRCODE='22023';
    END IF;
    IF p_action='schedule' AND m.status='Draft' AND p_scheduled_at>clock_timestamp() THEN
        IF m.context_snapshot IS NULL OR nullif(btrim(m.subject),'') IS NULL OR
            m.body ~ '\{\{|\}\}' OR m.subject ~ '\{\{|\}\}' THEN
            RAISE EXCEPTION 'Save a fully rendered foundation draft before scheduling' USING ERRCODE='22023';
        END IF;
        UPDATE communication_messages SET status='Scheduled',scheduled_at=p_scheduled_at,revision=revision+1,updated_at=now() WHERE id=p_message;
        UPDATE communication_recipients SET status='Scheduled' WHERE message_id=p_message;
    ELSIF p_action='cancel' AND m.status IN('Draft','Scheduled') AND p_scheduled_at IS NULL THEN
        UPDATE communication_messages SET status='Cancelled',cancelled_at=now(),revision=revision+1,updated_at=now() WHERE id=p_message;
        UPDATE communication_recipients SET status='Cancelled',cancelled_at=now() WHERE message_id=p_message;
    ELSE RAISE EXCEPTION 'Invalid planning transition or send date' USING ERRCODE='22023';
    END IF;
END $$;
REVOKE ALL ON FUNCTION public.plan_communication(UUID,UUID,INTEGER,TEXT,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.plan_communication(UUID,UUID,INTEGER,TEXT,TIMESTAMPTZ) TO service_role;
COMMENT ON FUNCTION public.plan_communication(UUID,UUID,INTEGER,TEXT,TIMESTAMPTZ)
    IS 'Data-only manual plan/cancel. No worker, provider call, email generation or automated dispatch.';
NOTIFY pgrst,'reload schema';
COMMIT;
