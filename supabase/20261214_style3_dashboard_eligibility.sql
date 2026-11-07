BEGIN;

CREATE OR REPLACE FUNCTION public.dashboard_nj_pwc_eligibility(p_after_id integer DEFAULT 0, p_limit integer DEFAULT 500)
RETURNS TABLE(contractor_id integer, company_name text, applicability text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT c.id, c.company_name::text,
           CASE public.nj_pwc_daily_contractor_eligible(c.id)
                WHEN true THEN 'applicable' WHEN false THEN 'not_applicable' ELSE 'unknown' END
    FROM public.contractors c
    WHERE c.active
      AND c.id > p_after_id
      AND EXISTS (
          SELECT 1 FROM public.contractor_projects cp
          JOIN public.projects p ON p.id = cp.project_id
          WHERE cp.contractor_id = c.id AND cp.active AND p.status = 'Active'
      )
    ORDER BY c.id
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 500), 1), 500);
$$;

REVOKE ALL ON FUNCTION public.dashboard_nj_pwc_eligibility(integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dashboard_nj_pwc_eligibility(integer, integer) TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
