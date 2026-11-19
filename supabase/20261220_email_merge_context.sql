-- Function-only Email context upgrade. Existing records, snapshots and settings are untouched.
BEGIN;

CREATE OR REPLACE FUNCTION public.communication_template_context_before_message_followup(p_actor UUID,p_input JSONB)
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
    -- Email personalization belongs only to a single To contact; Cc/Bcc are delivery-only.
    IF p_input->>'channel'='email' THEN
        SELECT coalesce(jsonb_agg(r),'[]') INTO recipients FROM jsonb_array_elements(recipients) r
            WHERE coalesce(r->>'recipient_role','to')='to';
    END IF;
    IF jsonb_array_length(recipients)=1 THEN
        recipient:=recipients->0; row_data:=NULL;
        IF recipient->>'recipient_type'='contractor_contact' THEN
            IF NOT communication_actor_allowed(p_actor,'contractors','view') THEN
                RAISE EXCEPTION 'Contractors View permission required' USING ERRCODE='42501';
            END IF;
            SELECT to_jsonb(c) INTO row_data FROM contractor_contacts c
                WHERE id=(recipient->>'contractor_contact_id')::uuid
                    AND (p_input->>'channel'='email' OR contractor_ids @> jsonb_build_array(c.contractor_id));
            IF row_data IS NULL THEN RAISE EXCEPTION 'Selected contractor contact is unavailable' USING ERRCODE='22023'; END IF;
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
REVOKE ALL ON FUNCTION public.communication_template_context_before_message_followup(UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;

-- Retain the existing save chain, contact eligibility and business-record ownership checks.
CREATE OR REPLACE FUNCTION public.save_communication_draft_base(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE message_id UUID:=p_id; existing public.communication_messages; channel_settings public.communication_channel_settings;
    r JSONB; c_ids INTEGER[]; p_ids INTEGER[]; compliance_ids INTEGER[]; policy_ids INTEGER[];
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'communications_content',CASE WHEN p_id IS NULL THEN 'add' ELSE 'edit' END) THEN
        RAISE EXCEPTION 'Communications Content mutation permission required' USING ERRCODE='42501';
    END IF;
    IF p_input IS NULL OR jsonb_typeof(p_input)<>'object'
        OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k WHERE k<>ALL(ARRAY[
            'channel','subject','body','recipients','contractor_ids','project_ids','compliance_record_ids','mycoi_policy_ids','insurance_items','revision']))
        OR p_input->>'channel' NOT IN('email','sms') OR jsonb_typeof(p_input->'body') IS DISTINCT FROM 'string'
        OR length(p_input->>'body') NOT BETWEEN 1 AND 100000 THEN
        RAISE EXCEPTION 'Invalid draft input' USING ERRCODE='22023';
    END IF;
    IF p_id IS NOT NULL THEN
        SELECT * INTO existing FROM public.communication_messages WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Communication not found' USING ERRCODE='P0002'; END IF;
        IF existing.status<>'Draft' OR existing.source<>'manual' OR existing.direction<>'outbound' THEN
            RAISE EXCEPTION 'Only manual outbound Draft communications can be edited' USING ERRCODE='22023';
        END IF;
        IF existing.revision IS DISTINCT FROM (p_input->>'revision')::INTEGER THEN
            RAISE EXCEPTION 'Draft changed; reload before saving' USING ERRCODE='40001';
        END IF;
    END IF;
    FOREACH r IN ARRAY ARRAY[p_input->'recipients',p_input->'contractor_ids',p_input->'project_ids',
        p_input->'compliance_record_ids',p_input->'mycoi_policy_ids',p_input->'insurance_items'] LOOP
        IF jsonb_typeof(r) IS DISTINCT FROM 'array' OR jsonb_array_length(r)>100 THEN
            RAISE EXCEPTION 'Expected bounded relationship arrays' USING ERRCODE='22023';
        END IF;
    END LOOP;
    IF jsonb_array_length(p_input->'recipients')=0 THEN
        RAISE EXCEPTION 'At least one recipient snapshot required' USING ERRCODE='22023';
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
        RAISE EXCEPTION 'Related business-record View permission required' USING ERRCODE='42501';
    END IF;
    IF EXISTS(SELECT 1 FROM unnest(compliance_ids) i LEFT JOIN public.compliance_records c ON c.id=i WHERE c.id IS NULL OR NOT(c.contractor_id=ANY(c_ids)))
        OR EXISTS(SELECT 1 FROM unnest(policy_ids) i LEFT JOIN public.mycoi_policies p ON p.id=i WHERE p.id IS NULL OR NOT(p.contractor_id=ANY(c_ids))) THEN
        RAISE EXCEPTION 'Related item does not belong to a linked contractor' USING ERRCODE='22023';
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
        IF NOT((r->>'contractor_id')::INTEGER=ANY(c_ids))
            OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN('contractor_id','item_key')) THEN
            RAISE EXCEPTION 'Insurance item must belong to a linked contractor' USING ERRCODE='22023';
        END IF;
        INSERT INTO public.communication_insurance_items VALUES(message_id,(r->>'contractor_id')::INTEGER,r->>'item_key');
    END LOOP;
    FOR r IN SELECT value FROM jsonb_array_elements(p_input->'recipients') LOOP
        IF jsonb_typeof(r)<>'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) k WHERE k NOT IN
            ('recipient_type','recipient_name','email','mobile_phone','contractor_contact_id','dobco_contact_id'))
            OR nullif(btrim(CASE WHEN p_input->>'channel'='email' THEN r->>'email' ELSE r->>'mobile_phone' END),'') IS NULL THEN
            RAISE EXCEPTION 'Invalid recipient snapshot' USING ERRCODE='22023';
        END IF;
        IF r->>'contractor_contact_id' IS NOT NULL AND (NOT public.communication_actor_allowed(p_actor,'contractors','view')
            OR NOT EXISTS(SELECT 1 FROM public.contractor_contacts c WHERE c.id=(r->>'contractor_contact_id')::UUID
                AND (p_input->>'channel'='email' OR c.contractor_id=ANY(c_ids)))) THEN
            RAISE EXCEPTION 'Contractor contact is unavailable or not permitted for this message' USING ERRCODE='22023';
        END IF;
        IF r->>'dobco_contact_id' IS NOT NULL AND NOT public.communication_actor_allowed(p_actor,'settings','view') THEN
            RAISE EXCEPTION 'Settings View permission required for Dobco contact reference' USING ERRCODE='42501';
        END IF;
        INSERT INTO public.communication_recipients(message_id,recipient_type,recipient_name,email,mobile_phone,contractor_contact_id,dobco_contact_id)
        VALUES(message_id,r->>'recipient_type',r->>'recipient_name',r->>'email',r->>'mobile_phone',
            (r->>'contractor_contact_id')::UUID,(r->>'dobco_contact_id')::UUID);
    END LOOP;
    RETURN message_id;
END $$;
REVOKE ALL ON FUNCTION public.save_communication_draft_base(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated,service_role;

NOTIFY pgrst,'reload schema';
COMMIT;
