-- Company Merge: account for NJ BRC verification-session membership history.
-- Open sessions block merges. Stopped-session membership remains on its original
-- contractor and is recorded as preserved predecessor history in the merge receipt.
BEGIN;

DO $migration$
DECLARE
    definition TEXT;
    old_fragment TEXT;
    new_fragment TEXT;
BEGIN
    definition := pg_get_functiondef('public.company_merge_snapshot(integer,integer)'::regprocedure);
    old_fragment := $old$'nj_brc_search_requests',$old$;
    new_fragment := $new$'nj_brc_search_requests','nj_brc_verification_session_members',$new$;
    IF length(definition)-length(replace(definition,old_fragment,'')) <> length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge snapshot dependency list differs from the verified definition';
    END IF;
    EXECUTE replace(definition, old_fragment, new_fragment);

    definition := pg_get_functiondef('public.company_merge_preview(integer,integer,uuid)'::regprocedure);
    old_fragment := $old$'nj_brc_search_requests','nj_pwc_sync_state'$old$;
    new_fragment := $new$'nj_brc_search_requests','nj_brc_verification_session_members','nj_pwc_sync_state'$new$;
    IF length(definition)-length(replace(definition,old_fragment,'')) <> length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge expected dependency list differs from the verified definition';
    END IF;
    EXECUTE replace(definition, old_fragment, new_fragment);

    definition := pg_get_functiondef('public.company_merge_preview(integer,integer,uuid)'::regprocedure);
    old_fragment := $old$IF EXISTS(SELECT 1 FROM contractor_followups$old$;
    new_fragment := $new$
    IF EXISTS(
        SELECT 1
        FROM public.nj_brc_verification_session_members m
        JOIN public.nj_brc_verification_sessions s ON s.id=m.session_id
        WHERE m.contractor_id IN(p_primary,p_secondary)
          AND s.status IN('prepared','paused')
    ) THEN
        blockers:=blockers||jsonb_build_array(
            'Open NJ BRC verification session membership. Stop or complete the session before merging.');
    END IF;
    IF EXISTS(SELECT 1 FROM contractor_followups
$new$;
    IF length(definition)-length(replace(definition,old_fragment,'')) <> length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge preview blocker section differs from the verified definition';
    END IF;
    EXECUTE replace(definition, old_fragment, new_fragment);

    definition := pg_get_functiondef(
        'public.company_merge_execute(integer,integer,text,jsonb,jsonb,uuid,uuid,boolean,uuid)'::regprocedure);
    old_fragment := $old$public.nj_brc_search_requests,public.nj_pwc_sync_state,public.nj_pwc_sync_exceptions,$old$;
    new_fragment := $new$
public.nj_brc_search_requests,public.nj_brc_verification_sessions,
        public.nj_brc_verification_session_members,public.nj_pwc_sync_state,public.nj_pwc_sync_exceptions,
$new$;
    IF length(definition)-length(replace(definition,old_fragment,'')) <> length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge execution lock list differs from the verified definition';
    END IF;
    EXECUTE replace(definition, old_fragment, new_fragment);

    definition := pg_get_functiondef(
        'public.company_merge_execute(integer,integer,text,jsonb,jsonb,uuid,uuid,boolean,uuid)'::regprocedure);
    old_fragment := $old$UPDATE mycoi_vendor_mappings SET active=false,updated_at=now() WHERE contractor_id IN(p_primary,p_secondary) AND active;$old$;
    new_fragment := $new$
    UPDATE company_merge_lineage l
    SET after_row=l.before_row||jsonb_build_object(
        'preserved_on_predecessor',true,'session_status',s.status)
    FROM public.nj_brc_verification_sessions s
    WHERE l.merge_id=p_operation AND l.category='nj_brc_verification_session_members'
      AND s.id=(l.before_row->>'session_id')::uuid;
    UPDATE mycoi_vendor_mappings SET active=false,updated_at=now() WHERE contractor_id IN(p_primary,p_secondary) AND active;
$new$;
    IF length(definition)-length(replace(definition,old_fragment,'')) <> length(old_fragment) THEN
        RAISE EXCEPTION 'Company Merge preservation section differs from the verified definition';
    END IF;
    EXECUTE replace(definition, old_fragment, new_fragment);
END;
$migration$;

DROP TRIGGER IF EXISTS company_merge_identity_guard ON public.nj_brc_verification_session_members;
CREATE TRIGGER company_merge_identity_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.nj_brc_verification_session_members
    FOR EACH ROW EXECUTE FUNCTION public.company_merge_guard('contractor_id');

COMMIT;
