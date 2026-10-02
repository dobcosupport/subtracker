-- =====================================================================
-- Guarantee Administrator full access to the Compliance Sync module
-- Date: 2026-10-2
--
-- Safety-net migration: ensures the Administrator system role always
-- has full access to the compliance_sync module, covering databases
-- where the module was added after the initial bootstrap or where the
-- Administrator row was created with reduced flags.
--
-- Permission mapping (COMPLIANCE_SYNC_*):
--   VIEW     -> can_view   (see the module, open /admin/compliance-sync)
--   MANAGE   -> can_manage (run/manage sync operations)
--   APPROVE  -> can_edit   (approve/reject review-queue entries)
--   SETTINGS -> can_delete (change per-type sync settings)
-- Approve and Settings are management-level operations, so all four map
-- onto the standard role_permissions flags, all set to TRUE for
-- Administrator.
--
-- Idempotent: safe to run multiple times.
-- =====================================================================

BEGIN;

-- Ensure the module is allowed by the CHECK constraint (no-op if present)
ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_module_check;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_module_check
    CHECK (module IN ('dashboard', 'contractors', 'compliance', 'insurance', 'followups', 'projects', 'tiered_subs', 'reports', 'imports', 'documents', 'activity', 'users', 'roles', 'audit', 'settings', 'compliance_sync'));

-- Grant Administrator full access (insert if missing, else force full)
INSERT INTO public.role_permissions (role, module, can_view, can_manage, can_add, can_edit, can_delete)
VALUES ('Administrator', 'compliance_sync', TRUE, TRUE, TRUE, TRUE, TRUE)
ON CONFLICT (role, module) DO UPDATE
SET can_view = TRUE, can_manage = TRUE, can_add = TRUE, can_edit = TRUE, can_delete = TRUE;

COMMIT;

-- Verify
SELECT role, module, can_view, can_manage, can_add, can_edit, can_delete
FROM public.role_permissions
WHERE module = 'compliance_sync'
ORDER BY role;
