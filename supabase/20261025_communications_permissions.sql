BEGIN;

ALTER TABLE public.role_permissions DROP CONSTRAINT role_permissions_module_check;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_module_check CHECK (module IN (
    'dashboard', 'contractors', 'compliance', 'insurance', 'followups', 'projects',
    'tiered_subs', 'reports', 'imports', 'documents', 'activity', 'users', 'roles',
    'audit', 'settings', 'compliance_sync',
    'communications_summary', 'communications_content', 'communications_delivery'
));

-- Preserve the established Administrator bootstrap; every other role starts denied.
INSERT INTO public.role_permissions (role, module, can_view, can_manage, can_add, can_edit, can_delete)
SELECT r.role, m.module, r.role = 'Administrator', r.role = 'Administrator',
    r.role = 'Administrator', r.role = 'Administrator', r.role = 'Administrator'
FROM public.app_roles r
CROSS JOIN (VALUES ('communications_summary'), ('communications_content'), ('communications_delivery')) m(module)
ON CONFLICT (role, module) DO NOTHING;

COMMIT;
