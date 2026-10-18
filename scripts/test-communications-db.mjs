import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const db = await PGlite.create();
const read = (file) => fs.readFileSync(new URL(`../supabase/${file}`, import.meta.url), "utf8");
const fails = (sql, code) => assert.rejects(db.exec(sql), (error) => error.code === code, sql);
try {
  await db.exec(`
    CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE app_roles(role text PRIMARY KEY);
    INSERT INTO app_roles VALUES ('Administrator'),('Summary'),('Content'),('AddOnly'),('EditOnly'),('Delivery'),('Settings'),('Contractor');
    CREATE TABLE role_permissions(role text REFERENCES app_roles, module text,
      can_view boolean, can_manage boolean, can_add boolean, can_edit boolean, can_delete boolean,
      PRIMARY KEY(role,module), CONSTRAINT role_permissions_module_check CHECK(module IN ('settings','contractors')));
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,system_administrator boolean DEFAULT false);
    INSERT INTO role_permissions VALUES ('Settings','settings',true,true,true,true,true),('Contractor','contractors',true,true,true,true,true);
  `);
  const before = (await db.query("SELECT * FROM role_permissions ORDER BY role,module")).rows;
  await db.exec(read("20261025_communications_permissions.sql"));
  assert.deepEqual((await db.query("SELECT * FROM role_permissions WHERE module IN ('settings','contractors') ORDER BY role,module")).rows, before);
  assert.equal((await db.query("SELECT count(*)::int n FROM role_permissions WHERE module LIKE 'communications_%' AND role <> 'Administrator' AND (can_view OR can_manage OR can_add OR can_edit OR can_delete)")).rows[0].n, 0);
  assert.equal((await db.query("SELECT count(*)::int n FROM role_permissions WHERE role='Administrator' AND can_view AND can_manage AND can_add AND can_edit AND can_delete")).rows[0].n, 3);
  await fails("INSERT INTO role_permissions VALUES('Summary','invalid',false,false,false,false,false)", "23514");
  console.log("PASS: Communications permission registration, denied non-admin defaults, established admin bootstrap and unchanged unrelated permissions.");
  await db.exec(`
    CREATE TABLE contractors(id integer PRIMARY KEY,company_name text);
    CREATE TABLE projects(id integer PRIMARY KEY,project_number text,project_name text);
    CREATE TABLE compliance_records(id integer PRIMARY KEY,contractor_id integer REFERENCES contractors);
    CREATE TABLE contractor_insurance(contractor_id integer PRIMARY KEY REFERENCES contractors);
    CREATE TABLE mycoi_policies(id integer PRIMARY KEY,contractor_id integer REFERENCES contractors);
    CREATE TABLE contractor_contacts(id uuid PRIMARY KEY,contractor_id integer REFERENCES contractors,contact_name text,email text,mobile_phone text);
    CREATE TABLE dobco_contacts(id uuid PRIMARY KEY,contact_name text,email text,mobile_phone text,is_active boolean);
    INSERT INTO contractors VALUES(1,'Synthetic One'),(2,'Synthetic Two');
    INSERT INTO projects VALUES(1,'10001','Synthetic Project'),(2,'10002','Synthetic Second');
    INSERT INTO compliance_records VALUES(1,1),(2,2);
    INSERT INTO contractor_insurance VALUES(1),(2);
    INSERT INTO mycoi_policies VALUES(1,1),(2,2);
    INSERT INTO contractor_contacts VALUES('00000000-0000-0000-0000-000000000101',1,'Original contractor contact','original@example.invalid','+15555550101');
    INSERT INTO dobco_contacts VALUES('00000000-0000-0000-0000-000000000102','Original internal contact','internal@example.invalid','+15555550102',true);
    INSERT INTO user_profiles SELECT ('00000000-0000-0000-0000-'||lpad(n::text,12,'0'))::uuid,role,'Active',false
      FROM (VALUES(1,'Administrator'),(2,'Summary'),(3,'Content'),(4,'AddOnly'),(5,'EditOnly'),(6,'Delivery'),(7,'Settings'),(8,'Contractor')) r(n,role);
    INSERT INTO user_profiles VALUES('00000000-0000-0000-0000-000000000009','Administrator','Inactive',false);
    UPDATE role_permissions SET can_view=true WHERE (role,module) IN
      (('Summary','communications_summary'),('Content','communications_content'),('Delivery','communications_delivery'));
    UPDATE role_permissions SET can_add=true,can_manage=true WHERE role='AddOnly' AND module='communications_content';
    UPDATE role_permissions SET can_edit=true,can_manage=true WHERE role='EditOnly' AND module='communications_content';
    INSERT INTO role_permissions SELECT 'Administrator',m,true,true,true,true,true
      FROM unnest(ARRAY['settings','contractors','projects','compliance','insurance']) m;
  `);
  const protectedSnapshot = async () => (await db.query(`SELECT
    (SELECT jsonb_agg(to_jsonb(t)) FROM user_profiles t) users,
    (SELECT jsonb_agg(to_jsonb(t)) FROM contractor_contacts t) contractors,
    (SELECT jsonb_agg(to_jsonb(t)) FROM dobco_contacts t) dobco`)).rows;
  const protectedBefore = await protectedSnapshot();
  const migration = read("20261026_communications_foundation.sql");
  assert.doesNotMatch(migration, /audit_application_change|ALTER TABLE public\.(?:user_profiles|contractor_contacts|dobco_contacts|compliance_records|mycoi_policies)/i);
  await fails(migration.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('communication_messages') t")).rows[0].t, null);
  await db.exec(migration);
  await db.exec(read("20261027_sms_twilio_provider_option.sql"));
  const invitationMigration = read("20261028_user_invitation_email_configuration.sql");
  await fails(invitationMigration.replace(/COMMIT;\s*$/, "SELECT 1/0;\nCOMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('user_invitation_email_settings') t")).rows[0].t, null);
  await db.exec(invitationMigration);
  assert.deepEqual(await protectedSnapshot(), protectedBefore);
  const defaults = (await db.query("SELECT * FROM communication_channel_settings ORDER BY channel")).rows;
  assert.equal(defaults.length, 2);
  for (const row of defaults) {
    assert.equal(row.provider, null); assert.equal(row.enabled, false); assert.equal(row.automated_enabled, false);
    assert.equal(row.from_address, null); assert.equal(row.sending_phone_number, null);
    assert.equal(Object.keys(row).some((key) => /secret|credential|token|connection_string/.test(key)), false);
  }
  const actor = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const quote = (v) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
  const emailSettings = { provider: "azure_communication_services", enabled: true, automated_enabled: true, from_name: "Another Installation", from_address: "sender@example.invalid", reply_to_address: "reply@example.invalid", sending_domain: "example.invalid", revision: 1 };
  const smsSettings = { provider: "azure_communication_services", enabled: true, automated_enabled: false, sending_phone_number: "+15555550100", incoming_enabled: true, two_way_enabled: true, revision: 1 };
  const settingsSQL = (n, channel, input) => `SELECT save_communication_settings('${actor(n)}','${channel}',${quote(input)})`;
  const invitationDefault = (await db.query("SELECT * FROM user_invitation_email_settings")).rows[0];
  assert.equal(invitationDefault.delivery_mode, "supabase_auth");
  assert.equal(invitationDefault.enabled, true);
  assert.equal(invitationDefault.organization_name, null);
  assert.equal(invitationDefault.subject, null);
  const invitationInput = { enabled: false, delivery_mode: "application_email_provider",
    organization_name: "Portable Organization", application_name: "Portable Application", subject: "An invitation",
    application_base_url: "https://portable.example.invalid", invitation_path: "/account-invitation",
    template_reference: "installation/invitation-v1", template_content: "Welcome {{invitee_name}}\n{{invitation_url}}",
    sender_reference: "email-channel.sender", reply_to_reference: "email-channel.reply_to", revision: 1 };
  const invitationSQL = (n, value) => `SELECT save_user_invitation_email_settings('${actor(n)}',${quote(value)})`;
  const input = {
    channel: "email", subject: "Synthetic subject", body: "Exact final\n  message body ' preserved",
    recipients: [
      { recipient_type: "contractor_contact", recipient_name: "Original contractor contact", email: "original@example.invalid", mobile_phone: null, contractor_contact_id: actor(101), dobco_contact_id: null },
      { recipient_type: "dobco_contact", recipient_name: "Original internal contact", email: "internal@example.invalid", mobile_phone: null, contractor_contact_id: null, dobco_contact_id: actor(102) },
    ],
    contractor_ids: [1, 2], project_ids: [1, 2], compliance_record_ids: [1, 2], mycoi_policy_ids: [1, 2],
    insurance_items: [{ contractor_id: 1, item_key: "general_liability" }],
  };
  const draftSQL = (n, value, id = null) => `SELECT save_communication_draft('${actor(n)}',${id ? `'${id}'` : "NULL"},${quote(value)}) AS id`;
  await db.exec("SET ROLE service_role");
  for (const n of [2, 3, 4, 5, 6, 8, 9]) await fails(invitationSQL(n, invitationInput), "42501");
  await db.exec(invitationSQL(7, invitationInput));
  const invitationSaved = (await db.query("SELECT * FROM user_invitation_email_settings")).rows[0];
  for (const [key, value] of Object.entries(invitationInput)) assert.equal(invitationSaved[key], key === "revision" ? 2 : value);
  await fails(invitationSQL(7, invitationInput), "40001");
  await fails(invitationSQL(7, { ...invitationInput, revision: 2, secret: "synthetic" }), "22023");
  await fails(invitationSQL(7, { ...invitationInput, revision: 2, enabled: "false" }), "22023");
  await fails(invitationSQL(7, { ...invitationInput, revision: 2, delivery_mode: "unsupported" }), "22023");
  await fails(invitationSQL(7, { ...invitationInput, revision: 2, template_content: "x".repeat(10001) }), "23514");
  await fails("UPDATE user_invitation_email_settings SET enabled=true", "42501");
  await fails("DELETE FROM user_invitation_email_settings", "42501");
  for (const n of [2, 3, 4, 5, 6, 8, 9]) await fails(settingsSQL(n, "email", emailSettings), "42501");
  await db.exec(settingsSQL(7, "email", emailSettings));
  await db.exec(settingsSQL(7, "sms", smsSettings));
  await db.exec(settingsSQL(7, "sms", { ...smsSettings, provider: "twilio", revision: 2 }));
  assert.equal((await db.query("SELECT provider FROM communication_channel_settings WHERE channel='sms'")).rows[0].provider, "twilio");
  await fails(settingsSQL(7, "email", { ...emailSettings, provider: "twilio", revision: 2 }), "23514");
  await fails(settingsSQL(7, "sms", { ...smsSettings, provider: "unknown", revision: 3 }), "23514");
  await db.exec(settingsSQL(7, "sms", { ...smsSettings, revision: 3 }));
  await fails(settingsSQL(7, "email", emailSettings), "40001");
  await fails(settingsSQL(7, "email", { ...emailSettings, revision: 2, connection_string: "not-a-real-secret" }), "22023");
  for (const n of [2, 3, 5, 6, 7, 8, 9]) await fails(draftSQL(n, input), "42501");
  await fails(draftSQL(4, input), "42501", "Add-only does not bypass related-record permissions");
  const simple = { ...input, recipients: [{ recipient_type: "external", recipient_name: "Synthetic external", email: "external@example.invalid", mobile_phone: null, contractor_contact_id: null, dobco_contact_id: null }], contractor_ids: [], project_ids: [], compliance_record_ids: [], mycoi_policy_ids: [], insurance_items: [] };
  const addOnlyId = (await db.query(draftSQL(4, simple))).rows[0].id;
  assert.ok(addOnlyId, "Content Add works without Content View");
  const id = (await db.query(draftSQL(1, input))).rows[0].id;
  const full = async () => (await db.query(`SELECT * FROM communication_messages WHERE id='${id}'`)).rows[0];
  assert.equal((await full()).body, input.body);
  assert.equal((await full()).status, "Draft");
  assert.equal((await full()).sent_at, null);
  assert.equal((await full()).delivered_at, null);
  assert.equal((await full()).provider_message_id, null);
  assert.equal((await full()).sender_address, emailSettings.from_address);
  await db.exec(settingsSQL(7, "email", { ...emailSettings, from_address: "replacement@example.invalid", revision: 2 }));
  assert.equal((await full()).sender_address, emailSettings.from_address, "Later provider configuration cannot rewrite sender history");
  assert.equal((await db.query(`SELECT count(*)::int n FROM communication_recipients WHERE message_id='${id}'`)).rows[0].n, 2);
  for (const table of ["communication_contractors", "communication_projects", "communication_compliance_items", "communication_mycoi_items"]) {
    assert.equal((await db.query(`SELECT count(*)::int n FROM ${table} WHERE message_id='${id}'`)).rows[0].n, 2);
  }
  for (const field of ["queued_at", "sent_at", "delivered_at", "failed_at", "cancelled_at", "failure_reason", "provider_message_id", "sent_by"]) assert.equal((await full())[field], null);
  assert.equal((await db.query(`SELECT count(*)::int n FROM communication_recipients WHERE message_id='${id}' AND (status<>'Draft' OR sent_at IS NOT NULL OR delivered_at IS NOT NULL OR provider_recipient_id IS NOT NULL)`)).rows[0].n, 0);
  await fails(draftSQL(1, { ...input, status: "Sent" }), "22023");
  await fails(draftSQL(1, { ...input, contractor_ids: [999] }), "22023");
  await fails(draftSQL(1, { ...input, project_ids: [999] }), "23503");
  await fails(draftSQL(1, { ...input, contractor_ids: [1] }), "22023");
  await fails(draftSQL(1, { ...input, recipients: [{ ...input.recipients[0], contractor_contact_id: actor(999) }] }), "22023");
  await fails(draftSQL(1, { ...input, recipients: [{ ...input.recipients[1], dobco_contact_id: actor(999) }] }), "23503");
  await fails(draftSQL(1, { ...input, insurance_items: [{ contractor_id: 999, item_key: "general_liability" }] }), "22023");
  const countBefore = (await db.query("SELECT count(*)::int n FROM communication_messages")).rows[0].n;
  await fails(draftSQL(1, { ...simple, recipients: [{ ...simple.recipients[0], status: "Sent" }] }), "22023");
  assert.equal((await db.query("SELECT count(*)::int n FROM communication_messages")).rows[0].n, countBefore, "Failed child insert rolls back message");
  for (const n of [2, 3, 4, 6, 7, 8, 9]) await fails(draftSQL(n, { ...simple, revision: 1 }, addOnlyId), "42501");
  await db.exec(draftSQL(5, { ...simple, body: "Edited without View", revision: 1 }, addOnlyId));
  await fails(draftSQL(5, { ...simple, revision: 1 }, addOnlyId), "40001");
  const beforeEditFailure = await full();
  await fails(draftSQL(1, { ...input, body: "Must roll back", revision: 1, recipients: [{ ...input.recipients[1], dobco_contact_id: actor(999) }] }, id), "23503");
  assert.deepEqual(await full(), beforeEditFailure, "Invalid update rolls back parent and all relationships");
  assert.equal((await db.query(`SELECT count(*)::int n FROM communication_recipients WHERE message_id='${id}'`)).rows[0].n, 2);
  for (const table of ["communication_messages", "communication_recipients", "communication_channel_settings"]) {
    await fails(`UPDATE ${table} SET ${table === "communication_channel_settings" ? "enabled=false" : "status='Sent'"}`, "42501");
    await fails(`DELETE FROM ${table}`, "42501");
  }
  await db.exec("RESET ROLE");
  for (const role of ["authenticated", "anon"]) {
    await db.exec(`SET ROLE ${role}`);
    for (const table of ["communication_messages", "communication_recipients", "communication_channel_settings", "communication_contractors", "communication_projects", "communication_compliance_items", "communication_mycoi_items", "communication_insurance_items"]) {
      await fails(`SELECT * FROM ${table}`, "42501");
    }
    await fails(draftSQL(1, input), "42501");
    await fails(settingsSQL(1, "email", emailSettings), "42501");
    await fails("SELECT * FROM user_invitation_email_settings", "42501");
    await fails(invitationSQL(1, invitationInput), "42501");
    await fails(`SELECT communication_actor_allowed('${actor(1)}','settings','manage')`, "42501");
    await db.exec("RESET ROLE");
  }
  await db.exec(`UPDATE contractor_contacts SET contact_name='Changed',email='changed@example.invalid';
    UPDATE dobco_contacts SET contact_name='Changed',email='changed@example.invalid',is_active=false;`);
  const snapshots = (await db.query(`SELECT recipient_name,email FROM communication_recipients WHERE message_id='${id}' ORDER BY recipient_name`)).rows;
  assert.deepEqual(snapshots, input.recipients.map(({ recipient_name, email }) => ({ recipient_name, email })).sort((a, b) => a.recipient_name.localeCompare(b.recipient_name)));
  for (const status of ["Queued", "Sending", "Sent", "Delivered", "Failed", "Cancelled"]) {
    await db.exec(`UPDATE communication_messages SET status='${status}' WHERE id='${id}'`);
    await db.exec("SET ROLE service_role");
    await fails(draftSQL(1, { ...input, revision: 1 }, id), "22023");
    await db.exec("RESET ROLE");
  }
  await fails(`UPDATE communication_messages SET status='Fabricated' WHERE id='${id}'`, "23514");
  await fails(`UPDATE communication_recipients SET status='Fabricated'`, "23514");
  await fails(`UPDATE communication_messages SET direction='unknown' WHERE id='${id}'`, "23514");
  await db.exec(`UPDATE communication_messages SET direction='inbound',source='automated' WHERE id='${id}'`);
  assert.equal((await full()).direction, "inbound");
  assert.equal((await full()).source, "automated");
  console.log("PASS: atomic forward migration/rollback, independent settings persistence, server-only RLS/grants, active-actor authorization, Draft-only mutations, concurrency, ownership/FKs, multiple recipients/relations, frozen snapshots and allowed statuses.");
  console.log("PASS: invitation configuration migration/rollback, Supabase defaults, portable application mode persistence, strict input/revision checks and service-only Settings Manage mutations.");
  await db.exec(`
    ALTER TABLE contractor_contacts ADD COLUMN is_active boolean DEFAULT true,
      ADD COLUMN receives_compliance_email boolean DEFAULT true, ADD COLUMN receives_compliance_sms boolean DEFAULT true,
      ADD COLUMN sms_consent_recorded boolean DEFAULT true;
    ALTER TABLE dobco_contacts ADD COLUMN receives_internal_email boolean DEFAULT true,
      ADD COLUMN receives_internal_sms boolean DEFAULT true, ADD COLUMN sms_consent_recorded boolean DEFAULT true;
  `);
  await db.exec(read("20261029_notification_configuration.sql"));
  const composeMigration = read("20261030_communication_templates_compose.sql");
  await fails(composeMigration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('communication_templates') t")).rows[0].t, null);
  const masterBefore = (await db.query("SELECT automated_enabled FROM communication_channel_settings ORDER BY channel")).rows;
  await db.exec(composeMigration);
  assert.deepEqual((await db.query("SELECT automated_enabled FROM communication_channel_settings ORDER BY channel")).rows, masterBefore);
  assert.equal((await db.query("SELECT count(*)::int n FROM communication_templates")).rows[0].n, 0, "No installation-specific template seeding");
  const template = { name: "Portable Reminder", category: "Expiration Reminder", channel: "email", subject: "For {{contractor_name}}", body: "Hello {{contact_name}}\n{{expiration_date}}", is_active: true };
  const templateSQL = (n, value, templateId = null) => `SELECT save_communication_template('${actor(n)}',${templateId ? `'${templateId}'` : "null"},${quote(value)})`;
  for (const n of [2, 3, 4, 5, 6, 8, 9]) await fails(templateSQL(n, template), "42501");
  const templateId = (await db.query(templateSQL(7, template))).rows[0].save_communication_template;
  const smsTemplate = (await db.query(templateSQL(7, { ...template, channel: "sms", subject: null }))).rows[0].save_communication_template;
  await db.exec(templateSQL(7, { ...template, body: "Editable exact wording\n", revision: 1 }, templateId));
  await fails(templateSQL(7, { ...template, revision: 1 }, templateId), "40001");
  const reminderId = (await db.query("SELECT id FROM notification_reminder_rules LIMIT 1")).rows[0].id;
  const reminder = { days_before_expiration: 12, email_enabled: true, sms_enabled: true, template_reference: null, email_template_id: templateId, sms_template_id: smsTemplate, revision: 1 };
  const reminderSQL = (v) => `SELECT save_notification_reminder('${actor(7)}','${reminderId}',${quote(v)},false)`;
  await db.exec(reminderSQL(reminder));
  await fails(reminderSQL({ ...reminder, email_template_id: smsTemplate, revision: 2 }), "22023");
  await db.exec(templateSQL(7, { ...template, is_active: false, revision: 2 }, templateId));
  await db.exec(reminderSQL({ ...reminder, revision: 2 }));
  await fails(templateSQL(7, { ...template, channel: "sms", subject: null, revision: 3 }, templateId), "22023");
  await db.exec("UPDATE contractor_contacts SET is_active=true; UPDATE dobco_contacts SET is_active=true");
  const live = (await db.query("SELECT * FROM contractor_contacts LIMIT 1")).rows[0];
  const contactSnapshot = { recipient_type: "contractor_contact", recipient_name: live.contact_name, email: live.email, mobile_phone: live.mobile_phone, contractor_contact_id: live.id, dobco_contact_id: null };
  const liveDraft = { ...simple, contractor_ids: [1], recipients: [contactSnapshot], template_id: templateId };
  await fails(draftSQL(1, liveDraft), "22023", "Inactive templates cannot be used for new Drafts");
  await db.exec(templateSQL(7, { ...template, is_active: true, revision: 3 }, templateId));
  const composeId = (await db.query(draftSQL(1, liveDraft))).rows[0].id;
  const saved = (await db.query(`SELECT * FROM communication_messages WHERE id='${composeId}'`)).rows[0];
  await db.exec(`UPDATE contractor_contacts SET contact_name='New name',email='new@example.invalid',is_active=false;
    UPDATE communication_channel_settings SET from_address='new-sender@example.invalid' WHERE channel='email'`);
  await db.exec(draftSQL(1, { ...liveDraft, revision: 1, body: "Edited exact body" }, composeId));
  const after = (await db.query(`SELECT * FROM communication_messages WHERE id='${composeId}'`)).rows[0];
  assert.equal(after.sender_address, saved.sender_address, "Editing body preserves sender snapshot");
  const recipientAfter = (await db.query(`SELECT recipient_name,email FROM communication_recipients WHERE message_id='${composeId}'`)).rows[0];
  assert.deepEqual(recipientAfter, { recipient_name: contactSnapshot.recipient_name, email: contactSnapshot.email }, "Historical contact values remain frozen");
  await fails(draftSQL(1, { ...liveDraft, revision: 2, recipients: [{ ...contactSnapshot, email: "forged@example.invalid" }] }, composeId), "22023");
  await fails(draftSQL(1, { ...liveDraft, template_id: null }), "22023", "Inactive contacts cannot be newly selected");
  await fails(draftSQL(1, { ...liveDraft, channel: "sms", subject: null, template_id: smsTemplate }), "22023");
  await db.exec("UPDATE contractor_contacts SET is_active=true,receives_compliance_sms=true,sms_consent_recorded=false");
  const current = { ...contactSnapshot, recipient_name: "New name", email: "new@example.invalid" };
  const smsDraft = { ...liveDraft, channel: "sms", subject: null, template_id: smsTemplate, recipients: [current] };
  await fails(draftSQL(1, smsDraft), "22023", "SMS requires consent");
  await db.exec("UPDATE contractor_contacts SET sms_consent_recorded=true");
  const smsId = (await db.query(draftSQL(1, smsDraft))).rows[0].id;
  assert.equal((await db.query(`SELECT status FROM communication_messages WHERE id='${smsId}'`)).rows[0].status, "Draft");
  await fails(draftSQL(1, { ...liveDraft, revision: 1 }, composeId), "40001");
  await db.exec(draftSQL(1, { ...liveDraft, revision: 2, recipients: [current] }, composeId));
  assert.equal((await db.query(`SELECT email FROM communication_recipients WHERE message_id='${composeId}'`)).rows[0].email, "new@example.invalid", "Explicit eligible reselection refreshes snapshot");
  await db.exec(`UPDATE communication_messages SET status='Sent' WHERE id='${composeId}'`);
  await fails(draftSQL(1, { ...liveDraft, revision: 3, recipients: [current] }, composeId), "22023");
  await db.exec("SET ROLE service_role");
  await fails("SELECT save_communication_draft_base(null,null,'{}')", "42501");
  await fails("SELECT save_notification_reminder_base(null,null,'{}',false)", "42501");
  await fails("DELETE FROM communication_templates", "42501");
  await db.exec("RESET ROLE; SET ROLE authenticated");
  await fails("SELECT * FROM communication_templates", "42501");
  await fails(templateSQL(7, template), "42501");
  await db.exec("RESET ROLE");
  console.log("PASS: Step 6C forward migration rollback/no seeds, Settings-only template lifecycle/revisions, channel-specific reminder references, deactivation/history preservation, new-recipient eligibility/consent, forged snapshot rejection, frozen contact/sender snapshots, Draft-only edits and no automation changes.");
  const microsoftMigration = read("20261031_microsoft_365_email_foundation.sql");
  const historyBeforeMicrosoft = (await db.query("SELECT * FROM communication_messages ORDER BY id")).rows;
  const recipientsBeforeMicrosoft = (await db.query("SELECT * FROM communication_recipients ORDER BY id")).rows;
  const mastersBeforeMicrosoft = (await db.query("SELECT channel,automated_enabled FROM communication_channel_settings ORDER BY channel")).rows;
  await fails(microsoftMigration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  await db.exec(microsoftMigration);
  assert.deepEqual((await db.query("SELECT channel,automated_enabled FROM communication_channel_settings ORDER BY channel")).rows, mastersBeforeMicrosoft);
  const msInput = { ...emailSettings, provider: "microsoft_365", automated_enabled: false, from_name: "Portable Microsoft Sender",
    microsoft_tenant_id: actor(800), microsoft_client_id: actor(801) };
  delete msInput.sending_domain;
  const savedEmail = (await db.query("SELECT * FROM communication_channel_settings WHERE channel='email'")).rows[0];
  msInput.revision = savedEmail.revision;
  await db.exec("SET ROLE service_role");
  await fails(settingsSQL(2, "email", msInput), "42501");
  await db.exec(settingsSQL(7, "email", msInput));
  const microsoftSaved = (await db.query("SELECT * FROM communication_channel_settings WHERE channel='email'")).rows[0];
  assert.equal(microsoftSaved.provider, "microsoft_365");
  assert.equal(microsoftSaved.microsoft_tenant_id, actor(800));
  assert.equal(microsoftSaved.microsoft_client_id, actor(801));
  assert.equal(microsoftSaved.sending_domain, savedEmail.sending_domain, "Switching to Microsoft preserves hidden ACS domain");
  assert.equal(microsoftSaved.automated_enabled, false);
  await fails(settingsSQL(7, "email", msInput), "40001");
  await fails(settingsSQL(7, "email", { ...msInput, revision: microsoftSaved.revision, microsoft_client_id: "bad-client-id" }), "23514");
  await fails(settingsSQL(7, "email", { ...msInput, revision: microsoftSaved.revision, client_secret: "forbidden" }), "22023");
  const currentSMS = (await db.query("SELECT * FROM communication_channel_settings WHERE channel='sms'")).rows[0];
  await fails(settingsSQL(7, "sms", { ...smsSettings, provider: "microsoft_365", revision: currentSMS.revision }), "23514");
  await fails(settingsSQL(7, "sms", { ...smsSettings, microsoft_tenant_id: actor(800), revision: currentSMS.revision }), "22023");
  await db.exec(settingsSQL(7, "email", { ...emailSettings, automated_enabled: false, revision: microsoftSaved.revision }));
  const switchedACS = (await db.query("SELECT * FROM communication_channel_settings WHERE channel='email'")).rows[0];
  assert.equal(switchedACS.provider, "azure_communication_services");
  assert.equal(switchedACS.microsoft_tenant_id, actor(800), "Hidden Microsoft identity survives ACS selection");
  assert.equal(switchedACS.microsoft_client_id, actor(801));
  const newMicrosoftDraftInput = { ...simple, template_id: null };
  await db.exec(settingsSQL(7, "email", { ...msInput, revision: switchedACS.revision }));
  const microsoftDraftId = (await db.query(draftSQL(1, newMicrosoftDraftInput))).rows[0].id;
  assert.equal((await db.query(`SELECT provider FROM communication_messages WHERE id='${microsoftDraftId}'`)).rows[0].provider, "microsoft_365");
  await db.exec(settingsSQL(7, "email", { ...emailSettings, automated_enabled: false, revision: switchedACS.revision + 1 }));
  assert.equal((await db.query(`SELECT provider FROM communication_messages WHERE id='${microsoftDraftId}'`)).rows[0].provider, "microsoft_365", "Provider changes do not rewrite Draft history");
  await fails("SELECT save_communication_settings_base(null,'email','{}')", "42501");
  await db.exec("RESET ROLE");
  assert.deepEqual((await db.query(`SELECT * FROM communication_messages WHERE id<>'${microsoftDraftId}' ORDER BY id`)).rows, historyBeforeMicrosoft);
  assert.deepEqual((await db.query(`SELECT * FROM communication_recipients WHERE message_id<>'${microsoftDraftId}' ORDER BY id`)).rows, recipientsBeforeMicrosoft);
  assert.equal((await db.query("SELECT automated_enabled FROM communication_channel_settings WHERE channel='email'")).rows[0].automated_enabled, false);
  console.log("PASS: Microsoft 365 migration rollback, Email-only settings, configurable tenant/client/sender, Settings Manage/revisions, no secret columns, provider-switch configuration preservation, unchanged authoritative history/snapshots and no automation enablement.");
} finally {
  await db.close();
}
