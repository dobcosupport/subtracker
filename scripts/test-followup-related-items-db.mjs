import fs from "node:fs";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => fs.readFileSync(`${root}\\${file}`, "utf8");
const functionSql = (source, name) => {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  assert.ok(start >= 0);
  return source.slice(start, source.indexOf("$$;", start) + 3);
};
(async () => {
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE ROLE authenticated; CREATE ROLE anon;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid$$;
      GRANT USAGE ON SCHEMA auth TO authenticated, anon;
      CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY, role text, status text, name text, email text);
      CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean,can_delete boolean);
      INSERT INTO user_profiles VALUES
        ('00000000-0000-0000-0000-000000000001','Editor','Active','Editor','editor@example.invalid'),
        ('00000000-0000-0000-0000-000000000002','Viewer','Active','Viewer','viewer@example.invalid'),
        ('00000000-0000-0000-0000-000000000003','Editor','Inactive','Inactive','inactive@example.invalid');
      INSERT INTO role_permissions VALUES
        ('Editor','followups',true,true,true,true,false),
        ('Viewer','followups',true,true,true,false,false);
      CREATE TABLE contractors(id integer PRIMARY KEY);
      INSERT INTO contractors VALUES(8),(9);
      CREATE TABLE compliance_types(id integer PRIMARY KEY, compliance_name text, active boolean);
      INSERT INTO compliance_types VALUES (6,'NJ PWC',true),(7,'NJ BRC',true),(8,'NY PWC',true),(9,'NY BRC',true),(3,'W9',true),(5,'Safety Certification',true);
      CREATE TABLE compliance_records(id integer PRIMARY KEY,contractor_id integer,compliance_type_id integer,active boolean);
      INSERT INTO compliance_records VALUES(100,8,6,false),(101,8,6,true),(200,9,7,true);
      CREATE TABLE administration_audit_log(
        user_id uuid,user_name text,user_email text,action text,object_type text,object_id text,object_label text,details jsonb);
    `);
    await db.exec(functionSql(read("supabase\\20260929_user_management_enhancements.sql"), "user_has_module_permission"));
    await db.exec(read("supabase\\20260924_contractor_followups.sql"));
    await db.exec(read("supabase\\20261008_contractor_followups_update_policy.sql"));
    await db.exec(functionSql(read("supabase\\20260929_user_management.sql"), "audit_application_change"));
    await db.exec(`
      CREATE TRIGGER audit_followup_changes AFTER INSERT OR UPDATE OR DELETE ON contractor_followups
        FOR EACH ROW EXECUTE FUNCTION audit_application_change();
      INSERT INTO contractor_followups(id,contractor_id,compliance_record_id,followup_date,followup_method,subject,status)
        VALUES(5,8,100,'2026-10-08','Email','Legacy record','Open');
      SELECT setval('contractor_followups_id_seq',5);
      GRANT SELECT,INSERT,UPDATE ON contractor_followups TO authenticated;
      GRANT SELECT,UPDATE ON contractor_followups TO anon;
      GRANT USAGE ON SEQUENCE contractor_followups_id_seq TO authenticated;
      GRANT SELECT ON compliance_records,compliance_types TO authenticated;
      CREATE TEMP TABLE before_related_items AS SELECT
        (SELECT jsonb_agg(to_jsonb(p) ORDER BY policyname) FROM pg_policies p WHERE schemaname='public' AND tablename='contractor_followups') AS policies,
        (SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname='audit_followup_changes') AS audit_trigger;
    `);
    const before = (await db.query("SELECT * FROM contractor_followups WHERE id=5")).rows[0];
    await db.exec(read("supabase\\20261008_followup_related_items.sql"));
    const after = (await db.query("SELECT * FROM contractor_followups WHERE id=5")).rows[0];
    assert.deepEqual(after, { ...before, compliance_type_id: null, insurance_item_key: null });
    await db.exec(read("supabase\\tests\\followup_related_items.sql"));
    console.log("PASS: production migration, no backfill, all categories, legacy derivation, historical/current links, clearing links, constraints, foreign key RESTRICT");
    console.log("PASS: granular RLS blocks non-editors, inactive users, anonymous; policy catalog and audit trigger identical");
    console.log("PASS: unchanged production audit function records INSERT/UPDATE and new relationship field names");
    await db.exec(`
      ALTER TABLE compliance_records ENABLE ROW LEVEL SECURITY;
      CREATE POLICY visible_records ON compliance_records FOR SELECT TO authenticated USING (id <> 100);
      BEGIN; SET LOCAL ROLE authenticated;
      SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true);
    `);
    const result = await db.query("UPDATE contractor_followups SET status='Closed' WHERE id=5 RETURNING compliance_record_id,compliance_type_id");
    assert.deepEqual(result.rows, [{ compliance_record_id: 100, compliance_type_id: null }]);
    await db.exec(`
      DO $$
      BEGIN
        BEGIN
          UPDATE contractor_followups SET compliance_type_id = 6 WHERE id = 5;
          RAISE EXCEPTION 'New inaccessible relationship accepted';
        EXCEPTION WHEN check_violation THEN NULL;
        END;
      END;
      $$;
    `);
    await db.exec("ROLLBACK");
    console.log("PASS: unchanged invisible legacy record remains editable; new inaccessible links fail explicitly");
    const auditCount = (await db.query("SELECT count(*)::integer AS count FROM administration_audit_log")).rows[0].count;
    assert.equal(auditCount, 0, "SQL acceptance transaction rolls back all writes and audit rows");
  } finally { await db.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
