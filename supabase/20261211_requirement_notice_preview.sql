BEGIN;

CREATE TABLE public.requirement_notice_communications (
    message_id UUID PRIMARY KEY REFERENCES public.communication_messages(id) ON DELETE RESTRICT,
    rule_id UUID NOT NULL REFERENCES public.requirement_notification_rules(id) ON DELETE RESTRICT,
    contractor_id INTEGER NOT NULL REFERENCES public.contractors(id) ON DELETE RESTRICT,
    contact_id UUID NOT NULL REFERENCES public.contractor_contacts(id) ON DELETE RESTRICT,
    expiration_date DATE NOT NULL,
    interval_days INTEGER NOT NULL CHECK(interval_days BETWEEN 1 AND 36500),
    intended_contact_name TEXT NOT NULL CHECK(btrim(intended_contact_name)<>''),
    intended_email TEXT NOT NULL CHECK(btrim(intended_email)<>''),
    is_test BOOLEAN NOT NULL,
    template_id UUID NOT NULL REFERENCES public.communication_templates(id) ON DELETE RESTRICT,
    template_revision INTEGER NOT NULL CHECK(template_revision>0)
);
CREATE INDEX requirement_notice_identity ON public.requirement_notice_communications
    (contractor_id,rule_id,expiration_date,interval_days,contact_id) WHERE NOT is_test;
ALTER TABLE public.requirement_notice_communications ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.requirement_notice_communications FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.requirement_notice_communications TO service_role;

CREATE TABLE public.requirement_notice_delivery_outcomes (
    message_id UUID PRIMARY KEY REFERENCES public.requirement_notice_communications(message_id) ON DELETE RESTRICT,
    outcome TEXT NOT NULL CHECK(outcome IN ('accepted','graph_rejected','outcome_unknown','authentication_failed','identity_configuration')),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.requirement_notice_delivery_outcomes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.requirement_notice_delivery_outcomes FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.requirement_notice_delivery_outcomes TO service_role;

CREATE FUNCTION public.guard_requirement_notice_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    RAISE EXCEPTION 'Requirement notice identity is immutable' USING ERRCODE='42501';
END $$;
CREATE TRIGGER requirement_notice_identity_immutable BEFORE UPDATE OR DELETE
    ON public.requirement_notice_communications FOR EACH ROW EXECUTE FUNCTION public.guard_requirement_notice_identity();
REVOKE ALL ON FUNCTION public.guard_requirement_notice_identity() FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.requirement_notice_contact_ancestors(p_contractor INTEGER,p_contact UUID)
RETURNS INTEGER[] LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
    WITH RECURSIVE transferred(id,path) AS (
        SELECT p_contractor,ARRAY[p_contractor]
        UNION ALL
        SELECT predecessor.id,t.path||predecessor.id
        FROM transferred t JOIN company_merges m ON m.successor_id=t.id
        CROSS JOIN LATERAL (VALUES(m.primary_id),(m.secondary_id)) predecessor(id)
        JOIN company_merge_lineage l ON l.merge_id=m.id AND l.category='contractor_contacts'
            AND l.source_id=p_contact::text
            AND l.before_row->>'id'=p_contact::text
            AND l.before_row->>'contractor_id'=predecessor.id::text
            AND l.after_row->>'id'=p_contact::text
            AND l.after_row->>'contractor_id'=t.id::text
        WHERE NOT predecessor.id=ANY(t.path)
    )
    SELECT array_agg(DISTINCT id ORDER BY id) FROM transferred;
$$;
REVOKE ALL ON FUNCTION public.requirement_notice_contact_ancestors(INTEGER,UUID)
    FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.preview_requirement_notice(
    p_actor UUID, p_rule UUID, p_contractor INTEGER, p_contact UUID, p_project INTEGER DEFAULT NULL
) RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r requirement_notification_rules; c contractors; contact contractor_contacts;
    expiration DATE; requirement_name TEXT; record_id INTEGER; policy_id INTEGER;
    days INTEGER; t communication_templates; channel communication_channel_settings;
    project projects; other_recipient BOOLEAN; duplicate BOOLEAN; installation user_invitation_email_settings;
    contact_ancestors INTEGER[];
BEGIN
    IF NOT communication_actor_allowed(p_actor,'settings','view')
        OR NOT communication_actor_allowed(p_actor,'contractors','view')
        OR NOT communication_actor_allowed(p_actor,'communications_delivery','view')
        OR NOT (communication_actor_allowed(p_actor,'communications_content','add')
            OR communication_actor_allowed(p_actor,'communications_content','edit')) THEN
        RAISE EXCEPTION 'Settings, Contractors and Communications Delivery View and Communications Content Add or Edit permissions are required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO r FROM requirement_notification_rules WHERE id=p_rule;
    IF NOT FOUND OR NOT r.automatic_enabled OR r.schedule_type<>'expiration' THEN
        RAISE EXCEPTION 'An enabled expiration-based requirement rule is required' USING ERRCODE='22023';
    END IF;
    IF r.compliance_type_id IS NOT NULL AND NOT communication_actor_allowed(p_actor,'compliance','view')
        OR r.insurance_item_key IS NOT NULL AND NOT communication_actor_allowed(p_actor,'insurance','view') THEN
        RAISE EXCEPTION 'Requirement View permission required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO c FROM contractors WHERE id=p_contractor AND active AND nullif(btrim(company_name),'') IS NOT NULL;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active contractor required' USING ERRCODE='22023'; END IF;
    SELECT * INTO contact FROM contractor_contacts WHERE id=p_contact AND contractor_id=c.id AND is_active
        AND receives_compliance_email AND email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$';
    IF NOT FOUND THEN RAISE EXCEPTION 'An eligible current contractor contact with an email address is required' USING ERRCODE='22023'; END IF;
    CASE r.eligibility_authority
        WHEN 'current_requirement' THEN NULL;
        WHEN 'nj_pwc_monitoring' THEN
            IF NOT public.nj_pwc_daily_contractor_eligible(c.id) THEN
                RAISE EXCEPTION 'Contractor does not meet the configured eligibility authority' USING ERRCODE='22023';
            END IF;
        ELSE RAISE EXCEPTION 'Unsupported eligibility authority' USING ERRCODE='22023';
    END CASE;
    IF r.compliance_type_id IS NOT NULL THEN
        IF (SELECT count(*) FROM compliance_records cr WHERE cr.compliance_type_id=r.compliance_type_id
            AND cr.contractor_id=c.id AND cr.active AND cr.is_current)>1 THEN
            RAISE EXCEPTION 'Multiple current compliance records require review' USING ERRCODE='22023';
        END IF;
        SELECT ct.compliance_name, cr.id, cr.expiration_date INTO requirement_name,record_id,expiration
        FROM compliance_types ct JOIN compliance_records cr ON cr.compliance_type_id=ct.id
        WHERE ct.id=r.compliance_type_id AND ct.active AND ct.requires_expiration
            AND cr.contractor_id=c.id AND cr.active AND cr.is_current;
    ELSIF r.insurance_item_key IN ('general_liability','workers_compensation') THEN
        requirement_name:=CASE r.insurance_item_key WHEN 'general_liability' THEN 'General Liability' ELSE 'Workers Compensation' END;
        SELECT p.id,p.expiration_date INTO policy_id,expiration
        FROM mycoi_policies p JOIN mycoi_vendor_mappings v ON v.id=p.vendor_mapping_id
        WHERE p.contractor_id=c.id AND p.active AND p.is_current AND v.active AND v.contractor_id=c.id
            AND p.policy_line_key=CASE r.insurance_item_key WHEN 'general_liability' THEN 'general liability' ELSE 'workers compensation' END
            AND p.expiration_date IS NOT NULL
        ORDER BY p.expiration_date DESC,p.id LIMIT 1;
    END IF;
    IF requirement_name IS NULL OR expiration IS NULL THEN
        RAISE EXCEPTION 'A current expiring requirement is required' USING ERRCODE='22023';
    END IF;
    days:=expiration-CURRENT_DATE;
    SELECT t1.* INTO t FROM requirement_notification_intervals i
        JOIN communication_templates t1 ON t1.id=i.template_id AND t1.is_active AND t1.channel='email'
        JOIN communication_template_automation_approvals a ON a.template_id=t1.id AND a.template_revision=t1.revision
        WHERE i.rule_id=r.id AND i.enabled AND i.days_before_expiration=days;
    IF NOT FOUND THEN RAISE EXCEPTION 'No enabled, approved interval matches the current days remaining' USING ERRCODE='22023'; END IF;
    IF p_project IS NOT NULL THEN
        IF NOT communication_actor_allowed(p_actor,'projects','view') THEN
            RAISE EXCEPTION 'Projects View permission required' USING ERRCODE='42501';
        END IF;
        SELECT p.* INTO project FROM projects p JOIN contractor_projects cp ON cp.project_id=p.id
            WHERE p.id=p_project AND p.status='Active' AND cp.contractor_id=c.id AND cp.active;
        IF NOT FOUND THEN RAISE EXCEPTION 'An active contractor project relationship is required' USING ERRCODE='22023'; END IF;
    END IF;
    contact_ancestors:=public.requirement_notice_contact_ancestors(c.id,contact.id);
    IF EXISTS(SELECT 1 FROM requirement_notice_communications n JOIN communication_messages m ON m.id=n.message_id
        WHERE n.rule_id=r.id AND n.contractor_id=ANY(public.company_merge_ancestors(c.id))
            AND NOT n.contractor_id=ANY(contact_ancestors)
            AND n.expiration_date=expiration AND n.interval_days=days AND n.contact_id=contact.id AND NOT n.is_test
            AND (m.status IN ('Sent','Delivered','Sending') OR EXISTS(
                SELECT 1 FROM requirement_notice_delivery_outcomes o WHERE o.message_id=m.id AND o.outcome='outcome_unknown'))) THEN
        RAISE EXCEPTION 'Notice contact transfer lineage is incomplete; review the previous notice before sending' USING ERRCODE='22023';
    END IF;
    SELECT EXISTS(SELECT 1 FROM requirement_notice_communications n JOIN communication_messages m ON m.id=n.message_id
        WHERE n.rule_id=r.id AND n.contractor_id=ANY(contact_ancestors) AND n.expiration_date=expiration AND n.interval_days=days
            AND n.contact_id=contact.id AND NOT n.is_test
            AND (m.status IN ('Sent','Delivered','Sending') OR EXISTS(
                SELECT 1 FROM requirement_notice_delivery_outcomes o WHERE o.message_id=m.id AND o.outcome='outcome_unknown'))) INTO duplicate;
    SELECT EXISTS(SELECT 1 FROM requirement_notice_communications n JOIN communication_messages m ON m.id=n.message_id
        WHERE n.rule_id=r.id AND n.contractor_id=ANY(public.company_merge_ancestors(c.id))
            AND n.contractor_id=ANY(public.requirement_notice_contact_ancestors(c.id,n.contact_id))
            AND n.expiration_date=expiration AND n.interval_days=days
            AND n.contact_id<>contact.id AND NOT n.is_test AND m.status IN ('Sent','Delivered')) INTO other_recipient;
    SELECT cs.* INTO channel FROM communication_channel_settings cs WHERE cs.channel='email';
    SELECT * INTO installation FROM user_invitation_email_settings;
    RETURN jsonb_build_object(
        'rule_id',r.id,'rule_revision',r.revision,'contractor_id',c.id,'company_name',c.company_name,'dba_name',c.dba_name,
        'contact_id',contact.id,'contact_name',contact.contact_name,'contact_email',contact.email,
        'requirement_name',requirement_name,'compliance_record_id',record_id,'policy_id',policy_id,
        'expiration_date',expiration,'days_remaining',days,'project_id',project.id,'project_number',project.project_number,
        'project_name',project.project_name,'template_id',t.id,'template_revision',t.revision,'template_subject',t.subject,
        'template_body',t.body,'sender_name',channel.from_name,'sender_address',channel.from_address,
        'organization_name',installation.organization_name,'application_name',installation.application_name,
        'duplicate',duplicate,'other_recipient_sent',other_recipient
    );
END $$;
REVOKE ALL ON FUNCTION public.preview_requirement_notice(UUID,UUID,INTEGER,UUID,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.preview_requirement_notice(UUID,UUID,INTEGER,UUID,INTEGER) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
