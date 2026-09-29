BEGIN;

CREATE TABLE IF NOT EXISTS public.app_roles (
    role TEXT PRIMARY KEY,
    is_system BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.app_roles (role, is_system)
SELECT DISTINCT existing_roles.role, existing_roles.role IN ('Administrator', 'Compliance Manager', 'Project Manager', 'Read Only')
FROM (
    SELECT role FROM public.user_profiles
    UNION
    SELECT role FROM public.role_permissions
    UNION
    SELECT unnest(ARRAY['Administrator', 'Compliance Manager', 'Project Manager', 'Read Only'])
) AS existing_roles(role)
ON CONFLICT (role) DO UPDATE SET is_system = public.app_roles.is_system OR EXCLUDED.is_system;

ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_check;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS entra_object_id TEXT;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS entra_group_name TEXT;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS authentication_source TEXT NOT NULL DEFAULT 'Local';
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS system_administrator BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.user_profiles ADD COLUMN IF NOT EXISTS protected_user BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE public.user_profiles SET authentication_source = 'Local' WHERE authentication_source IS NULL;
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_authentication_source_check;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_authentication_source_check
    CHECK (authentication_source IN ('Local', 'Microsoft Entra ID'));
ALTER TABLE public.user_profiles DROP CONSTRAINT IF EXISTS user_profiles_role_app_roles_fkey;
ALTER TABLE public.user_profiles ADD CONSTRAINT user_profiles_role_app_roles_fkey
    FOREIGN KEY (role) REFERENCES public.app_roles(role) ON UPDATE CASCADE;

ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_check;
ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_module_check;
ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_role_app_roles_fkey;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_role_app_roles_fkey
    FOREIGN KEY (role) REFERENCES public.app_roles(role) ON UPDATE CASCADE ON DELETE CASCADE;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_module_check
    CHECK (module IN ('dashboard', 'contractors', 'compliance', 'insurance', 'followups', 'projects', 'tiered_subs', 'reports', 'imports', 'documents', 'activity', 'users', 'roles', 'audit', 'settings'));
ALTER TABLE public.role_permissions ADD COLUMN IF NOT EXISTS can_add BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.role_permissions ADD COLUMN IF NOT EXISTS can_edit BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.role_permissions ADD COLUMN IF NOT EXISTS can_delete BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE public.role_permissions
SET can_add = can_manage,
    can_edit = can_manage,
    can_delete = can_manage
WHERE can_manage AND NOT can_add AND NOT can_edit AND NOT can_delete;
ALTER TABLE public.role_permissions DROP CONSTRAINT IF EXISTS role_permissions_manage_check;
ALTER TABLE public.role_permissions ADD CONSTRAINT role_permissions_manage_check
    CHECK (can_manage = (can_add OR can_edit OR can_delete));

INSERT INTO public.role_permissions (role, module, can_view, can_manage, can_add, can_edit, can_delete)
SELECT
    role_name,
    module_name,
    role_name = 'Administrator'
        OR (role_name = 'Compliance Manager' AND module_name = ANY(ARRAY['dashboard', 'contractors', 'compliance', 'insurance', 'followups', 'projects', 'reports', 'imports']))
        OR (role_name IN ('Project Manager', 'Read Only') AND module_name = ANY(ARRAY['dashboard', 'contractors', 'compliance', 'insurance', 'followups', 'projects', 'tiered_subs', 'reports', 'imports', 'documents', 'activity'])),
    role_name = 'Administrator'
        OR (role_name = 'Compliance Manager' AND module_name = ANY(ARRAY['contractors', 'compliance', 'insurance', 'followups', 'projects', 'reports', 'imports'])),
    role_name = 'Administrator'
        OR (role_name = 'Compliance Manager' AND module_name = ANY(ARRAY['contractors', 'compliance', 'insurance', 'followups', 'projects', 'reports', 'imports'])),
    role_name = 'Administrator'
        OR (role_name = 'Compliance Manager' AND module_name = ANY(ARRAY['contractors', 'compliance', 'insurance', 'followups', 'projects', 'reports', 'imports'])),
    role_name = 'Administrator'
        OR (role_name = 'Compliance Manager' AND module_name = ANY(ARRAY['contractors', 'compliance', 'insurance', 'followups', 'projects', 'reports', 'imports']))
FROM (VALUES ('Administrator'), ('Compliance Manager'), ('Project Manager'), ('Read Only')) AS roles(role_name)
CROSS JOIN (VALUES
    ('dashboard'), ('contractors'), ('compliance'), ('insurance'), ('followups'), ('projects'), ('tiered_subs'), ('reports'),
    ('imports'), ('documents'), ('activity'), ('users'), ('roles'), ('audit'), ('settings')
) AS modules(module_name)
ON CONFLICT (role, module) DO NOTHING;

UPDATE public.role_permissions
SET can_view = TRUE, can_manage = TRUE, can_add = TRUE, can_edit = TRUE, can_delete = TRUE
WHERE role = 'Administrator';

INSERT INTO public.user_profiles (
    auth_user_id, name, email, role, status, authentication_source, system_administrator, protected_user
)
SELECT
    auth_user.id, 'Rich Gulino', 'richg@dobcogroup.com', 'Administrator', 'Active', 'Local', TRUE, TRUE
FROM auth.users AS auth_user
WHERE lower(auth_user.email) = 'richg@dobcogroup.com'
ON CONFLICT (auth_user_id) DO UPDATE
SET name = EXCLUDED.name,
    email = EXCLUDED.email,
    role = EXCLUDED.role,
    status = EXCLUDED.status,
    authentication_source = EXCLUDED.authentication_source,
    system_administrator = TRUE,
    protected_user = TRUE;

CREATE OR REPLACE FUNCTION public.user_has_module_permission(p_module TEXT, p_action TEXT DEFAULT 'view')
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.user_profiles AS profile
        JOIN public.role_permissions AS permission ON permission.role = profile.role
        WHERE profile.auth_user_id = auth.uid()
          AND profile.status = 'Active'
          AND permission.module = p_module
          AND CASE p_action
                WHEN 'view' THEN permission.can_view
                WHEN 'add' THEN permission.can_add
                WHEN 'edit' THEN permission.can_edit
                WHEN 'delete' THEN permission.can_delete
                WHEN 'manage' THEN permission.can_manage
                ELSE FALSE
              END
    );
$$;

DO $$
DECLARE
    table_row RECORD;
BEGIN
    FOR table_row IN
        SELECT * FROM (VALUES
            ('contractors', 'contractors'),
            ('contractor_insurance', 'insurance'),
            ('contractor_insurance_history', 'insurance'),
            ('projects', 'projects'),
            ('contractor_projects', 'projects'),
            ('contractor_tiered_subs', 'tiered_subs'),
            ('compliance_types', 'compliance'),
            ('compliance_records', 'compliance'),
            ('documents', 'documents'),
            ('activity_log', 'activity'),
            ('contractor_followups', 'followups'),
            ('reminders', 'compliance'),
            ('import_history', 'imports')
        ) AS tables(table_name, module_name)
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_row.table_name || '_role_select', table_row.table_name);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_row.table_name || '_role_insert', table_row.table_name);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_row.table_name || '_role_update', table_row.table_name);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', table_row.table_name || '_role_delete', table_row.table_name);
        EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.user_has_module_permission(%L, %L))', table_row.table_name || '_role_select', table_row.table_name, table_row.module_name, 'view');
        EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK (public.user_has_module_permission(%L, %L))', table_row.table_name || '_role_insert', table_row.table_name, table_row.module_name, 'add');
        EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING (public.user_has_module_permission(%L, %L)) WITH CHECK (public.user_has_module_permission(%L, %L))', table_row.table_name || '_role_update', table_row.table_name, table_row.module_name, 'edit', table_row.module_name, 'edit');
        EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING (public.user_has_module_permission(%L, %L))', table_row.table_name || '_role_delete', table_row.table_name, table_row.module_name, 'delete');
    END LOOP;
END;
$$;

ALTER TABLE public.app_roles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.app_roles FROM anon, authenticated;

COMMIT;
