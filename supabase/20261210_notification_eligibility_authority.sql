BEGIN;

ALTER TABLE public.requirement_notification_rules
    ADD COLUMN eligibility_authority TEXT NOT NULL DEFAULT 'current_requirement'
    CHECK (eligibility_authority IN ('current_requirement','nj_pwc_monitoring'));

UPDATE public.requirement_notification_rules r
SET eligibility_authority='nj_pwc_monitoring', revision=r.revision+1, updated_at=now()
FROM public.compliance_types t
WHERE r.compliance_type_id=t.id AND t.compliance_name='NJ PWC';

CREATE FUNCTION public.save_requirement_notification_rule_with_eligibility(
    p_actor UUID, p_id UUID, p_input JSONB, p_eligibility_authority TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE result UUID;
BEGIN
    IF p_eligibility_authority IS NOT NULL AND p_eligibility_authority NOT IN ('current_requirement','nj_pwc_monitoring') THEN
        RAISE EXCEPTION 'Choose a supported eligibility authority' USING ERRCODE='22023';
    END IF;
    result:=public.save_requirement_notification_rule(p_actor,p_id,p_input);
    IF p_eligibility_authority IS NOT NULL THEN
        UPDATE public.requirement_notification_rules SET eligibility_authority=p_eligibility_authority WHERE id=result;
    END IF;
    RETURN result;
END $$;

REVOKE ALL ON FUNCTION public.save_requirement_notification_rule_with_eligibility(UUID,UUID,JSONB,TEXT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.save_requirement_notification_rule_with_eligibility(UUID,UUID,JSONB,TEXT) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
