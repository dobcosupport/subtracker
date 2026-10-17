import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => fs.readFileSync(path.join(root, "supabase", name), "utf8");
const db = await PGlite.create();
const migration = read("20261024_dobco_contacts.sql");
const fails = async (sql, code) => assert.rejects(db.exec(sql), (error) => error.code === code, sql);
const actor = (id) => `SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-${String(id).padStart(12, "0")}',false)`;
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    GRANT USAGE ON SCHEMA auth TO authenticated,anon;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY, name text, email text, role text, status text);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean,can_delete boolean);
    INSERT INTO user_profiles VALUES
      ('00000000-0000-0000-0000-000000000001','Synthetic Admin','admin@example.invalid','Admin','Active'),
      ('00000000-0000-0000-0000-000000000002','Synthetic Viewer','viewer@example.invalid','Viewer','Active'),
      ('00000000-0000-0000-0000-000000000003','Synthetic No Access','none@example.invalid','None','Active'),
      ('00000000-0000-0000-0000-000000000004','Synthetic Inactive','inactive@example.invalid','Admin','Inactive');
    INSERT INTO role_permissions VALUES
      ('Admin','settings',true,true,true,true,true),
      ('Viewer','settings',true,false,false,false,false),
      ('None','settings',false,false,false,false,false);
  `);
  const history = read("20260929_user_management_enhancements.sql");
  const start = history.indexOf("CREATE OR REPLACE FUNCTION public.user_has_module_permission");
  await db.exec(history.slice(start, history.indexOf("$$;", start) + 3));
  const snapshot = async () => (await db.query(`
    SELECT
      (SELECT jsonb_agg(to_jsonb(u) ORDER BY auth_user_id) FROM user_profiles u) AS users,
      (SELECT jsonb_agg(to_jsonb(c) ORDER BY ordinal_position) FROM information_schema.columns c WHERE table_name='user_profiles') AS columns,
      (SELECT jsonb_agg(to_jsonb(p)) FROM role_permissions p) AS permissions
  `)).rows[0];
  const before = await snapshot();
  assert.doesNotMatch(migration, /audit_application_change|ALTER TABLE public\.user_profiles|\b(?:UPDATE\s+public\.user_profiles|INSERT INTO\s+public\.user_profiles|DELETE FROM)\b/i);
  const forcedFailure = migration.replace(/COMMIT;\s*$/, "SELECT 1 / 0;\nCOMMIT;");
  await fails(forcedFailure, "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('public.dobco_contacts') AS contacts")).rows[0].contacts, null);
  await db.exec(migration);
  assert.deepEqual(await snapshot(), before, "Migration cannot modify user schema, records, or permissions");
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM dobco_contacts")).rows[0].n, 0, "No automatic user migration");
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE oid='dobco_contacts'::regclass")).rows[0].relrowsecurity, true);
  await db.exec(`SET ROLE service_role; INSERT INTO dobco_contacts(contact_name,mobile_phone) VALUES ('Synthetic Contact','555 0100'); RESET ROLE;`);
  let contact = (await db.query("SELECT * FROM dobco_contacts")).rows[0];
  assert.equal(contact.user_profile_id, null);
  assert.equal(contact.email, null);
  assert.equal(contact.is_active, true);
  assert.equal(contact.receives_internal_email, false);
  assert.equal(contact.receives_internal_sms, false);
  assert.equal(contact.sms_consent_recorded, false);
  assert.equal(contact.sms_consent_date, null);
  assert.equal(contact.sms_consent_source_or_note, null);
  assert.ok(contact.id && contact.created_at && contact.updated_at);
  for (const id of [1, 2]) {
    await db.exec(`SET ROLE authenticated; ${actor(id)};`);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM dobco_contacts")).rows[0].n, 1);
    await fails("INSERT INTO dobco_contacts(contact_name) VALUES ('Denied')", "42501");
    await fails("UPDATE dobco_contacts SET is_active=false", "42501");
    await fails("DELETE FROM dobco_contacts", "42501");
    await db.exec("RESET ROLE");
  }
  for (const id of [3, 4]) {
    await db.exec(`SET ROLE authenticated; ${actor(id)};`);
    assert.equal((await db.query("SELECT count(*)::integer AS n FROM dobco_contacts")).rows[0].n, 0);
    await db.exec("RESET ROLE");
  }
  await db.exec("SET ROLE anon");
  await fails("SELECT * FROM dobco_contacts", "42501");
  await fails("INSERT INTO dobco_contacts(contact_name) VALUES ('Denied')", "42501");
  await db.exec("RESET ROLE");
  await fails("INSERT INTO dobco_contacts(contact_name) VALUES ('   ')", "23514");
  await fails("INSERT INTO dobco_contacts(contact_name,user_profile_id) VALUES ('Invalid Link','00000000-0000-0000-0000-000000000099')", "23503");
  await db.exec(`UPDATE dobco_contacts SET user_profile_id='00000000-0000-0000-0000-000000000002',
    email='contact@example.invalid',receives_internal_email=true,receives_internal_sms=true,sms_consent_recorded=true,
    sms_consent_date='2026-10-17',sms_consent_source_or_note='Explicit synthetic consent';`);
  const eligibility = async () => (await db.query(`SELECT
    is_active AND nullif(btrim(email),'') IS NOT NULL AND receives_internal_email AS email,
    is_active AND nullif(btrim(mobile_phone),'') IS NOT NULL AND receives_internal_sms AND sms_consent_recorded AS sms
    FROM dobco_contacts`)).rows[0];
  assert.deepEqual(await eligibility(), { email: true, sms: true });
  await db.exec("SET ROLE service_role; UPDATE dobco_contacts SET is_active=false; RESET ROLE;");
  assert.deepEqual(await eligibility(), { email: false, sms: false });
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM dobco_contacts")).rows[0].n, 1);
  contact = (await db.query("SELECT * FROM dobco_contacts")).rows[0];
  assert.equal(contact.sms_consent_recorded, true, "Deactivation preserves saved consent and preferences");
  await db.exec("SET ROLE service_role; UPDATE dobco_contacts SET is_active=true; RESET ROLE;");
  assert.deepEqual(await eligibility(), { email: true, sms: true });
  assert.deepEqual(await snapshot(), before, "Contact changes never change user identities or account status");
  await db.exec("DELETE FROM user_profiles WHERE auth_user_id='00000000-0000-0000-0000-000000000002'");
  assert.equal((await db.query("SELECT user_profile_id FROM dobco_contacts")).rows[0].user_profile_id, null, "Optional link does not block existing user deletion");
  assert.equal((await db.query("SELECT count(*)::integer AS n FROM dobco_contacts")).rows[0].n, 1, "Deleting a user does not delete the contact");
  await db.exec("SET ROLE service_role");
  await fails("DELETE FROM dobco_contacts", "42501");
  await db.exec("RESET ROLE");
  console.log("PASS: isolated PostgreSQL migration rollback, standalone defaults, optional FK, unchanged users, RLS, server-only writes, no delete, status/consent persistence and eligibility.");
} finally {
  await db.close();
}
