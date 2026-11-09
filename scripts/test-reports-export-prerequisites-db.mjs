import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const read = (file) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const historical = read("supabase/20261008_saved_export_templates.sql");
const migration = read("supabase/20261215_reports_export_template_prerequisites.sql");
const registry = [...read("src/lib/custom-export.ts").split("export const EXPORT_FIELDS")[1]
  .split("type ExportContractor")[0].matchAll(/id: "([^"]+)"/g)].map(match => match[1]);
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const body = (source, name) => source.match(new RegExp(
  `CREATE (?:OR REPLACE )?FUNCTION public\\.${name}\\([\\s\\S]*?AS \\$\\$([\\s\\S]*?)\\$\\$;`,
))[1];

test("Reports template prerequisites in isolated PostgreSQL with enforced authenticated RLS", async t => {
  const db = await PGlite.create();
  const rows = async (sql, args = []) => (await db.query(sql, args)).rows;
  const actor = async n => {
    await db.exec("RESET ROLE");
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)", [n === null ? "" : id(n)]);
    await db.exec("SET ROLE authenticated");
  };
  const snapshot = async () => {
    const result = {};
    for (const table of ["export_templates", "export_template_user_preferences", "contractors", "compliance_records", "projects", "mycoi_policies"]) {
      result[table] = await rows(`SELECT to_jsonb(t) data FROM ${table} t ORDER BY to_jsonb(t)::text`);
    }
    return result;
  };
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid
      $$;
      GRANT USAGE ON SCHEMA public,auth TO authenticated,anon;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text);
      CREATE TABLE app_roles(role text PRIMARY KEY);
      CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id),
        name text,email text,role text,status text,system_administrator boolean DEFAULT false);
      GRANT SELECT ON user_profiles TO authenticated;
      CREATE TABLE role_permissions(role text,module text,can_view boolean DEFAULT false,
        can_manage boolean DEFAULT false,can_add boolean DEFAULT false,can_edit boolean DEFAULT false,can_delete boolean DEFAULT false);
      CREATE FUNCTION public.user_has_module_permission(p_module text,p_action text DEFAULT 'view')
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
        SELECT EXISTS (
          SELECT 1 FROM public.user_profiles profile JOIN public.role_permissions permission ON permission.role=profile.role
          WHERE profile.auth_user_id=auth.uid() AND profile.status='Active' AND permission.module=p_module
          AND CASE p_action WHEN 'view' THEN permission.can_view WHEN 'add' THEN permission.can_add
            WHEN 'edit' THEN permission.can_edit WHEN 'delete' THEN permission.can_delete
            WHEN 'manage' THEN permission.can_manage ELSE false END)
      $$;
    `);
    await db.exec(historical);
    await t.test("existing Dashboard/Imports SQL regressions pass before migration", async () => {
      await db.exec(read("supabase/tests/saved_export_templates.sql"));
    });
    await db.exec(`
      INSERT INTO app_roles VALUES('Reports Only'),('No Access');
      INSERT INTO auth.users(id,email) VALUES('${id(1)}','reports@example.invalid'),('${id(2)}','other@example.invalid');
      INSERT INTO user_profiles VALUES
        ('${id(1)}','Reports User','reports@example.invalid','Reports Only','Active',false),
        ('${id(2)}','Other User','other@example.invalid','No Access','Active',false);
      INSERT INTO role_permissions(role,module,can_view) VALUES('Reports Only','reports',true);
      INSERT INTO export_templates(id,name,field_ids,owner_user_id,active,visibility) VALUES
        ('${id(11)}','Owned active',ARRAY['contractor_name'],'${id(1)}',true,'private'),
        ('${id(12)}','Other private',ARRAY['contractor_name'],'${id(2)}',true,'private'),
        ('${id(13)}','Shared active',ARRAY['contractor_name'],'${id(2)}',true,'shared'),
        ('${id(14)}','Owned inactive',ARRAY['contractor_name'],'${id(1)}',false,'private'),
        ('${id(15)}','Shared inactive',ARRAY['contractor_name'],'${id(2)}',false,'shared');
      INSERT INTO export_template_user_preferences(user_id,template_id,is_favorite,is_default) VALUES
        ('${id(1)}','${id(11)}',true,true),('${id(2)}','${id(13)}',true,true);
    `);
    for (const table of ["contractors", "compliance_records", "projects", "mycoi_policies"]) {
      const permissionModule = { contractors: "contractors", compliance_records: "compliance", projects: "projects", mycoi_policies: "insurance" }[table];
      await db.exec(`CREATE TABLE ${table}(id integer PRIMARY KEY,value text);
        INSERT INTO ${table} VALUES(1,'Synthetic restricted data');
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        GRANT SELECT ON ${table} TO authenticated;
        CREATE POLICY data_access ON ${table} FOR SELECT TO authenticated
          USING(public.user_has_module_permission('${permissionModule}','view'));`);
    }
    const policySnapshot = () => rows("SELECT tablename,policyname,cmd,qual,with_check FROM pg_policies ORDER BY tablename,policyname");
    const before = await snapshot();
    const policiesBefore = await policySnapshot();
    const aclBefore = await rows(`SELECT proname,proacl::text,prosecdef,proconfig FROM pg_proc
      WHERE proname IN ('validate_export_template','export_template_can_read','set_export_template_preference')
      ORDER BY proname`);
    await t.test("migration executes and preserves templates, preferences, data and unrelated policies/grants", async () => {
      await db.exec(migration);
      assert.deepEqual(await snapshot(), before);
      assert.deepEqual((await policySnapshot()).filter(p => p.policyname !== "export_preferences_select"),
        policiesBefore.filter(p => p.policyname !== "export_preferences_select"));
      assert.deepEqual(await rows(`SELECT proname,proacl::text,prosecdef,proconfig FROM pg_proc
        WHERE proname IN ('validate_export_template','export_template_can_read','set_export_template_preference')
        ORDER BY proname`), aclBefore);
      assert.equal(body(migration, "validate_export_template").replace("'sage_erp_id','federal_tax_id'", "'sage_erp_id'"),
        body(historical, "validate_export_template"), "All other validator logic is byte-identical");
      const allowed = [...body(migration, "validate_export_template").match(/allowed TEXT\[\] := ARRAY\[([\s\S]*?)\];/)[1]
        .matchAll(/'([^']+)'/g)].map(m => m[1]);
      assert.equal(registry.length, 38);
      assert.deepEqual(allowed, registry);
      const constraint = (await rows(`SELECT pg_get_constraintdef(oid) definition FROM pg_constraint
        WHERE conrelid='public.export_templates'::regclass AND conname='export_templates_field_ids_check'`))[0].definition;
      assert.match(constraint, /cardinality\(field_ids\) >= 1/);
      assert.match(constraint, /cardinality\(field_ids\) <= 38/);
    });
    await t.test("FEIN and all 38 fields save; invalid, 39th, duplicate and null fields reject", async () => {
      // Management remains Imports-only; the export validator is tested as an existing manager.
      await db.exec(`INSERT INTO role_permissions(role,module,can_view,can_add,can_edit,can_delete)
        VALUES('Reports Only','imports',true,true,true,true)`);
      await actor(1);
      for (const fields of [["federal_tax_id"], registry]) {
        const saved = await rows("INSERT INTO export_templates(name,field_ids) VALUES('Valid',$1) RETURNING field_ids", [fields]);
        assert.deepEqual(saved[0].field_ids, fields);
      }
      for (const fields of [["invalid"], [...registry, "invalid"], ["contractor_name", "contractor_name"], [null], []]) {
        await assert.rejects(rows("INSERT INTO export_templates(name,field_ids) VALUES('Invalid',$1)", [fields]),
          /Unsupported|duplicate|check constraint/);
      }
      await db.exec("RESET ROLE");
      await db.exec("DELETE FROM role_permissions WHERE module='imports' AND role='Reports Only'");
    });
    await t.test("Reports-only reads owned/shared active templates, never other private or inactive templates", async () => {
      await actor(1);
      const visible = await rows("SELECT id FROM export_templates");
      for (const n of [11, 13]) assert.ok(visible.some(r => r.id === id(n)));
      for (const n of [12, 14, 15]) assert.ok(!visible.some(r => r.id === id(n)));
      assert.equal((await rows("SELECT count(*)::int n FROM export_templates WHERE is_system"))[0].n, 2);
      const runnable = await rows("SELECT field_ids,default_format,default_scope,configuration_version FROM export_templates WHERE id=$1", [id(11)]);
      assert.deepEqual(runnable, [{ field_ids: ["contractor_name"], default_format: "xlsx",
        default_scope: "filtered", configuration_version: 1 }], "Reports receives the unchanged configuration used by the existing client-side runner");
      assert.equal((await rows("SELECT export_template_admin() allowed"))[0].allowed, false);
      for (const action of ["view", "add", "edit", "delete", "manage"]) {
        assert.equal((await rows("SELECT export_template_permission('imports',$1) allowed", [action]))[0].allowed, false);
      }
    });
    await t.test("Reports-only cannot create, edit, delete, publish or administer templates", async () => {
      await assert.rejects(rows("INSERT INTO export_templates(name,field_ids) VALUES('Denied',ARRAY['contractor_name'])"), /row-level security/);
      for (const sql of [
        "UPDATE export_templates SET name='Denied' RETURNING id",
        "UPDATE export_templates SET visibility='shared' RETURNING id",
        "UPDATE export_templates SET owner_user_id=auth.uid() RETURNING id",
        "DELETE FROM export_templates RETURNING id",
      ]) assert.deepEqual(await rows(sql), []);
    });
    await t.test("Reports preferences are user-scoped with one default and inaccessible/inactive guards", async () => {
      await rows("SELECT set_export_template_preference($1,true,true)", [id(13)]);
      const preferences = await rows("SELECT * FROM export_template_user_preferences");
      assert.ok(preferences.every(p => p.user_id === id(1)));
      assert.equal(preferences.filter(p => p.is_default).length, 1);
      assert.equal(preferences.find(p => p.template_id === id(11)).is_default, false);
      for (const n of [12, 14, 15]) {
        await assert.rejects(rows("SELECT set_export_template_preference($1,true,true)", [id(n)]), /inactive or inaccessible/);
      }
      await assert.rejects(rows("SELECT set_export_template_preference($1,null,true)", [id(13)]), /Invalid preference/);
      for (const sql of [
        `INSERT INTO export_template_user_preferences(user_id,template_id) VALUES('${id(2)}','${id(11)}')`,
        "UPDATE export_template_user_preferences SET is_favorite=false",
        "DELETE FROM export_template_user_preferences",
      ]) await assert.rejects(rows(sql), /permission denied/);
      await db.exec("RESET ROLE");
      assert.deepEqual(await rows("SELECT to_jsonb(p) data FROM export_template_user_preferences p WHERE user_id=$1", [id(2)]),
        before.export_template_user_preferences.filter(p => p.data.user_id === id(2)));
    });
    await t.test("template access never expands underlying export-data RLS", async () => {
      await actor(1);
      for (const table of ["contractors", "compliance_records", "projects", "mycoi_policies"]) {
        assert.deepEqual(await rows(`SELECT * FROM ${table}`), []);
      }
    });
    await t.test("no-permission, inactive, null-identity and anonymous actors stay denied", async () => {
      await actor(2);
      assert.deepEqual(await rows("SELECT * FROM export_templates"), []);
      assert.deepEqual(await rows("SELECT * FROM export_template_user_preferences"), []);
      await assert.rejects(rows("SELECT set_export_template_preference($1,true,true)", [id(13)]), /Template access is required/);
      await db.exec("RESET ROLE");
      await db.exec(`UPDATE user_profiles SET status='Inactive' WHERE auth_user_id='${id(1)}'`);
      await actor(1);
      assert.deepEqual(await rows("SELECT * FROM export_templates"), []);
      await assert.rejects(rows("SELECT set_export_template_preference($1,true,true)", [id(13)]), /Template access is required/);
      await actor(null);
      await assert.rejects(rows("SELECT set_export_template_preference($1,true,true)", [id(13)]), /Template access is required/);
      await db.exec("RESET ROLE; SET ROLE anon");
      await assert.rejects(rows("SELECT * FROM export_templates"), /permission denied/);
      await assert.rejects(rows("SELECT set_export_template_preference($1,true,true)", [id(13)]), /permission denied/);
      await db.exec("RESET ROLE");
      await db.exec(`UPDATE user_profiles SET status='Active' WHERE auth_user_id='${id(1)}'`);
    });
    await t.test("existing Dashboard/Imports/admin regressions still pass after migration", async () => {
      await db.query("SELECT set_config('request.jwt.claim.sub','',false)");
      await db.exec("BEGIN; TRUNCATE export_template_user_preferences; DELETE FROM export_templates WHERE NOT is_system; COMMIT;");
      await db.exec(read("supabase/tests/saved_export_templates.sql"));
    });
  } finally {
    await db.close();
  }
});
