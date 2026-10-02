-- =====================================================================
-- Import / Export module access control (IMPORT_EXPORT_ACCESS)
-- Date: 2026-10-02
--
-- The app-level module key for this permission is "imports" and is
-- enforced by canAccessModule(permissions, "imports") in the UI:
--   - AppSidebar hides the "Import / Export" navigation item
--   - AppShell blocks direct URL access to /imports
--
-- This migration guarantees every existing role has an "imports" row in
-- role_permissions so the permission is assignable through Role
-- Management for all roles (including roles created after the initial
-- system bootstrap, which only seeded rows present at bootstrap time).
--
-- Access rules:
--   - Administrator: full access (manage/add/edit/delete all true)
--   - All other roles: defaulted to NO access; grant View (+ optional
--     manage/add/edit/delete) per role via Admin > Roles & Permissions.
-- =====================================================================

BEGIN;

-- Full access for the Administrator role
INSERT INTO role_permissions (role, module, can_view, can_manage, can_add, can_edit, can_delete)
SELECT 'Administrator', 'imports', TRUE, TRUE, TRUE, TRUE, TRUE
WHERE NOT EXISTS (
    SELECT 1 FROM role_permissions WHERE role = 'Administrator' AND module = 'imports'
);

-- Default NO access rows for every other role missing the imports module
INSERT INTO role_permissions (role, module, can_view, can_manage, can_add, can_edit, can_delete)
SELECT DISTINCT rp.role, 'imports', FALSE, FALSE, FALSE, FALSE, FALSE
FROM role_permissions rp
WHERE rp.role <> 'Administrator'
  AND NOT EXISTS (
      SELECT 1 FROM role_permissions existing
      WHERE existing.role = rp.role AND existing.module = 'imports'
  );

-- Ensure the Administrator row itself grants full access even if it
-- already existed with reduced flags
UPDATE role_permissions
SET can_view = TRUE, can_manage = TRUE, can_add = TRUE, can_edit = TRUE, can_delete = TRUE
WHERE role = 'Administrator' AND module = 'imports';

COMMIT;

-- Review: current Import / Export access by role
SELECT role, can_view, can_manage, can_add, can_edit, can_delete
FROM role_permissions
WHERE module = 'imports'
ORDER BY role;
