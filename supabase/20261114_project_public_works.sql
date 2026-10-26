-- Local migration only. Installation requires separate approval.
BEGIN;

ALTER TABLE public.projects ADD COLUMN public_works BOOLEAN;

CREATE FUNCTION public.import_project_without_classification(
    p_number TEXT, p_name TEXT, p_status TEXT, p_existing INTEGER DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE previous_context TEXT := current_setting('subtracker.project_import',true);
BEGIN
    IF NOT public.user_has_module_permission('imports','view')
        OR NOT public.user_has_module_permission('projects',CASE WHEN p_existing IS NULL THEN 'add' ELSE 'edit' END) THEN
        RAISE EXCEPTION 'Project import permission required' USING ERRCODE='42501';
    END IF;
    PERFORM set_config('subtracker.project_import','on',true);
    IF p_existing IS NULL THEN
        INSERT INTO public.projects(project_number,project_name,status) VALUES(p_number,p_name,p_status);
    ELSE
        UPDATE public.projects SET project_name=p_name,status=p_status WHERE id=p_existing;
        IF NOT FOUND THEN RAISE EXCEPTION 'Project not found' USING ERRCODE='P0002'; END IF;
    END IF;
    PERFORM set_config('subtracker.project_import',coalesce(previous_context,''),true);
END;
$$;

REVOKE ALL ON FUNCTION public.import_project_without_classification(TEXT,TEXT,TEXT,INTEGER) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.import_project_without_classification(TEXT,TEXT,TEXT,INTEGER) TO authenticated;

CREATE FUNCTION public.require_project_public_works()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
    -- Only the permission-checked import RPC may leave imported data unclassified.
    IF NEW.public_works IS NULL AND NOT (
        coalesce(current_setting('subtracker.project_import',true),'')='on'
        AND current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
            WHERE oid='public.import_project_without_classification(text,text,text,integer)'::regprocedure)
    ) THEN
        RAISE EXCEPTION 'Select whether this is a Public Works project.' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.require_project_public_works() FROM PUBLIC,anon,authenticated;

CREATE TRIGGER projects_require_public_works_insert
BEFORE INSERT ON public.projects FOR EACH ROW EXECUTE FUNCTION public.require_project_public_works();
CREATE TRIGGER projects_require_public_works_edit
BEFORE UPDATE OF project_number,project_name,public_works ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.require_project_public_works();

COMMIT;
