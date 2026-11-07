import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let db, secondConnection;
if (process.env.NOTICE_TEST_PG_URL) {
  const { Client } = require(process.env.PG_MODULE || "pg");
  const client = new Client({ connectionString: process.env.NOTICE_TEST_PG_URL });
  secondConnection = new Client({ connectionString: process.env.NOTICE_TEST_PG_URL });
  await client.connect(); await secondConnection.connect();
  db = { exec: sql => client.query(sql), query: (sql, params) => client.query(sql, params), close: async () => { await secondConnection.end(); await client.end(); } };
} else {
  const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
  db = await PGlite.create();
}
const actor = "00000000-0000-0000-0000-000000000001";
const rule = "00000000-0000-0000-0000-000000000002";
const template = "00000000-0000-0000-0000-000000000003";
const contact = "00000000-0000-0000-0000-000000000004";
const other = "00000000-0000-0000-0000-000000000005";
const message = "00000000-0000-0000-0000-000000000006";
const sentMessage = "00000000-0000-0000-0000-000000000007";
const preview = (contactId = contact, project = "NULL", actorId = actor) =>
  `SELECT preview_requirement_notice('${actorId}','${rule}',1,'${contactId}',${project}) AS result`;
const fails = (sql, code) => assert.rejects(db.exec(sql), error => error.code === code, sql);
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE actor_permissions(actor uuid,module text,allowed boolean);
    INSERT INTO actor_permissions SELECT '${actor}',m,true FROM unnest(ARRAY['settings','contractors','compliance','insurance','projects','communications_content','communications_delivery']) m;
    CREATE FUNCTION communication_actor_allowed(p uuid,m text,a text) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT coalesce((SELECT allowed FROM actor_permissions WHERE actor=p AND module=m),false)
    $$;
    CREATE TABLE contractors(id integer PRIMARY KEY,company_name text,dba_name text,active boolean,material_vendor_only boolean);
    CREATE TABLE contractor_contacts(id uuid PRIMARY KEY,contractor_id integer,contact_name text,email text,is_active boolean,receives_compliance_email boolean,mobile_phone text);
    CREATE TABLE company_merges(id uuid PRIMARY KEY,primary_id integer,secondary_id integer,successor_id integer);
    CREATE TABLE company_merge_lineage(merge_id uuid,category text,source_id text,before_row jsonb,after_row jsonb);
    CREATE FUNCTION company_merge_ancestors(p integer) RETURNS integer[] LANGUAGE sql STABLE AS $$
      WITH RECURSIVE a(id) AS (
        SELECT p UNION SELECT v.id FROM a JOIN company_merges m ON m.successor_id=a.id
        CROSS JOIN LATERAL (VALUES(m.primary_id),(m.secondary_id)) v(id)
      ) SELECT array_agg(id) FROM a
    $$;
    CREATE TABLE projects(id integer PRIMARY KEY,project_number text,project_name text,status text,public_works boolean);
    CREATE TABLE contractor_projects(contractor_id integer,project_id integer,active boolean);
    CREATE FUNCTION nj_pwc_daily_contractor_eligible(p integer) RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS(SELECT 1 FROM contractors c JOIN contractor_projects cp ON cp.contractor_id=c.id
        JOIN projects p1 ON p1.id=cp.project_id WHERE c.id=p AND c.active AND NOT c.material_vendor_only
        AND cp.active AND p1.status='Active' AND p1.public_works)
    $$;
    CREATE TABLE requirement_notification_rules(id uuid PRIMARY KEY,compliance_type_id integer,insurance_item_key text,
      automatic_enabled boolean,schedule_type text,eligibility_authority text,revision integer);
    CREATE TABLE compliance_types(id integer PRIMARY KEY,compliance_name text,active boolean,requires_expiration boolean);
    CREATE TABLE compliance_records(id integer PRIMARY KEY,contractor_id integer,compliance_type_id integer,expiration_date date,active boolean,is_current boolean);
    CREATE TABLE mycoi_vendor_mappings(id integer PRIMARY KEY,contractor_id integer,active boolean);
    CREATE TABLE mycoi_policies(id integer PRIMARY KEY,contractor_id integer,vendor_mapping_id integer,policy_line_key text,
      expiration_date date,active boolean,is_current boolean);
    CREATE TABLE communication_templates(id uuid PRIMARY KEY,revision integer,channel text,is_active boolean,subject text,body text);
    CREATE TABLE communication_template_automation_approvals(template_id uuid,template_revision integer);
    CREATE TABLE requirement_notification_intervals(rule_id uuid,days_before_expiration integer,enabled boolean,template_id uuid);
    CREATE TABLE communication_channel_settings(channel text,from_name text,from_address text);
    CREATE TABLE user_invitation_email_settings(organization_name text,application_name text);
    CREATE TABLE communication_messages(id uuid PRIMARY KEY,status text,failure_reason text,revision integer DEFAULT 1,
      template_id uuid,template_revision integer,subject text,body text);
    CREATE TABLE communication_recipients(message_id uuid,recipient_type text,email text,contractor_contact_id uuid,dobco_contact_id uuid);
    INSERT INTO contractors VALUES(1,'Legal Fixture','Trading Fixture',true,false);
    INSERT INTO contractor_contacts VALUES('${contact}',1,'Contact One','one@example.invalid',true,true,NULL),
      ('${other}',1,'Contact Two','two@example.invalid',true,true,NULL);
    INSERT INTO projects VALUES(1,'123','Fixture Project','Active',true);
    INSERT INTO contractor_projects VALUES(1,1,true);
    INSERT INTO requirement_notification_rules VALUES('${rule}',1,NULL,true,'expiration','nj_pwc_monitoring',1);
    INSERT INTO compliance_types VALUES(1,'Fixture Requirement',true,true);
    INSERT INTO compliance_records VALUES(1,1,1,CURRENT_DATE+30,true,true);
    INSERT INTO communication_templates VALUES('${template}',1,'email',true,'Subject {{contractor_name}}','Hello {{contact_name}}');
    INSERT INTO communication_template_automation_approvals VALUES('${template}',1);
    INSERT INTO requirement_notification_intervals VALUES('${rule}',30,true,'${template}');
    INSERT INTO communication_channel_settings VALUES('email','Sender','sender@example.invalid');
    INSERT INTO user_invitation_email_settings VALUES('Fixture','App');
  `);
  const migration = fs.readFileSync(new URL("../supabase/20261211_requirement_notice_preview.sql", import.meta.url), "utf8");
  assert.doesNotMatch(migration, /cron\.schedule|pg_net|http_post|reserve_communication_email_send/i);
  await fails(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  await db.exec(migration);
  await db.exec(`
    CREATE FUNCTION save_communication_draft(p_actor uuid,p_id uuid,p_input jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
    DECLARE result uuid:=gen_random_uuid(); rec jsonb;
    BEGIN
      INSERT INTO communication_messages(id,status,template_id,template_revision,subject,body)
      VALUES(result,'Draft',(p_input->>'template_id')::uuid,(p_input->>'template_revision')::integer,p_input->>'subject',p_input->>'body');
      FOR rec IN SELECT value FROM jsonb_array_elements(p_input->'recipients') LOOP
        INSERT INTO communication_recipients VALUES(result,rec->>'recipient_type',rec->>'email',
          (rec->>'contractor_contact_id')::uuid,(rec->>'dobco_contact_id')::uuid);
      END LOOP;
      RETURN result;
    END $$;
    CREATE FUNCTION reserve_communication_email_send(p_actor uuid,p_message_id uuid,p_settings_revision integer)
    RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE communication_messages SET status='Sending',revision=revision+1 WHERE id=p_message_id AND status='Draft';
      IF NOT FOUND THEN RAISE EXCEPTION 'Not a draft' USING ERRCODE='22023'; END IF;
      RETURN jsonb_build_object('id',p_message_id);
    END $$;
    CREATE FUNCTION reserve_reviewed_communication_email_send(uuid,uuid,integer,integer) RETURNS jsonb
      LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
    CREATE FUNCTION finish_communication_email_send(p_actor uuid,p_message_id uuid,p_outcome text) RETURNS void
      LANGUAGE plpgsql AS $$ BEGIN
        UPDATE communication_messages SET status=CASE WHEN p_outcome='accepted' THEN 'Sent' ELSE 'Failed' END
          WHERE id=p_message_id AND status='Sending';
        IF NOT FOUND THEN RAISE EXCEPTION 'Not sending' USING ERRCODE='22023'; END IF;
      END $$;
  `);
  const reservationMigration = fs.readFileSync(new URL("../supabase/20261212_requirement_notice_reservation.sql", import.meta.url), "utf8");
  assert.doesNotMatch(reservationMigration, /cron\.schedule|pg_net|http_post/i);
  await fails(reservationMigration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;"), "22012");
  await db.exec("ROLLBACK");
  await db.exec(reservationMigration);
  let result = (await db.query(preview(contact, "1"))).rows[0].result;
  assert.equal(result.company_name, "Legal Fixture"); assert.equal(result.dba_name, "Trading Fixture");
  assert.equal(result.contact_email, "one@example.invalid"); assert.equal(result.project_number, "123");
  assert.equal(result.days_remaining, 30); assert.equal(result.duplicate, false);
  await fails(preview(contact, "NULL", other), "42501");
  await db.exec("UPDATE actor_permissions SET allowed=false WHERE module='communications_delivery'");
  await fails(preview(), "42501");
  await db.exec("UPDATE actor_permissions SET allowed=true WHERE module='communications_delivery'; UPDATE actor_permissions SET allowed=false WHERE module='projects'");
  await fails(preview(contact, "1"), "42501");
  await db.exec("UPDATE actor_permissions SET allowed=true WHERE module='projects'; UPDATE requirement_notification_rules SET automatic_enabled=false");
  await fails(preview(), "22023");
  await db.exec("UPDATE requirement_notification_rules SET automatic_enabled=true,schedule_type='non_expiring'");
  await fails(preview(), "22023");
  await db.exec("UPDATE requirement_notification_rules SET schedule_type='expiration'; UPDATE requirement_notification_intervals SET enabled=false");
  await fails(preview(), "22023");
  await db.exec("UPDATE requirement_notification_intervals SET enabled=true; UPDATE compliance_types SET requires_expiration=false");
  await fails(preview(), "22023");
  await db.exec("UPDATE compliance_types SET requires_expiration=true; UPDATE compliance_records SET expiration_date=NULL");
  await fails(preview(), "22023");
  await db.exec("UPDATE compliance_records SET expiration_date=CURRENT_DATE+30; INSERT INTO compliance_records VALUES(2,1,1,CURRENT_DATE+30,true,true)");
  await fails(preview(), "22023");
  await db.exec("DELETE FROM compliance_records WHERE id=2");
  await db.exec("UPDATE contractor_projects SET active=false");
  await fails(preview(), "22023");
  await db.exec("UPDATE contractor_projects SET active=true; UPDATE contractors SET material_vendor_only=true");
  await fails(preview(), "22023");
  await db.exec("UPDATE contractors SET material_vendor_only=false; UPDATE projects SET status='Inactive'");
  await fails(preview(), "22023");
  await db.exec("UPDATE projects SET status='Active'; UPDATE compliance_records SET expiration_date=CURRENT_DATE+29");
  await fails(preview(), "22023");
  await db.exec("UPDATE compliance_records SET expiration_date=CURRENT_DATE+30; UPDATE communication_templates SET revision=2");
  await fails(preview(), "22023");
  await db.exec("UPDATE communication_templates SET revision=1");
  await db.exec(`UPDATE requirement_notification_rules SET compliance_type_id=NULL,insurance_item_key='general_liability',eligibility_authority='current_requirement';
    INSERT INTO mycoi_vendor_mappings VALUES(1,1,true),(2,1,false);
    INSERT INTO mycoi_policies VALUES(1,1,1,'general liability',CURRENT_DATE+30,true,true),
      (2,1,1,'general liability',CURRENT_DATE+60,true,true),(3,1,2,'general liability',CURRENT_DATE+90,true,true)`);
  await fails(preview(), "22023");
  await db.exec("UPDATE mycoi_policies SET is_current=false WHERE id=2");
  result = (await db.query(preview())).rows[0].result;
  assert.equal(result.requirement_name, "General Liability"); assert.equal(result.policy_id, 1);
  await db.exec("UPDATE requirement_notification_rules SET insurance_item_key='certificate_of_insurance'");
  await fails(preview(), "22023");
  await db.exec("UPDATE requirement_notification_rules SET insurance_item_key='workers_compensation'; UPDATE mycoi_policies SET policy_line_key='workers compensation' WHERE id=1");
  result = (await db.query(preview())).rows[0].result;
  assert.equal(result.requirement_name, "Workers Compensation"); assert.equal(result.policy_id, 1);
  await db.exec("UPDATE requirement_notification_rules SET compliance_type_id=1,insurance_item_key=NULL,eligibility_authority='nj_pwc_monitoring'");
  const noticeSnapshot = (await db.query(preview())).rows[0].result;
  delete noticeSnapshot.duplicate; delete noticeSnapshot.other_recipient_sent;
  const createNotice = async (test, subject = "Fixture notice", snapshot = noticeSnapshot) =>
    (await db.query("SELECT create_requirement_notice_draft($1,$2,1,$3,NULL,$4::jsonb,$5,$6,$7) AS id",
      [actor, rule, contact, JSON.stringify(snapshot), subject, "Fixture body", test])).rows[0].id;
  const reserve = id => `SELECT reserve_reviewed_communication_email_send('${actor}','${id}',1,1)`;
  await assert.rejects(createNotice(true), error => error.code === "22023");
  const redirected = await createNotice(true, "[TEST] Fixture notice");
  let saved = (await db.query(`SELECT n.is_test,n.intended_email,n.contact_id,r.email,r.contractor_contact_id
    FROM requirement_notice_communications n JOIN communication_recipients r ON r.message_id=n.message_id WHERE n.message_id='${redirected}'`)).rows[0];
  assert.equal(saved.is_test, true); assert.equal(saved.intended_email, "one@example.invalid");
  assert.equal(saved.contact_id, contact); assert.equal(saved.email, "richg@dobcogroup.com"); assert.equal(saved.contractor_contact_id, null);
  await fails(`SELECT save_communication_draft('${actor}','${redirected}','{}')`, "22023");
  await fails(`SELECT reserve_communication_email_send('${actor}','${redirected}',1)`, "42501");
  await db.exec(reserve(redirected));
  assert.equal((await db.query(preview())).rows[0].result.duplicate, false, "Test reservation never blocks the real interval");
  const first = await createNotice(false), competing = await createNotice(false);
  await db.exec(`UPDATE communication_messages SET revision=2 WHERE id='${competing}'`);
  await fails(reserve(competing), "40001");
  await db.exec(`UPDATE communication_messages SET revision=1 WHERE id='${competing}'; UPDATE contractor_projects SET active=false`);
  await fails(reserve(first), "22023");
  await db.exec("UPDATE contractor_projects SET active=true; UPDATE contractor_contacts SET email='changed@example.invalid' WHERE id='" + contact + "'");
  await fails(reserve(first), "40001");
  await db.exec("UPDATE contractor_contacts SET email='one@example.invalid' WHERE id='" + contact + "'; UPDATE communication_templates SET revision=2");
  await fails(reserve(first), "22023");
  await db.exec("UPDATE communication_templates SET revision=1");
  await db.exec(reserve(first));
  await fails(reserve(competing), "PT409");
  await db.exec(`UPDATE communication_messages SET status='Failed',failure_reason='Microsoft Email send failed: graph_rejected' WHERE id='${first}'`);
  await db.exec(reserve(competing));
  assert.equal((await db.query(preview())).rows[0].result.duplicate, true, "Only definite failures release the identity");
  await db.exec(`UPDATE communication_messages SET status='Failed',failure_reason='Microsoft Email send failed: graph_rejected' WHERE id='${competing}'`);
  if (secondConnection) {
    const mergeRace = await createNotice(false);
    await secondConnection.query("BEGIN; SELECT pg_advisory_xact_lock(hashtext('company_merge'))");
    let mergeWaitFinished = false;
    const mergeWait = db.query(reserve(mergeRace)).then(() => { mergeWaitFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(mergeWaitFinished, false, "Notice reservation must wait for an in-progress Company Merge");
    await secondConnection.query("COMMIT");
    await mergeWait;
    await db.exec(`UPDATE communication_messages SET status='Failed',failure_reason='Microsoft Email send failed: graph_rejected' WHERE id='${mergeRace}'`);
    const raceFirst = await createNotice(false), raceSecond = await createNotice(false);
    await db.exec("BEGIN");
    await db.exec(reserve(raceFirst));
    let finished = false;
    const secondResult = secondConnection.query(reserve(raceSecond)).then(
      () => ({ success: true }), error => ({ success: false, code: error.code }),
    ).then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(finished, false, "Competing reservation must wait for the identity lock");
    await db.exec("COMMIT");
    assert.deepEqual(await secondResult, { success: false, code: "PT409" }, "Only one concurrent identity may be reserved");
    await db.exec(`UPDATE communication_messages SET status='Failed',failure_reason='Microsoft Email send failed: graph_rejected' WHERE id='${raceFirst}'`);
    await db.exec(reserve(raceSecond));
    await db.exec(`UPDATE communication_messages SET status='Failed',failure_reason='Microsoft Email send failed: graph_rejected' WHERE id='${raceSecond}'`);
    console.log("PASS: real PostgreSQL concurrent reservation waits, rejects the duplicate and permits retry after definite failure.");
  }
  await db.exec(`INSERT INTO communication_messages(id,status) VALUES('${message}','Sent');
    INSERT INTO requirement_notice_communications(message_id,rule_id,contractor_id,contact_id,expiration_date,interval_days,intended_contact_name,intended_email,is_test,template_id,template_revision,preview_snapshot)
    VALUES('${message}','${rule}',1,'${contact}',CURRENT_DATE+30,30,'Contact One','one@example.invalid',true,'${template}',1,'{}')`);
  assert.equal((await db.query(preview())).rows[0].result.duplicate, false, "Redirected test never suppresses a notice");
  await fails(`UPDATE requirement_notice_communications SET is_test=false WHERE message_id='${message}'`, "42501");
  await fails(`DELETE FROM requirement_notice_communications WHERE message_id='${message}'`, "42501");
  await db.exec(`INSERT INTO communication_messages(id,status,failure_reason) VALUES('${sentMessage}','Failed','Provider outcome unknown. Do not retry automatically; review Logs and the mailbox before further action.');
    INSERT INTO requirement_notice_communications(message_id,rule_id,contractor_id,contact_id,expiration_date,interval_days,intended_contact_name,intended_email,is_test,template_id,template_revision,preview_snapshot)
    VALUES('${sentMessage}','${rule}',1,'${contact}',CURRENT_DATE+30,30,'Contact One','one@example.invalid',false,'${template}',1,'{}');
    INSERT INTO requirement_notice_delivery_outcomes VALUES('${sentMessage}','outcome_unknown',now())`);
  assert.equal((await db.query(preview())).rows[0].result.duplicate, true, "Unknown provider outcome must block repeat delivery");
  await db.exec(`UPDATE communication_messages SET status='Sent',failure_reason=NULL WHERE id='${sentMessage}'`);
  result = (await db.query(preview())).rows[0].result;
  assert.equal(result.duplicate, true);
  result = (await db.query(preview(other))).rows[0].result;
  assert.equal(result.duplicate, false); assert.equal(result.other_recipient_sent, true);
  await db.exec("UPDATE contractor_contacts SET is_active=false WHERE id='" + contact + "'");
  await fails(preview(), "22023");
  await db.exec("SET ROLE authenticated");
  await fails("SELECT * FROM requirement_notice_communications", "42501");
  await fails(preview(other), "42501");
  await db.exec("RESET ROLE");
  console.log("PASS: isolated notice preview revalidates authority, exact interval, current template/contact/project and permissions; explicit test/production identities and other-recipient indication.");
} finally { await db.close(); }
