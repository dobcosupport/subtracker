BEGIN;

DROP POLICY IF EXISTS contractor_followups_role_update
    ON public.contractor_followups;

CREATE POLICY contractor_followups_role_update
    ON public.contractor_followups
    FOR UPDATE
    TO authenticated
    USING (public.user_has_module_permission('followups', 'edit'))
    WITH CHECK (public.user_has_module_permission('followups', 'edit'));

COMMIT;
