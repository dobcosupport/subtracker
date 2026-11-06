import assert from "node:assert/strict";

// Extend the existing isolated communications fixture; never connect to a real database.
export async function testCommunicationFoundation({ db, read, fails, actor, draftSQL, manualEmailDraft, settingsSQL, msInput }) {
  await db.exec(`
    ALTER TABLE user_profiles ADD name text;
    ALTER TABLE contractors ADD dba_name text;
    CREATE TABLE compliance_types(id integer PRIMARY KEY,compliance_name text);
    INSERT INTO compliance_types VALUES(1,'NJ PWC'),(2,'NJ BRC'),(3,'Missing NY BRC');
    ALTER TABLE compliance_records ADD compliance_type_id integer REFERENCES compliance_types DEFAULT 1,
      ADD registration_number text, ADD expiration_date date;
    ALTER TABLE mycoi_policies ADD policy_line text,ADD policy_number text,ADD expiration_date date;
    ALTER TABLE role_permissions DROP CONSTRAINT role_permissions_module_check;
    INSERT INTO role_permissions VALUES('Administrator','followups',true,true,true,true,true);
    UPDATE user_profiles SET name='Original Creator';
  `);
  await db.exec(read("20260924_contractor_followups.sql"));
  await db.exec(read("20261008_followup_related_items.sql"));
  await db.exec(`
    INSERT INTO contractor_followups(id,contractor_id,compliance_record_id,followup_date,followup_method,subject,status)
      VALUES(1,1,1,current_date,'Email','Original renewal follow-up','Open');
    INSERT INTO contractor_followups(id,contractor_id,compliance_type_id,followup_date,followup_method,subject,status)
      VALUES(2,1,3,current_date,'Email','Missing record follow-up','Open'),(3,2,2,current_date,'Email','Other company follow-up','Open');
    INSERT INTO contractor_followups(id,contractor_id,insurance_item_key,followup_date,followup_method,subject,status)
      VALUES(4,1,'general_liability',current_date,'Email','Liability renewal follow-up','Open');
  `);
  const before = (await db.query("SELECT * FROM communication_messages ORDER BY id")).rows;
  const legacyTemplate = actor(979);
  await db.exec(`INSERT INTO communication_templates(id,name,category,channel,subject,body,is_active)
    VALUES('${legacyTemplate}','Legacy template','Expiration Reminder','email','Legacy subject','Legacy template body',true)`);
  const legacyDraft = (await db.query(draftSQL(1, { ...manualEmailDraft, template_id: legacyTemplate }))).rows[0].id;
  const legacySendDraft = (await db.query(draftSQL(1, { ...manualEmailDraft, template_id: legacyTemplate }))).rows[0].id;
  const legacyRows = (await db.query(`SELECT * FROM communication_messages WHERE id IN('${legacyDraft}','${legacySendDraft}') ORDER BY id`)).rows;
  const oldStatuses = ["Draft", "Queued", "Sending", "Sent", "Delivered", "Failed", "Cancelled"];
  for (const [index, status] of oldStatuses.entries()) {
    await db.exec(`INSERT INTO communication_messages(id,channel,status,subject,body,created_by)
      VALUES('${actor(960 + index)}','email','${status}','Legacy ${status}','Exact legacy rendered content','${actor(1)}');
      INSERT INTO communication_recipients(message_id,recipient_type,recipient_name,email,status)
      VALUES('${actor(960 + index)}','external','Legacy recipient','legacy@example.invalid','${status}')`);
  }
  const statesBefore = (await db.query(`SELECT m.id,m.status,m.body,r.email,r.status AS recipient_status
    FROM communication_messages m JOIN communication_recipients r ON r.message_id=m.id
    WHERE m.id BETWEEN '${actor(960)}' AND '${actor(966)}' ORDER BY m.id`)).rows;
  const deliveryDefinitions = async () => (await db.query(`SELECT proname,pg_get_functiondef(oid) AS definition FROM pg_proc
    WHERE pronamespace='public'::regnamespace AND proname IN('reserve_microsoft_test_email','finish_microsoft_test_email',
      'reserve_communication_email_send','finish_communication_email_send') ORDER BY proname`)).rows;
  const deliveryBefore = await deliveryDefinitions();
  const migration = read("20261207_communication_data_foundation.sql");
  assert.doesNotMatch(migration, /(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?contractor_insurance\b/i,
    "Do not revive retired Manual Insurance; current insurance records come from myCOI");
  assert.doesNotMatch(migration, /(?:cron\.schedule|CREATE\s+(?:EVENT\s+TRIGGER|PROCEDURE)|net\.http|pg_net|http_post)/i);
  await fails(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regclass('communication_followups') t")).rows[0].t, null);
  await db.exec(migration);
  assert.deepEqual(await deliveryDefinitions(), deliveryBefore, "No existing delivery path is modified or enabled");
  const oldColumns = Object.keys(before[0]).map(k => `"${k}"`).join(",");
  const existingIds = new Set(before.map(row => row.id));
  assert.deepEqual((await db.query(`SELECT ${oldColumns} FROM communication_messages ORDER BY id`)).rows.filter(row => existingIds.has(row.id)), before);
  assert.deepEqual((await db.query(`SELECT ${oldColumns} FROM communication_messages WHERE id IN('${legacyDraft}','${legacySendDraft}') ORDER BY id`)).rows, legacyRows);
  assert.deepEqual((await db.query(`SELECT m.id,m.status,m.body,r.email,r.status AS recipient_status
    FROM communication_messages m JOIN communication_recipients r ON r.message_id=m.id
    WHERE m.id BETWEEN '${actor(960)}' AND '${actor(966)}' ORDER BY m.id`)).rows, statesBefore);
  const objects = (await db.query(`SELECT
    (SELECT count(*)::int FROM pg_trigger WHERE tgname='communication_history_guard' AND NOT tgisinternal) guards,
    (SELECT count(*)::int FROM pg_tables WHERE schemaname='public' AND tablename IN('communication_followups','communication_requirements') AND rowsecurity) rls,
    (SELECT count(*)::int FROM pg_indexes WHERE schemaname='public' AND indexname IN('communication_messages_schedule','communication_followups_lookup','communication_requirements_lookup')) indexes`)).rows[0];
  assert.deepEqual(objects, { guards: 9, rls: 2, indexes: 3 });
  assert.equal((await db.query("SELECT count(*)::int n FROM communication_messages WHERE context_snapshot IS NOT NULL")).rows[0].n, 0,
    "Do not invent historical business/template values for legacy messages");
  await db.exec("SET ROLE service_role");
  await fails("INSERT INTO communication_followups VALUES(gen_random_uuid(),1)", "42501");
  await fails("SELECT communication_context_snapshot(gen_random_uuid())", "42501");
  await fails(`SELECT save_communication_draft_compose('${actor(1)}',null,'{}')`, "42501");
  // The deployed client supplies no 1B metadata; preserve its Draft and template reference.
  await db.query(draftSQL(1, { ...manualEmailDraft, revision: 1 }, legacyDraft));
  const legacyEdited = (await db.query(`SELECT * FROM communication_messages WHERE id='${legacyDraft}'`)).rows[0];
  assert.equal(legacyEdited.template_id, legacyTemplate);
  assert.equal(legacyEdited.template_revision, null);
  assert.equal(legacyEdited.context_snapshot.template, null, "Unknown old rendering version must not be invented");
  assert.equal(legacyEdited.body, manualEmailDraft.body);
  const legacyCreated = (await db.query(draftSQL(1, { ...manualEmailDraft, template_id: legacyTemplate }))).rows[0].id;
  assert.equal((await db.query(`SELECT template_revision FROM communication_messages WHERE id='${legacyCreated}'`)).rows[0].template_revision, null);
  await fails(draftSQL(2, { ...manualEmailDraft, followup_ids: [1] }), "42501");
  await fails(draftSQL(4, { ...manualEmailDraft, contractor_ids: [1], followup_ids: [1] }), "42501");
  await fails(draftSQL(4, { ...manualEmailDraft, compliance_type_ids: [1] }), "42501");
  await fails(draftSQL(1, { ...manualEmailDraft, contractor_ids: [1], followup_ids: [3] }), "22023");
  await fails(draftSQL(1, { ...manualEmailDraft, contractor_ids: [1], followup_ids: [1, 1] }), "22023");
  await fails(draftSQL(1, { ...manualEmailDraft, contractor_ids: [1], compliance_type_ids: [999] }), "22023");
  await db.exec("RESET ROLE");
  const template = actor(980);
  await db.exec(`INSERT INTO communication_templates(id,name,category,channel,subject,body,is_active)
    VALUES('${template}','Original renewal template','Expiration Reminder','email','Original template subject','Original template body',true)`);
  await db.exec(`UPDATE contractor_contacts SET is_active=true,receives_compliance_email=true,contact_name='Original recipient',
    email='original-recipient@example.invalid' WHERE id='${actor(101)}';
    UPDATE dobco_contacts SET is_active=true,receives_internal_email=true WHERE id='${actor(102)}'`);
  const recipients = async () => {
    const contact = (await db.query(`SELECT * FROM contractor_contacts WHERE id='${actor(101)}'`)).rows[0];
    const internal = (await db.query(`SELECT * FROM dobco_contacts WHERE id='${actor(102)}'`)).rows[0];
    return [
      { recipient_type: "contractor_contact", contractor_contact_id: contact.id, dobco_contact_id: null,
        recipient_name: contact.contact_name, email: contact.email, mobile_phone: contact.mobile_phone },
      { recipient_type: "dobco_contact", contractor_contact_id: null, dobco_contact_id: internal.id,
        recipient_name: internal.contact_name, email: internal.email, mobile_phone: internal.mobile_phone },
    ];
  };
  const input = { ...manualEmailDraft, contractor_ids: [1], project_ids: [1],
    followup_ids: [1, 2, 4], template_id: template, template_revision: 1,
    communication_type: "Expiration Reminder", recipients: await recipients(), mycoi_policy_ids: [1] };
  await db.exec("SET ROLE service_role");
  const id = (await db.query(draftSQL(1, input))).rows[0].id;
  const get = async () => (await db.query(`SELECT * FROM communication_messages WHERE id='${id}'`)).rows[0];
  let saved = await get();
  assert.equal(saved.template_revision, 1);
  assert.deepEqual(saved.context_snapshot.requirements.map(x => x.id), [1, 3]);
  assert.deepEqual(saved.context_snapshot.followups.map(x => x.id), [1, 2, 4]);
  assert.equal(saved.context_snapshot.insurance[0].item_key, "general_liability");
  assert.equal(saved.context_snapshot.compliance[0].id, 1);
  assert.equal(saved.context_snapshot.created_by.name, "Original Creator");
  await db.exec("RESET ROLE");
  await db.exec(`UPDATE communication_templates SET name='Edited template',body='Edited template body',revision=2 WHERE id='${template}'`);
  await db.exec("SET ROLE service_role");
  await db.query(draftSQL(1, { ...input, revision: 1 }, id));
  saved = await get();
  assert.equal(saved.template_revision, 1, "Saved template version survives later template edits");
  assert.equal(saved.context_snapshot.template.body, "Original template body");
  // An old client editing a new Draft must not clear known provenance or new links.
  await db.query(draftSQL(1, { ...manualEmailDraft, contractor_ids: [1], project_ids: [1],
    mycoi_policy_ids: [1], recipients: input.recipients, revision: 2 }, id));
  saved = await get();
  assert.equal(saved.template_id, template);
  assert.equal(saved.template_revision, 1);
  assert.equal(saved.context_snapshot.template.body, "Original template body");
  assert.deepEqual(saved.context_snapshot.followups.map(row => row.id), [1, 2, 4]);
  assert.deepEqual(saved.context_snapshot.requirements.map(row => row.id), [1, 3]);
  await fails(draftSQL(1, { ...input, template_revision: 3 }), "PT409");
  const plan = (n, revision, action = "schedule", date = "'2099-01-01T10:00:00Z'") =>
    `SELECT plan_communication('${actor(n)}','${id}',${revision},'${action}',${date})`;
  await fails(plan(1, 1), "PT409");
  await fails(plan(2, 3), "42501");
  await fails(plan(1, 3, "schedule", "'2000-01-01'"), "22023");
  await db.exec(plan(1, 3));
  const frozen = await get();
  assert.equal(frozen.status, "Scheduled");
  assert.equal(frozen.sent_at, null);
  const settingsRevision = (await db.query("SELECT revision FROM communication_channel_settings WHERE channel='email'")).rows[0].revision;
  await fails(`SELECT reserve_communication_email_send('${actor(6)}','${id}',${settingsRevision})`, "22023",
    "Scheduled plans cannot enter the existing manual Draft-only delivery path");
  await fails(draftSQL(1, { ...input, revision: 3 }, id), "22023");
  await db.exec("RESET ROLE");
  for (const sql of [
    `UPDATE communication_messages SET body='tampered' WHERE id='${id}'`,
    `DELETE FROM communication_messages WHERE id='${id}'`,
    `UPDATE communication_recipients SET email='tampered@example.invalid' WHERE message_id='${id}'`,
    `DELETE FROM communication_followups WHERE message_id='${id}'`,
    `DELETE FROM communication_requirements WHERE message_id='${id}'`,
    `UPDATE communication_messages SET status='Draft' WHERE id='${id}'`,
  ]) await fails(sql, "23514");
  await db.exec(`
    UPDATE contractors SET company_name='New company',dba_name='New DBA' WHERE id=1;
    UPDATE projects SET project_name='New project label' WHERE id=1;
    UPDATE contractor_followups SET subject='New follow-up subject' WHERE id=1;
    UPDATE compliance_types SET compliance_name='Changed requirement' WHERE id=1;
    UPDATE compliance_records SET expiration_date='2099-01-01' WHERE id=1;
    UPDATE mycoi_policies SET policy_line='New policy label' WHERE id=1;
    UPDATE user_profiles SET name='New creator label';
    UPDATE contractor_contacts SET contact_name='Changed contact',email='changed@example.invalid';
  `);
  assert.deepEqual(await get(), frozen, "Linked business changes cannot rewrite the scheduled record");
  await db.exec("SET ROLE service_role");
  await db.exec(plan(1, 4, "cancel", "null"));
  assert.equal((await get()).status, "Cancelled");
  assert.deepEqual((await get()).context_snapshot, frozen.context_snapshot);
  await fails(plan(1, 5), "22023");
  const cancelDraft = (await db.query(draftSQL(1, manualEmailDraft))).rows[0].id;
  await db.exec(`SELECT plan_communication('${actor(1)}','${cancelDraft}',1,'cancel',null)`);
  assert.equal((await db.query(`SELECT status FROM communication_messages WHERE id='${cancelDraft}'`)).rows[0].status, "Cancelled");

  // Existing deliberately requested delivery RPCs remain compatible, without any provider/network call.
  await db.exec("RESET ROLE");
  const revision = (await db.query("SELECT revision FROM communication_channel_settings WHERE channel='email'")).rows[0].revision;
  await db.exec(settingsSQL(7, "email", { ...msInput, revision, enabled: true, automated_enabled: false }));
  await db.exec("SET ROLE service_role");
  await db.exec(`SELECT record_microsoft_authentication('${actor(7)}',${revision + 1},null)`);
  const test = actor(982);
  await db.exec(`SELECT reserve_microsoft_test_email('${actor(7)}',${revision + 1},'${test}','test@example.invalid')`);
  await db.exec(`SELECT finish_microsoft_test_email('${actor(7)}',${revision + 1},'${test}','accepted')`);
  await db.exec(`SELECT reserve_communication_email_send('${actor(6)}','${legacySendDraft}',${revision + 1})`);
  await db.exec(`SELECT finish_communication_email_send('${actor(6)}','${legacySendDraft}','accepted')`);
  const legacySent = (await db.query(`SELECT * FROM communication_messages WHERE id='${legacySendDraft}'`)).rows[0];
  assert.equal(legacySent.status, "Sent");
  assert.equal(legacySent.template_revision, null);
  assert.equal(legacySent.context_snapshot.template, null);
  await db.exec("RESET ROLE");
  const currentRecipients = await recipients();
  await db.exec("SET ROLE service_role");
  const sent = (await db.query(draftSQL(1, { ...input, template_revision: 2, recipients: currentRecipients }))).rows[0].id;
  await db.exec(`SELECT reserve_communication_email_send('${actor(6)}','${sent}',${revision + 1})`);
  await db.exec(`SELECT finish_communication_email_send('${actor(6)}','${sent}','accepted')`);
  const historical = (await db.query(`SELECT * FROM communication_messages WHERE id='${sent}'`)).rows[0];
  const historicalRecipients = (await db.query(`SELECT * FROM communication_recipients WHERE message_id='${sent}' ORDER BY id`)).rows;
  assert.equal(historical.status, "Sent");
  assert.equal(historical.template_revision, 2);
  await db.exec("RESET ROLE");
  await db.exec(`UPDATE communication_templates SET body='Third template',revision=3;
    UPDATE contractors SET company_name='Third company',dba_name='Third DBA' WHERE id=1;
    UPDATE projects SET project_name='Third project' WHERE id=1;
    UPDATE contractor_followups SET subject='Third follow-up' WHERE contractor_id=1;
    UPDATE compliance_records SET expiration_date='2098-01-01' WHERE id=1;
    UPDATE contractor_contacts SET email='third@example.invalid',contact_name='Third contact';
    UPDATE dobco_contacts SET email='third-internal@example.invalid';
    UPDATE mycoi_policies SET policy_line='Third policy',expiration_date='2098-01-01' WHERE id=1`);
  assert.deepEqual((await db.query(`SELECT * FROM communication_messages WHERE id='${sent}'`)).rows[0], historical);
  assert.deepEqual((await db.query(`SELECT * FROM communication_recipients WHERE message_id='${sent}' ORDER BY id`)).rows, historicalRecipients);
  await fails(`UPDATE communication_messages SET subject='Rewrite sent' WHERE id='${sent}'`, "23514");
  await fails(`DELETE FROM communication_recipients WHERE message_id='${sent}'`, "23514");
  await db.exec("SET ROLE authenticated");
  await fails("SELECT * FROM communication_followups", "42501");
  await fails(plan(1, 4), "42501");
  await db.exec("RESET ROLE");
  assert.equal((await db.query("SELECT automated_enabled FROM communication_channel_settings WHERE channel='email'")).rows[0].automated_enabled, false);
  console.log("PASS: Communication 1B rollback/legacy preservation, authoritative Follow-Up/requirement/insurance chain, template version snapshots, cross-company/permission guards, inert schedule/cancel, frozen content/recipients/relationships, related-data edits, existing delivery RPC compatibility, no automation/network.");
}
