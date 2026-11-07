BEGIN;

ALTER TABLE public.requirement_notice_communications
    ADD COLUMN project_id INTEGER REFERENCES public.projects(id) ON DELETE RESTRICT,
    ADD COLUMN preview_snapshot JSONB NOT NULL CHECK (jsonb_typeof(preview_snapshot)='object');

ALTER FUNCTION public.save_communication_draft(UUID,UUID,JSONB) RENAME TO save_communication_draft_before_notice;
REVOKE ALL ON FUNCTION public.save_communication_draft_before_notice(UUID,UUID,JSONB)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.save_communication_draft(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    IF p_id IS NOT NULL THEN
        PERFORM 1 FROM communication_messages WHERE id=p_id FOR UPDATE;
        IF EXISTS(SELECT 1 FROM requirement_notice_communications WHERE message_id=p_id) THEN
            RAISE EXCEPTION 'Notice drafts cannot be edited; generate and review a new preview' USING ERRCODE='22023';
        END IF;
    END IF;
    RETURN public.save_communication_draft_before_notice(p_actor,p_id,p_input);
END $$;
REVOKE ALL ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_communication_draft(UUID,UUID,JSONB) TO service_role;

CREATE FUNCTION public.create_requirement_notice_draft(
    p_actor UUID,p_rule UUID,p_contractor INTEGER,p_contact UUID,p_project INTEGER,
    p_preview JSONB,p_subject TEXT,p_body TEXT,p_is_test BOOLEAN
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_preview JSONB; input JSONB; result UUID; r requirement_notification_rules;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtext('company_merge'));
    IF NOT communication_actor_allowed(p_actor,'communications_content','add') THEN
        RAISE EXCEPTION 'Communications Content Add permission required' USING ERRCODE='42501';
    END IF;
    IF p_is_test IS NULL OR p_subject IS NULL OR btrim(p_subject)='' OR length(p_subject)>1000
        OR p_body IS NULL OR btrim(p_body)='' OR length(p_body)>100000
        OR (p_is_test AND p_subject NOT LIKE '[TEST]%') THEN
        RAISE EXCEPTION 'Valid reviewed subject, body and explicit test designation required' USING ERRCODE='22023';
    END IF;
    current_preview:=public.preview_requirement_notice(p_actor,p_rule,p_contractor,p_contact,p_project);
    IF p_preview IS DISTINCT FROM current_preview-ARRAY['duplicate','other_recipient_sent'] THEN
        RAISE EXCEPTION 'Notice context changed; generate and review a new preview' USING ERRCODE='40001';
    END IF;
    IF NOT p_is_test AND (current_preview->>'duplicate')::boolean THEN
        RAISE EXCEPTION 'This notice identity is already reserved or sent' USING ERRCODE='PT409';
    END IF;
    SELECT * INTO r FROM requirement_notification_rules WHERE id=p_rule;
    input:=jsonb_build_object(
        'channel','email','subject',p_subject,'body',p_body,'communication_type','Expiration Reminder',
        'template_id',current_preview->>'template_id','template_revision',(current_preview->>'template_revision')::integer,
        'recipients',jsonb_build_array(CASE WHEN p_is_test THEN
            jsonb_build_object('recipient_type','external','recipient_name','TEST SEND',
                'email','richg@dobcogroup.com','mobile_phone',NULL,'contractor_contact_id',NULL,'dobco_contact_id',NULL)
            ELSE jsonb_build_object('recipient_type','contractor_contact','recipient_name',current_preview->>'contact_name',
                'email',current_preview->>'contact_email','mobile_phone',
                (SELECT mobile_phone FROM contractor_contacts WHERE id=p_contact),
                'contractor_contact_id',p_contact,'dobco_contact_id',NULL) END),
        'contractor_ids',jsonb_build_array(p_contractor),
        'project_ids',CASE WHEN p_project IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_project) END,
        'compliance_record_ids',CASE WHEN current_preview->>'compliance_record_id' IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array((current_preview->>'compliance_record_id')::integer) END,
        'mycoi_policy_ids',CASE WHEN current_preview->>'policy_id' IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array((current_preview->>'policy_id')::integer) END,
        'insurance_items',CASE WHEN r.insurance_item_key IS NULL THEN '[]'::jsonb
            ELSE jsonb_build_array(jsonb_build_object('contractor_id',p_contractor,'item_key',r.insurance_item_key)) END,
        'followup_ids','[]'::jsonb,
        'compliance_type_ids',CASE WHEN r.compliance_type_id IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(r.compliance_type_id) END
    );
    result:=public.save_communication_draft(p_actor,NULL,input);
    INSERT INTO requirement_notice_communications(message_id,rule_id,contractor_id,contact_id,expiration_date,interval_days,
        intended_contact_name,intended_email,is_test,template_id,template_revision,project_id,preview_snapshot)
    VALUES(result,p_rule,p_contractor,p_contact,(current_preview->>'expiration_date')::date,
        (current_preview->>'days_remaining')::integer,current_preview->>'contact_name',current_preview->>'contact_email',
        p_is_test,(current_preview->>'template_id')::uuid,(current_preview->>'template_revision')::integer,
        p_project,p_preview);
    RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.create_requirement_notice_draft(UUID,UUID,INTEGER,UUID,INTEGER,JSONB,TEXT,TEXT,BOOLEAN)
    FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.create_requirement_notice_draft(UUID,UUID,INTEGER,UUID,INTEGER,JSONB,TEXT,TEXT,BOOLEAN)
    TO service_role;

ALTER FUNCTION public.reserve_communication_email_send(UUID,UUID,INTEGER) RENAME TO reserve_communication_email_send_before_notice;
REVOKE ALL ON FUNCTION public.reserve_communication_email_send_before_notice(UUID,UUID,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.reserve_communication_email_send(p_actor UUID,p_message_id UUID,p_settings_revision INTEGER)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    PERFORM 1 FROM communication_channel_settings WHERE channel='email' FOR SHARE;
    PERFORM 1 FROM communication_messages WHERE id=p_message_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM requirement_notice_communications WHERE message_id=p_message_id) THEN
        RAISE EXCEPTION 'Requirement notices require reviewed identity reservation' USING ERRCODE='42501';
    END IF;
    RETURN public.reserve_communication_email_send_before_notice(p_actor,p_message_id,p_settings_revision);
END $$;
REVOKE ALL ON FUNCTION public.reserve_communication_email_send(UUID,UUID,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_communication_email_send(UUID,UUID,INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_reviewed_communication_email_send(
    p_actor UUID,p_message_id UUID,p_settings_revision INTEGER,p_message_revision INTEGER
) RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE current_revision INTEGER; n requirement_notice_communications; current_preview JSONB;
BEGIN
    IF NOT communication_actor_allowed(p_actor,'communications_delivery','manage') THEN
        RAISE EXCEPTION 'Communications Delivery Manage permission required' USING ERRCODE='42501';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtext('company_merge'));
    PERFORM 1 FROM communication_channel_settings WHERE channel='email' FOR SHARE;
    SELECT revision INTO current_revision FROM communication_messages WHERE id=p_message_id FOR UPDATE;
    IF NOT FOUND OR p_message_revision IS NULL OR current_revision IS DISTINCT FROM p_message_revision THEN
        RAISE EXCEPTION 'Draft changed since review; reload and review it again' USING ERRCODE='40001';
    END IF;
    SELECT * INTO n FROM requirement_notice_communications WHERE message_id=p_message_id;
    IF FOUND THEN
        IF NOT n.is_test THEN
            PERFORM pg_advisory_xact_lock(hashtextextended(
                concat_ws(':',n.contractor_id,n.rule_id,n.expiration_date,n.interval_days,n.contact_id),0));
        END IF;
        current_preview:=public.preview_requirement_notice(p_actor,n.rule_id,n.contractor_id,n.contact_id,n.project_id);
        IF n.preview_snapshot IS DISTINCT FROM current_preview-ARRAY['duplicate','other_recipient_sent'] THEN
            RAISE EXCEPTION 'Notice context changed; generate and review a new preview' USING ERRCODE='40001';
        END IF;
        IF NOT n.is_test AND (current_preview->>'duplicate')::boolean THEN
            RAISE EXCEPTION 'This notice identity is already reserved or sent' USING ERRCODE='PT409';
        END IF;
        IF (SELECT count(*) FROM communication_recipients WHERE message_id=p_message_id)<>1
            OR NOT EXISTS(SELECT 1 FROM communication_recipients WHERE message_id=p_message_id AND
                CASE WHEN n.is_test THEN recipient_type='external' AND email='richg@dobcogroup.com'
                    AND contractor_contact_id IS NULL AND dobco_contact_id IS NULL
                ELSE recipient_type='contractor_contact' AND contractor_contact_id=n.contact_id
                    AND email=n.intended_email AND dobco_contact_id IS NULL END)
            OR NOT EXISTS(SELECT 1 FROM communication_messages WHERE id=p_message_id
                AND template_id=n.template_id AND template_revision=n.template_revision
                AND (NOT n.is_test OR subject LIKE '[TEST]%')) THEN
            RAISE EXCEPTION 'Notice recipient or template changed; review a new draft' USING ERRCODE='40001';
        END IF;
    END IF;
    RETURN public.reserve_communication_email_send_before_notice(p_actor,p_message_id,p_settings_revision);
END $$;

ALTER FUNCTION public.finish_communication_email_send(UUID,UUID,TEXT) RENAME TO finish_communication_email_send_before_notice;
REVOKE ALL ON FUNCTION public.finish_communication_email_send_before_notice(UUID,UUID,TEXT)
    FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION public.finish_communication_email_send(p_actor UUID,p_message_id UUID,p_outcome TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
    PERFORM public.finish_communication_email_send_before_notice(p_actor,p_message_id,p_outcome);
    INSERT INTO requirement_notice_delivery_outcomes(message_id,outcome)
        SELECT p_message_id,p_outcome WHERE EXISTS(
            SELECT 1 FROM requirement_notice_communications WHERE message_id=p_message_id);
END $$;
REVOKE ALL ON FUNCTION public.finish_communication_email_send(UUID,UUID,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_communication_email_send(UUID,UUID,TEXT) TO service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
