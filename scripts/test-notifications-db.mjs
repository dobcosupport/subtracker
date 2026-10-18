import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = await PGlite.create();
const read = (name) => fs.readFileSync(new URL(`../supabase/${name}`, import.meta.url), "utf8");
const actor = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const quote = (input) => `'${JSON.stringify(input).replaceAll("'", "''")}'::jsonb`;
const fails = (sql, code) => assert.rejects(db.exec(sql), (error) => error.code === code, sql);
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,system_administrator boolean DEFAULT false);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_manage boolean,can_add boolean,can_edit boolean,can_delete boolean);
    INSERT INTO user_profiles VALUES
      ('${actor(1)}','Manager','Active',false),('${actor(2)}','Viewer','Active',false),
      ('${actor(3)}','Manager','Inactive',false),('${actor(4)}','Admin','Active',true),
      ('${actor(5)}','Content','Active',false);
    INSERT INTO role_permissions VALUES
      ('Manager','settings',true,true,false,false,false),('Viewer','settings',true,false,false,false,false),
      ('Content','communications_content',true,true,true,true,false);
    CREATE TABLE communication_channel_settings(channel text PRIMARY KEY,provider text,enabled boolean DEFAULT false,
      automated_enabled boolean NOT NULL DEFAULT false,from_address text,sending_phone_number text,
      revision integer NOT NULL DEFAULT 1,updated_at timestamptz DEFAULT now(),updated_by uuid REFERENCES user_profiles);
    INSERT INTO communication_channel_settings(channel,provider,from_address,sending_phone_number)
      VALUES('email','azure_communication_services','portable@example.invalid',null),('sms','twilio',null,'+15555550100');
    GRANT SELECT ON communication_channel_settings TO service_role;
    CREATE TABLE communication_messages(id integer PRIMARY KEY,body text,status text);
    INSERT INTO communication_messages VALUES(1,'Existing Draft','Draft');
    CREATE TABLE contractor_followups(id integer PRIMARY KEY,subject text,status text);
    INSERT INTO contractor_followups VALUES(1,'Existing Follow-Up','Open');
    CREATE TABLE activity_log(id integer PRIMARY KEY,notes text);
    INSERT INTO activity_log VALUES(1,'Existing Activity');
  `);
  const foundation = read("20261026_communications_foundation.sql");
  const actorFunction = foundation.slice(foundation.indexOf("CREATE FUNCTION public.communication_actor_allowed"), foundation.indexOf("CREATE FUNCTION public.save_communication_settings"));
  assert.ok(actorFunction.startsWith("CREATE FUNCTION"));
  await db.exec(actorFunction);
  const migration = read("20261029_notification_configuration.sql");
  const snapshot = async () => (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(t)) FROM user_profiles t) users,
    (SELECT jsonb_agg(to_jsonb(t)) FROM role_permissions t) permissions,
    (SELECT jsonb_agg(to_jsonb(t)) FROM communication_messages t) messages,
    (SELECT jsonb_agg(to_jsonb(t)) FROM contractor_followups t) followups,
    (SELECT jsonb_agg(to_jsonb(t)) FROM activity_log t) activity`)).rows;
  const protectedBefore = await snapshot();
  const channelsBefore = (await db.query("SELECT * FROM communication_channel_settings ORDER BY channel")).rows;
  assert.ok(channelsBefore.every((row) => !row.automated_enabled));
  // A previously saved master flag must survive migration unchanged.
  await db.exec("UPDATE communication_channel_settings SET automated_enabled=true WHERE channel='email'");
  await fails(migration.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('notification_reminder_rules') t")).rows[0].t, null);
  await db.exec(migration);
  assert.equal((await db.query("SELECT automated_enabled FROM communication_channel_settings WHERE channel='email'")).rows[0].automated_enabled, true);
  const defaults = (await db.query("SELECT * FROM notification_reminder_rules ORDER BY days_before_expiration DESC")).rows;
  assert.deepEqual(defaults.map((row) => row.days_before_expiration), [90, 60, 30]);
  for (const row of defaults) {
    assert.equal(row.email_enabled || row.sms_enabled, false);
    assert.equal(row.template_reference, null);
    assert.equal(Object.hasOwn(row, "active"), false);
    assert.equal(Object.hasOwn(row, "is_active"), false);
    assert.ok(row.created_at && row.updated_at);
  }
  const base = { days_before_expiration: 45, email_enabled: false, sms_enabled: false, template_reference: "portable/reminder" };
  const ruleSQL = (n, input, id = null, remove = false) => `SELECT save_notification_reminder('${actor(n)}',${id ? `'${id}'` : "NULL"},${quote(input)},${remove}) id`;
  const masterSQL = (n, input) => `SELECT save_notification_automation('${actor(n)}',${quote(input)})`;
  const masters = { email: { automated_enabled: false, revision: 1 }, sms: { automated_enabled: false, revision: 1 } };
  await db.exec("SET ROLE service_role");
  for (const n of [2, 3, 5, 99]) {
    await fails(ruleSQL(n, base), "42501");
    await fails(masterSQL(n, masters), "42501");
  }
  await db.exec(masterSQL(1, masters));
  let channels = (await db.query("SELECT * FROM communication_channel_settings ORDER BY channel")).rows;
  assert.ok(channels.every((row) => !row.automated_enabled && row.revision === 2));
  for (let i = 0; i < channels.length; i++) {
    for (const key of ["provider", "enabled", "from_address", "sending_phone_number"]) assert.equal(channels[i][key], channelsBefore[i][key]);
  }
  await fails(masterSQL(1, masters), "40001");
  await fails(masterSQL(1, { email: { automated_enabled: true, revision: 2 }, sms: { automated_enabled: true, revision: 1 } }), "40001");
  assert.ok((await db.query("SELECT * FROM communication_channel_settings")).rows.every((row) => !row.automated_enabled && row.revision === 2), "Second-channel conflict rolls back first-channel change");
  await db.exec(masterSQL(4, { email: { automated_enabled: true, revision: 2 }, sms: { automated_enabled: false, revision: 2 } }));
  channels = (await db.query("SELECT * FROM communication_channel_settings ORDER BY channel")).rows;
  assert.equal(channels[0].automated_enabled, true); assert.equal(channels[1].automated_enabled, false);
  await db.exec(masterSQL(1, { email: { automated_enabled: false, revision: 3 }, sms: { automated_enabled: true, revision: 3 } }));
  channels = (await db.query("SELECT * FROM communication_channel_settings ORDER BY channel")).rows;
  assert.equal(channels[0].automated_enabled, false); assert.equal(channels[1].automated_enabled, true);
  await fails(masterSQL(1, { ...masters, active: true }), "22023");
  await fails(masterSQL(1, { email: { automated_enabled: "true", revision: 4 }, sms: masters.sms }), "22023");
  const id = (await db.query(ruleSQL(1, base))).rows[0].id;
  const duplicate = (await db.query(ruleSQL(1, base))).rows[0].id;
  await db.exec(ruleSQL(1, { ...base, email_enabled: true, revision: 1 }, id));
  await fails(ruleSQL(1, { ...base, sms_enabled: true, revision: 1 }, duplicate), "23505");
  await fails(ruleSQL(1, { ...base, sms_enabled: true }), "23505");
  await db.exec(ruleSQL(1, { ...base, days_before_expiration: 47, sms_enabled: true, revision: 2 }, id));
  let rule = (await db.query(`SELECT * FROM notification_reminder_rules WHERE id='${id}'`)).rows[0];
  assert.equal(rule.days_before_expiration, 47); assert.equal(rule.email_enabled, false); assert.equal(rule.sms_enabled, true);
  assert.equal(rule.template_reference, "portable/reminder"); assert.equal(rule.revision, 3);
  await fails(ruleSQL(1, { ...base, revision: 2 }, id), "40001");
  await fails(ruleSQL(1, { revision: 2 }, id, true), "40001");
  await db.exec(ruleSQL(1, { ...base, days_before_expiration: 47, revision: 3 }, id));
  rule = (await db.query(`SELECT * FROM notification_reminder_rules WHERE id='${id}'`)).rows[0];
  assert.equal(rule.email_enabled || rule.sms_enabled, false);
  await db.exec(ruleSQL(1, { ...base, days_before_expiration: 47, email_enabled: true }));
  for (const invalid of [
    { days_before_expiration: 0 }, { days_before_expiration: -1 }, { days_before_expiration: 1.5 },
    { days_before_expiration: "45" }, { email_enabled: "true" }, { sms_enabled: null },
    { active: true }, { template_reference: {} },
  ]) await fails(ruleSQL(1, { ...base, ...invalid }), "22023");
  await fails(ruleSQL(1, { ...base, template_reference: "x".repeat(501) }), "23514");
  await fails(ruleSQL(1, { revision: 1 }, actor(999), true), "P0002");
  await db.exec(ruleSQL(1, { revision: 4 }, id, true));
  assert.equal((await db.query(`SELECT count(*)::int n FROM notification_reminder_rules WHERE id='${id}'`)).rows[0].n, 0);
  for (const sql of ["INSERT INTO notification_reminder_rules(days_before_expiration) VALUES(10)", "UPDATE notification_reminder_rules SET email_enabled=true", "DELETE FROM notification_reminder_rules"]) await fails(sql, "42501");
  await db.exec("RESET ROLE");
  assert.equal((await db.query("SELECT relrowsecurity FROM pg_class WHERE relname='notification_reminder_rules'")).rows[0].relrowsecurity, true);
  for (const role of ["authenticated", "anon"]) {
    await db.exec(`SET ROLE ${role}`);
    await fails("SELECT * FROM notification_reminder_rules", "42501");
    await fails(ruleSQL(1, base), "42501");
    await fails(masterSQL(1, masters), "42501");
    await db.exec("RESET ROLE");
  }
  assert.deepEqual(await snapshot(), protectedBefore, "All configuration operations leave identities, permissions, Communications, Follow-Ups and Activity unchanged");
  assert.doesNotMatch(migration, /INSERT INTO public\.communication_messages|save_communication_draft|CREATE.*(?:TRIGGER|EXTENSION)|cron\.|http_request/i);
  console.log("PASS: Notifications migration rollback/seeds, saved master preservation/default OFF, independent atomic master changes, protected sender/provider fields, CRUD/deactivation, duplicate active offsets, revisions, Settings authorization, server-only grants/RLS and no generated Communications/history.");
} finally { await db.close(); }
