BEGIN;

CREATE TABLE public.communication_template_automation_approvals (
    template_id UUID NOT NULL REFERENCES public.communication_templates(id) ON DELETE RESTRICT,
    template_revision INTEGER NOT NULL CHECK(template_revision>0),
    approved_by UUID NOT NULL REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(template_id,template_revision)
);

CREATE TABLE public.requirement_notification_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    compliance_type_id INTEGER UNIQUE REFERENCES public.compliance_types(id) ON DELETE RESTRICT,
    insurance_item_key TEXT UNIQUE CHECK(insurance_item_key IN ('general_liability','workers_compensation','certificate_of_insurance')),
    automatic_enabled BOOLEAN NOT NULL DEFAULT false,
    schedule_type TEXT NOT NULL CHECK(schedule_type IN ('expiration','non_expiring')),
    sender_contact_id UUID REFERENCES public.dobco_contacts(id) ON DELETE RESTRICT,
    internal_contact_id UUID REFERENCES public.dobco_contacts(id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by UUID REFERENCES public.user_profiles(auth_user_id) ON DELETE RESTRICT,
    CHECK((compliance_type_id IS NOT NULL)::integer+(insurance_item_key IS NOT NULL)::integer=1),
    CHECK(NOT automatic_enabled OR schedule_type='expiration'),
    CHECK(insurance_item_key IS DISTINCT FROM 'certificate_of_insurance' OR NOT automatic_enabled)
);
CREATE TABLE public.requirement_notification_intervals (
    rule_id UUID NOT NULL REFERENCES public.requirement_notification_rules(id) ON DELETE RESTRICT,
    days_before_expiration INTEGER NOT NULL CHECK(days_before_expiration BETWEEN 1 AND 36500),
    enabled BOOLEAN NOT NULL DEFAULT false,
    template_id UUID REFERENCES public.communication_templates(id) ON DELETE RESTRICT,
    PRIMARY KEY(rule_id,days_before_expiration),
    CHECK(NOT enabled OR template_id IS NOT NULL)
);
CREATE INDEX requirement_notification_intervals_template ON public.requirement_notification_intervals(template_id);

-- Populate configuration from the existing authority; no notice is enabled or scheduled.
INSERT INTO public.requirement_notification_rules(compliance_type_id,schedule_type)
SELECT id,CASE WHEN requires_expiration THEN 'expiration' ELSE 'non_expiring' END
FROM public.compliance_types;
INSERT INTO public.requirement_notification_rules(insurance_item_key,schedule_type)
VALUES ('general_liability','expiration'),('workers_compensation','expiration'),('certificate_of_insurance','expiration');

ALTER TABLE public.communication_template_automation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requirement_notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.requirement_notification_intervals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.communication_template_automation_approvals,public.requirement_notification_rules,
    public.requirement_notification_intervals FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.communication_template_automation_approvals,public.requirement_notification_rules,
    public.requirement_notification_intervals TO service_role;

CREATE VIEW public.requirement_notification_readiness WITH (security_invoker=true) AS
SELECT r.*,
    (r.automatic_enabled AND r.schedule_type='expiration'
     AND r.insurance_item_key IS DISTINCT FROM 'certificate_of_insurance'
     AND (r.compliance_type_id IS NULL OR EXISTS(SELECT 1 FROM public.compliance_types c WHERE c.id=r.compliance_type_id AND c.active AND c.requires_expiration))
     AND EXISTS(SELECT 1 FROM public.requirement_notification_intervals i WHERE i.rule_id=r.id AND i.enabled)
     AND NOT EXISTS(SELECT 1 FROM public.requirement_notification_intervals i
        LEFT JOIN public.communication_templates t ON t.id=i.template_id
        LEFT JOIN public.communication_template_automation_approvals a ON a.template_id=t.id AND a.template_revision=t.revision
        WHERE i.rule_id=r.id AND i.enabled AND (t.id IS NULL OR NOT t.is_active OR t.channel<>'email' OR a.template_id IS NULL))
    ) AS configuration_ready
FROM public.requirement_notification_rules r;
REVOKE ALL ON public.requirement_notification_readiness FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.requirement_notification_readiness TO service_role;

CREATE FUNCTION public.approve_communication_template_automation(p_actor UUID,p_template UUID,p_revision INTEGER)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE t public.communication_templates;
BEGIN
    IF NOT EXISTS(SELECT 1 FROM public.user_profiles u WHERE u.auth_user_id=p_actor AND u.status='Active'
        AND (u.system_administrator OR (u.role='Administrator' AND public.communication_actor_allowed(p_actor,'settings','manage')))) THEN
        RAISE EXCEPTION 'An active administrator with template management permission is required' USING ERRCODE='42501';
    END IF;
    SELECT * INTO t FROM public.communication_templates WHERE id=p_template FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Template not found' USING ERRCODE='P0002'; END IF;
    IF t.revision IS DISTINCT FROM p_revision THEN RAISE EXCEPTION 'Template changed; review its current revision' USING ERRCODE='PT409'; END IF;
    IF NOT t.is_active OR t.channel<>'email' THEN RAISE EXCEPTION 'An active Email template is required' USING ERRCODE='22023'; END IF;
    INSERT INTO public.communication_template_automation_approvals(template_id,template_revision,approved_by)
        VALUES(p_template,p_revision,p_actor) ON CONFLICT DO NOTHING;
END $$;

CREATE FUNCTION public.save_requirement_notification_rule(p_actor UUID,p_id UUID,p_input JSONB)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r public.requirement_notification_rules; entry JSONB; cid INTEGER; ikey TEXT; result UUID; expected INTEGER;
BEGIN
    IF NOT public.communication_actor_allowed(p_actor,'settings','manage') THEN
        RAISE EXCEPTION 'Settings Manage permission required' USING ERRCODE='42501';
    END IF;
    IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(p_input) k
        WHERE k NOT IN ('compliance_type_id','insurance_item_key','automatic_enabled','schedule_type','sender_contact_id','internal_contact_id','revision','intervals'))
        OR jsonb_typeof(p_input->'automatic_enabled') IS DISTINCT FROM 'boolean'
        OR p_input->>'schedule_type' NOT IN ('expiration','non_expiring') OR p_input->>'schedule_type' IS NULL
        OR jsonb_typeof(p_input->'revision') IS DISTINCT FROM 'number' OR p_input->>'revision' !~ '^(0|[1-9][0-9]*)$'
        OR jsonb_typeof(p_input->'intervals') IS DISTINCT FROM 'array' OR jsonb_array_length(p_input->'intervals')>100 THEN
        RAISE EXCEPTION 'Invalid requirement rule' USING ERRCODE='22023';
    END IF;
    cid:=(p_input->>'compliance_type_id')::integer; ikey:=p_input->>'insurance_item_key';
    expected:=(p_input->>'revision')::integer;
    IF (cid IS NULL)=(ikey IS NULL) OR (cid IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.compliance_types WHERE id=cid))
        OR (ikey IS NOT NULL AND ikey NOT IN ('general_liability','workers_compensation','certificate_of_insurance')) THEN
        RAISE EXCEPTION 'Choose an existing requirement' USING ERRCODE='22023';
    END IF;
    IF cid IS NOT NULL THEN
        PERFORM 1 FROM public.compliance_types WHERE id=cid FOR SHARE;
        IF p_input->>'schedule_type'='expiration' AND NOT EXISTS(
            SELECT 1 FROM public.compliance_types WHERE id=cid AND requires_expiration) THEN
            RAISE EXCEPTION 'This requirement does not use expiration dates' USING ERRCODE='22023';
        END IF;
        IF NOT EXISTS(SELECT 1 FROM public.compliance_types WHERE id=cid AND active) AND
            ((p_input->>'automatic_enabled')::boolean OR EXISTS(
                SELECT 1 FROM jsonb_array_elements(p_input->'intervals') i WHERE i->'enabled'='true'::jsonb)) THEN
            RAISE EXCEPTION 'Inactive requirements cannot enable automatic notices' USING ERRCODE='22023';
        END IF;
    END IF;
    IF p_id IS NULL THEN
        IF expected<>0 THEN RAISE EXCEPTION 'Rule changed; reload' USING ERRCODE='PT409'; END IF;
        INSERT INTO public.requirement_notification_rules(compliance_type_id,insurance_item_key,schedule_type)
            VALUES(cid,ikey,p_input->>'schedule_type') RETURNING * INTO r;
    ELSE
        SELECT * INTO r FROM public.requirement_notification_rules WHERE id=p_id FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'Rule not found' USING ERRCODE='P0002'; END IF;
        IF r.revision IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Rule changed; reload' USING ERRCODE='PT409'; END IF;
        IF r.compliance_type_id IS DISTINCT FROM cid OR r.insurance_item_key IS DISTINCT FROM ikey THEN
            RAISE EXCEPTION 'Requirement identity cannot change' USING ERRCODE='22023';
        END IF;
    END IF;
    IF (p_input->>'schedule_type'='non_expiring' AND
        ((p_input->>'automatic_enabled')::boolean OR jsonb_array_length(p_input->'intervals')>0))
        OR (ikey='certificate_of_insurance' AND ((p_input->>'automatic_enabled')::boolean OR
            EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'intervals') i WHERE (i->>'enabled')::boolean))) THEN
        RAISE EXCEPTION 'Non-expiring or retired requirements cannot use expiration automation' USING ERRCODE='22023';
    END IF;
    IF (p_input->>'automatic_enabled')::boolean AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'intervals') i WHERE i->'enabled'='true'::jsonb) THEN
        RAISE EXCEPTION 'Enable at least one approved interval before enabling automatic notices' USING ERRCODE='22023';
    END IF;
    FOR entry IN SELECT value FROM jsonb_array_elements(p_input->'intervals') LOOP
        IF jsonb_typeof(entry) IS DISTINCT FROM 'object' OR EXISTS(SELECT 1 FROM jsonb_object_keys(entry) k WHERE k NOT IN ('days_before_expiration','enabled','template_id'))
            OR jsonb_typeof(entry->'days_before_expiration') IS DISTINCT FROM 'number'
            OR entry->>'days_before_expiration' !~ '^[1-9][0-9]*$'
            OR (entry->>'days_before_expiration')::integer NOT BETWEEN 1 AND 36500
            OR jsonb_typeof(entry->'enabled') IS DISTINCT FROM 'boolean' THEN
            RAISE EXCEPTION 'Invalid expiration interval' USING ERRCODE='22023';
        END IF;
        IF (entry->>'enabled')::boolean THEN
            PERFORM 1 FROM public.communication_templates t JOIN public.communication_template_automation_approvals a
                ON a.template_id=t.id AND a.template_revision=t.revision
                WHERE t.id=(entry->>'template_id')::uuid AND t.is_active AND t.channel='email' FOR SHARE OF t;
            IF NOT FOUND THEN RAISE EXCEPTION 'Each enabled interval requires an active Email template approved at its current revision' USING ERRCODE='22023'; END IF;
        END IF;
    END LOOP;
    IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_input->'intervals') i GROUP BY i->>'days_before_expiration' HAVING count(*)>1) THEN
        RAISE EXCEPTION 'Interval days must be unique' USING ERRCODE='22023';
    END IF;
    IF EXISTS(SELECT 1 FROM unnest(ARRAY[(p_input->>'sender_contact_id')::uuid,(p_input->>'internal_contact_id')::uuid]) id
        WHERE id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.dobco_contacts c WHERE c.id=id AND c.is_active)) THEN
        RAISE EXCEPTION 'Choose an active Dobco contact' USING ERRCODE='22023';
    END IF;
    UPDATE public.requirement_notification_rules SET automatic_enabled=(p_input->>'automatic_enabled')::boolean,
        schedule_type=p_input->>'schedule_type',sender_contact_id=(p_input->>'sender_contact_id')::uuid,
        internal_contact_id=(p_input->>'internal_contact_id')::uuid,revision=CASE WHEN p_id IS NULL THEN 1 ELSE revision+1 END,
        updated_at=now(),updated_by=p_actor WHERE id=r.id RETURNING id INTO result;
    DELETE FROM public.requirement_notification_intervals WHERE rule_id=result;
    INSERT INTO public.requirement_notification_intervals(rule_id,days_before_expiration,enabled,template_id)
        SELECT result,(i->>'days_before_expiration')::integer,(i->>'enabled')::boolean,(i->>'template_id')::uuid
        FROM jsonb_array_elements(p_input->'intervals') i;
    RETURN result;
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'Requirement rule or interval already exists; reload' USING ERRCODE='PT409';
END $$;
REVOKE ALL ON FUNCTION public.approve_communication_template_automation(UUID,UUID,INTEGER),
    public.save_requirement_notification_rule(UUID,UUID,JSONB) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.approve_communication_template_automation(UUID,UUID,INTEGER),
    public.save_requirement_notification_rule(UUID,UUID,JSONB) TO service_role;
COMMENT ON TABLE public.requirement_notification_rules IS 'Configuration only; readiness must include current active template revision approval. No dispatcher or scheduler.';
NOTIFY pgrst,'reload schema';
COMMIT;
