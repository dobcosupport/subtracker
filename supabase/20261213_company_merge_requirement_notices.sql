-- Preserve notice history and incorporate it into Company Merge's dependency checks.
BEGIN;

DO $migration$
DECLARE definition TEXT; old_fragment TEXT; new_fragment TEXT;
BEGIN
    definition:=pg_get_functiondef('public.company_merge_snapshot(integer,integer)'::regprocedure);
    old_fragment:=$old$'communication_contractors','communication_insurance_items',$old$;
    new_fragment:=$new$'communication_contractors','communication_insurance_items','requirement_notice_communications',$new$;
    IF length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge snapshot dependency list differs from the verified definition';
    END IF;
    EXECUTE replace(definition,old_fragment,new_fragment);

    definition:=pg_get_functiondef('public.company_merge_preview(integer,integer,uuid)'::regprocedure);
    old_fragment:=$old$'communication_contractors','communication_insurance_items','compliance_sync_review_queue',$old$;
    new_fragment:=$new$'communication_contractors','communication_insurance_items','requirement_notice_communications','compliance_sync_review_queue',$new$;
    IF length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge expected dependency list differs from the verified definition';
    END IF;
    EXECUTE replace(definition,old_fragment,new_fragment);

    definition:=pg_get_functiondef(
        'public.company_merge_execute(integer,integer,text,jsonb,jsonb,uuid,uuid,boolean,uuid)'::regprocedure);
    old_fragment:=$old$public.communication_insurance_items,public.communication_compliance_items,public.communication_mycoi_items,$old$;
    new_fragment:=$new$public.communication_insurance_items,public.communication_compliance_items,public.communication_mycoi_items,
        public.requirement_notice_communications,public.requirement_notice_delivery_outcomes,$new$;
    IF length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge execution lock list differs from the verified definition';
    END IF;
    EXECUTE replace(definition,old_fragment,new_fragment);

    definition:=pg_get_functiondef(
        'public.company_merge_execute(integer,integer,text,jsonb,jsonb,uuid,uuid,boolean,uuid)'::regprocedure);
    old_fragment:=$old$UPDATE mycoi_vendor_mappings SET active=false,updated_at=now() WHERE contractor_id IN(p_primary,p_secondary) AND active;$old$;
    new_fragment:=$new$
    UPDATE company_merge_lineage SET after_row=before_row||jsonb_build_object('preserved_on_predecessor',true)
        WHERE merge_id=p_operation AND category='requirement_notice_communications';
    UPDATE mycoi_vendor_mappings SET active=false,updated_at=now() WHERE contractor_id IN(p_primary,p_secondary) AND active;
$new$;
    IF length(definition)-length(replace(definition,old_fragment,''))<>length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge preservation section differs from the verified definition';
    END IF;
    EXECUTE replace(definition,old_fragment,new_fragment);
END;
$migration$;

NOTIFY pgrst,'reload schema';
COMMIT;
