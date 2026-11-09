-- Local prerequisite only. No changes to requirement data or data-access policies.
BEGIN;

-- Kept in exact parity with NJ_PWC_EXCLUSIONS by the foundation regression suite.
CREATE FUNCTION public.nj_pwc_assignment_reason(
    p_contractor_active boolean, p_company_name text, p_material_only boolean,
    p_assignment_active boolean, p_project_status text, p_public_works boolean
)
RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT CASE
        WHEN p_contractor_active IS DISTINCT FROM TRUE THEN 'contractor_inactive'
        WHEN nullif(btrim(p_company_name), '') IS NULL THEN 'invalid_company'
        WHEN p_material_only IS DISTINCT FROM FALSE THEN 'material_only'
        WHEN p_assignment_active IS DISTINCT FROM TRUE THEN 'assignment_inactive'
        WHEN p_project_status IS DISTINCT FROM 'Active' THEN 'project_inactive'
        WHEN p_public_works IS DISTINCT FROM TRUE THEN 'not_public_works'
        ELSE 'eligible'
    END;
$$;

CREATE FUNCTION public.nj_pwc_assignment_qualifies(
    p_contractor_active boolean, p_company_name text, p_material_only boolean,
    p_assignment_active boolean, p_project_status text, p_public_works boolean
)
RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
    SELECT public.nj_pwc_assignment_reason(p_contractor_active,p_company_name,p_material_only,
        p_assignment_active,p_project_status,p_public_works) = 'eligible';
$$;

-- Preserve the existing any-qualifying-project monitoring authority exactly.
CREATE OR REPLACE FUNCTION public.nj_pwc_daily_contractor_eligible(p_contractor_id INTEGER)
RETURNS BOOLEAN
LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.contractors c
        JOIN public.contractor_projects cp ON cp.contractor_id = c.id
        JOIN public.projects p ON p.id = cp.project_id
        WHERE c.id = p_contractor_id
          AND public.nj_pwc_assignment_qualifies(
              c.active, c.company_name, c.material_vendor_only,
              cp.active, p.status, p.public_works
          )
    );
$$;

-- Invoker rights deliberately preserve contractor, project and assignment RLS.
CREATE FUNCTION public.project_nj_pwc_eligibility(p_project_id integer, p_contractor_ids integer[])
RETURNS TABLE(contractor_id integer, project_id integer, applicable boolean)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public, pg_temp AS $$
    SELECT c.id, p.id, EXISTS (
        SELECT 1 FROM public.contractor_projects cp
        WHERE cp.contractor_id = c.id AND cp.project_id = p.id
          AND public.nj_pwc_assignment_qualifies(
              c.active, c.company_name, c.material_vendor_only,
              cp.active, p.status, p.public_works
          )
    )
    FROM public.contractors c
    CROSS JOIN public.projects p
    WHERE c.id = ANY(p_contractor_ids) AND p.id = p_project_id
    ORDER BY c.id;
$$;

REVOKE ALL ON FUNCTION public.nj_pwc_assignment_qualifies(boolean,text,boolean,boolean,text,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.nj_pwc_assignment_reason(boolean,text,boolean,boolean,text,boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.project_nj_pwc_eligibility(integer,integer[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.nj_pwc_assignment_qualifies(boolean,text,boolean,boolean,text,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nj_pwc_assignment_reason(boolean,text,boolean,boolean,text,boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.project_nj_pwc_eligibility(integer,integer[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
