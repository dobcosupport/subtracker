-- Read-only production inspection. This does not apply the myCOI migration.
-- Run the entire file and export the single investigation JSON result.
WITH relevant_triggers AS (
    SELECT
        ns.nspname AS table_schema,
        c.relname AS table_name,
        t.tgname AS trigger_name,
        pg_get_triggerdef(t.oid, true) AS definition,
        t.tgfoid AS function_oid,
        t.tgenabled AS enabled
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    WHERE NOT t.tgisinternal
      AND ns.nspname = 'public'
),
relevant_functions AS (
    SELECT
        p.oid,
        ns.nspname AS schema_name,
        p.proname AS function_name,
        pg_get_function_identity_arguments(p.oid) AS identity_arguments,
        pg_get_function_arguments(p.oid) AS arguments,
        pg_get_function_result(p.oid) AS return_type,
        p.prosecdef AS security_definer,
        p.provolatile AS volatility,
        p.proacl::text AS privileges,
        pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE p.prokind = 'f'
      AND (
          (
              ns.nspname NOT IN ('pg_catalog', 'information_schema')
              AND (
                  p.proname ILIKE '%audit%'
                  OR p.proname ILIKE 'mycoi%'
                  OR p.proname = 'user_has_module_permission'
              )
          )
          OR p.oid IN (SELECT function_oid FROM relevant_triggers)
      )
)
SELECT jsonb_build_object(
    'mycoi_relations',
    COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'schema', ns.nspname,
                'name', c.relname,
                'kind', c.relkind,
                'rls', c.relrowsecurity
            )
            ORDER BY ns.nspname, c.relname
        )
        FROM pg_class c
        JOIN pg_namespace ns ON ns.oid = c.relnamespace
        WHERE ns.nspname = 'public'
          AND c.relname ILIKE '%mycoi%'
    ), '[]'::jsonb),
    'mycoi_policies',
    COALESCE((
        SELECT jsonb_agg(to_jsonb(p) ORDER BY p.tablename, p.policyname)
        FROM pg_policies p
        WHERE p.schemaname = 'public'
          AND (
              p.tablename ILIKE '%mycoi%'
              OR p.policyname ILIKE '%mycoi%'
          )
    ), '[]'::jsonb),
    'triggers',
    COALESCE((
        SELECT jsonb_agg(to_jsonb(t) ORDER BY table_name, trigger_name)
        FROM relevant_triggers t
    ), '[]'::jsonb),
    'functions',
    COALESCE((
        SELECT jsonb_agg(to_jsonb(f) ORDER BY schema_name, function_name, identity_arguments)
        FROM relevant_functions f
    ), '[]'::jsonb),
    'prerequisite_columns',
    COALESCE((
        SELECT jsonb_agg(to_jsonb(c) ORDER BY table_name, ordinal_position)
        FROM (
            SELECT
                table_schema,
                table_name,
                column_name,
                data_type,
                udt_schema,
                udt_name,
                is_nullable,
                column_default,
                ordinal_position
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name IN (
                  'contractors',
                  'projects',
                  'import_history',
                  'administration_audit_log',
                  'user_profiles',
                  'role_permissions'
              )
        ) c
    ), '[]'::jsonb),
    'prerequisite_constraints',
    COALESCE((
        SELECT jsonb_agg(
            jsonb_build_object(
                'table', c.conrelid::regclass::text,
                'name', c.conname,
                'definition', pg_get_constraintdef(c.oid, true)
            )
            ORDER BY c.conrelid::regclass::text, c.conname
        )
        FROM pg_constraint c
        WHERE c.conrelid IN (
            to_regclass('public.contractors'),
            to_regclass('public.projects'),
            to_regclass('public.import_history'),
            to_regclass('public.administration_audit_log')
        )
    ), '[]'::jsonb)
) AS investigation;
