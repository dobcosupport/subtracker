import assert from "node:assert/strict";

export async function testRequirementNoticeFoundation({ db, read, fails, actor }) {
  const contact = actor(101), template = actor(990);
  await db.exec(`
    ALTER TABLE contractors ADD active boolean DEFAULT true,ADD material_vendor_only boolean DEFAULT false;
    ALTER TABLE compliance_records ADD active boolean DEFAULT true,ADD is_current boolean DEFAULT true;
    ALTER TABLE projects ADD status text DEFAULT 'Active',ADD public_works boolean DEFAULT true;
    CREATE TABLE contractor_projects(contractor_id integer,project_id integer,active boolean);
    CREATE TABLE company_merges(id uuid PRIMARY KEY,primary_id integer,secondary_id integer,successor_id integer);
    CREATE TABLE company_merge_lineage(merge_id uuid,category text,source_id text,before_row jsonb,after_row jsonb);
    CREATE FUNCTION company_merge_ancestors(p integer) RETURNS integer[] LANGUAGE sql STABLE AS $$ SELECT ARRAY[p] $$;
    INSERT INTO contractor_projects VALUES(1,1,true);
    CREATE FUNCTION nj_pwc_daily_contractor_eligible(p integer) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM contractors c JOIN contractor_projects cp ON cp.contractor_id=c.id
        JOIN projects p1 ON p1.id=cp.project_id WHERE c.id=p AND c.active AND NOT c.material_vendor_only
        AND cp.active AND p1.status='Active' AND p1.public_works)
    $$;
    CREATE TABLE mycoi_vendor_mappings(id integer PRIMARY KEY,contractor_id integer,active boolean);
    ALTER TABLE mycoi_policies ADD vendor_mapping_id integer,ADD policy_line_key text,
      ADD active boolean DEFAULT true,ADD is_current boolean DEFAULT true;
    UPDATE compliance_records SET expiration_date=CURRENT_DATE+30 WHERE id=1;
    UPDATE contractor_contacts SET is_active=true,receives_compliance_email=true,email='notice@example.invalid' WHERE id='${contact}';
    INSERT INTO communication_templates(id,name,category,channel,subject,body,is_active,revision)
      VALUES('${template}','Notice fixture','Expiration Reminder','email','Fixture subject','Fixture body',true,1);
    INSERT INTO communication_template_automation_approvals(template_id,template_revision,approved_by) VALUES('${template}',1,'${actor(1)}');
    UPDATE requirement_notification_rules SET automatic_enabled=true,schedule_type='expiration',eligibility_authority='nj_pwc_monitoring'
      WHERE compliance_type_id=1;
    INSERT INTO requirement_notification_intervals SELECT id,30,true,'${template}' FROM requirement_notification_rules WHERE compliance_type_id=1;
    UPDATE microsoft_email_connection_state SET settings_revision=(SELECT revision FROM communication_channel_settings WHERE channel='email'),
      authentication_status='Verified',delivery_status='Accepted by Graph';
  `);
  await db.exec(read("20261211_requirement_notice_preview.sql"));
  await db.exec(read("20261212_requirement_notice_reservation.sql"));
  const rule = (await db.query("SELECT id FROM requirement_notification_rules WHERE compliance_type_id=1")).rows[0].id;
  const preview = (await db.query(`SELECT preview_requirement_notice('${actor(1)}','${rule}',1,'${contact}',NULL) AS v`)).rows[0].v;
  delete preview.duplicate; delete preview.other_recipient_sent;
  const input = JSON.stringify(preview).replaceAll("'", "''");
  const make = isTest => `SELECT create_requirement_notice_draft('${actor(1)}','${rule}',1,'${contact}',NULL,'${input}'::jsonb,
    '${isTest ? "[TEST] Fixture notice" : "Fixture notice"}','Fixture body',${isTest}) AS id`;
  const test = (await db.query(make(true))).rows[0].id;
  const message = (await db.query(`SELECT status,revision,subject,template_id FROM communication_messages WHERE id='${test}'`)).rows[0];
  assert.equal(message.status, "Draft"); assert.equal(message.revision, 1); assert.equal(message.template_id, template);
  const recipient = (await db.query(`SELECT recipient_type,email,contractor_contact_id FROM communication_recipients WHERE message_id='${test}'`)).rows[0];
  assert.equal(recipient.recipient_type, "external"); assert.equal(recipient.email, "richg@dobcogroup.com"); assert.equal(recipient.contractor_contact_id, null);
  const settingsRevision = (await db.query("SELECT revision FROM communication_channel_settings WHERE channel='email'")).rows[0].revision;
  await fails(`SELECT reserve_communication_email_send('${actor(1)}','${test}',${settingsRevision})`, "42501");
  const reserved = (await db.query(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${test}',${settingsRevision},1) AS v`)).rows[0].v;
  assert.deepEqual(reserved.recipients, [{ email: "richg@dobcogroup.com" }]);
  await db.exec(`SELECT finish_communication_email_send('${actor(1)}','${test}','accepted')`);
  assert.equal((await db.query(`SELECT status FROM communication_messages WHERE id='${test}'`)).rows[0].status, "Sent");
  assert.equal((await db.query(`SELECT outcome FROM requirement_notice_delivery_outcomes WHERE message_id='${test}'`)).rows[0].outcome, "accepted");
  assert.equal((await db.query(`SELECT (preview_requirement_notice('${actor(1)}','${rule}',1,'${contact}',NULL)->>'duplicate')::boolean AS v`)).rows[0].v, false);
  const real = (await db.query(make(false))).rows[0].id;
  await db.query(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${real}',${settingsRevision},1)`);
  await db.exec(`SELECT finish_communication_email_send('${actor(1)}','${real}','graph_rejected')`);
  assert.equal((await db.query(`SELECT outcome FROM requirement_notice_delivery_outcomes WHERE message_id='${real}'`)).rows[0].outcome, "graph_rejected");
  const retry = (await db.query(make(false))).rows[0].id;
  await db.query(`SELECT reserve_reviewed_communication_email_send('${actor(1)}','${retry}',${settingsRevision},1)`);
  await db.exec(`SELECT finish_communication_email_send('${actor(1)}','${retry}','accepted')`);
  assert.equal((await db.query(`SELECT (preview_requirement_notice('${actor(1)}','${rule}',1,'${contact}',NULL)->>'duplicate')::boolean AS v`)).rows[0].v, true);
  await db.exec("SET ROLE service_role");
  await fails(`UPDATE requirement_notice_delivery_outcomes SET outcome='accepted' WHERE message_id='${real}'`, "42501");
  await fails(`SELECT finish_communication_email_send_before_notice('${actor(1)}','${real}','accepted')`, "42501");
  await fails(`SELECT reserve_communication_email_send_before_notice('${actor(1)}','${real}',${settingsRevision})`, "42501");
  await db.exec("RESET ROLE");
  assert.equal((await db.query("SELECT automated_enabled FROM communication_channel_settings WHERE channel='email'")).rows[0].automated_enabled, false);
  console.log("PASS: notice drafts use real communication foundation, history snapshots and provider reservation; test exclusion and definite-failure retry.");
}
