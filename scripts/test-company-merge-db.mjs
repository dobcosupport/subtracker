import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("Company Merge with installed schema-shaped synthetic records only", async (t) => {
  const db = await PGlite.create();
  let inScenario = false;
  const query = async (sql, args = []) => {
    if (inScenario) await db.exec("SAVEPOINT assertion_query");
    try {
      const result = (await db.query(sql, args)).rows;
      if (inScenario) await db.exec("RELEASE SAVEPOINT assertion_query");
      return result;
    } catch (e) {
      if (inScenario) await db.exec("ROLLBACK TO SAVEPOINT assertion_query; RELEASE SAVEPOINT assertion_query");
      throw e;
    }
  };
  const one = async (sql, args) => (await query(sql, args))[0];
  const preview = async (primary = 9001, secondary = 9002, actor = uuid(1)) =>
    (await one("SELECT company_merge_preview($1,$2,$3) result", [primary, secondary, actor])).result;
  const options = async (changes = {}) => {
    const p = await preview();
    return {
      primary: 9001, secondary: 9002, snapshot: p.snapshot,
      choices: Object.fromEntries(p.fields.map((f) => [f, "primary"])),
      compliance: Object.fromEntries(p.compliance.map((c) => [c.compliance_type_id, c.records[0].id])),
      primaryContact: null, operation: uuid(100), confirmed: true, actor: uuid(1), ...changes,
    };
  };
  const merge = async (o) => (await one(
    "SELECT company_merge_execute($1,$2,$3,$4,$5,$6,$7,$8,$9) result",
    [o.primary, o.secondary, o.snapshot, JSON.stringify(o.choices), JSON.stringify(o.compliance),
      o.primaryContact, o.operation, o.confirmed, o.actor])).result;
  const seedMappingEvidence = async () => {
    await query("INSERT INTO mycoi_vendor_mappings(id,contractor_id,raw_vendor_name) VALUES(5001,9001,'Synthetic Vendor')");
    await query("INSERT INTO mycoi_division_mappings(id,raw_division_name,project_id) VALUES(5002,'Synthetic Division',8001)");
    await query(`INSERT INTO mycoi_contractor_divisions(id,vendor_mapping_id,division_mapping_id,last_imported_at,import_reference)
      VALUES(5003,5001,5002,now(),'synthetic')`);
    await query(`INSERT INTO mycoi_policies(id,contractor_id,vendor_mapping_id,policy_line,last_imported_at,import_reference)
      VALUES(5004,9001,5001,'General Liability',now(),'synthetic')`);
    await query("INSERT INTO mycoi_policy_divisions(policy_id,contractor_division_id,vendor_mapping_id) VALUES(5004,5003,5001)");
    await query("INSERT INTO import_history(id,file_name) VALUES(4001,'Synthetic Procore')");
    await query("INSERT INTO procore_import_runs(id,file_name,created_by,source_rows) VALUES($1,'Synthetic.xlsx',$2,'[{\"row\":2}]')", [uuid(50), uuid(1)]);
    await query("INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,accepted_by,import_run_id,import_history_id) VALUES('synthetic vendor','Synthetic Vendor',9002,$1,$2,4001)", [uuid(1), uuid(50)]);
    await query("INSERT INTO procore_import_lineage(import_run_id,import_history_id,source_row,contractor_id,project_id,actor_id,evidence) VALUES($1,4001,2,9002,8001,$2,'{\"synthetic\":true}')", [uuid(50), uuid(1)]);
  };
  const scenario = async (name, fn) => t.test(name, async () => {
    await db.exec("BEGIN"); inScenario = true;
    try { await fn(); } finally { inScenario = false; await db.exec("ROLLBACK"); }
  });
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT null::uuid$$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql AS $$SELECT current_user::text$$;
    `);
    await db.exec(fs.readFileSync(path.join(root, "scripts", "fixtures", "company-merge-installed-schema.sql"), "utf8"));
    await db.exec(`
      INSERT INTO app_roles(role,is_system) VALUES('Administrator',true),('Merge Operator',false),('Reader',false);
      INSERT INTO auth.users VALUES('${uuid(1)}'),('${uuid(2)}'),('${uuid(3)}');
      INSERT INTO user_profiles(auth_user_id,name,email,role,system_administrator) VALUES
        ('${uuid(1)}','Synthetic Admin','admin@example.invalid','Administrator',true),
        ('${uuid(2)}','Synthetic Reader','reader@example.invalid','Reader',false),
        ('${uuid(3)}','Synthetic Operator','operator@example.invalid','Merge Operator',false);
      INSERT INTO relationship_sources VALUES('MANUAL'),('MYCOI'),('PROCORE');
      INSERT INTO contractors(id,company_name) VALUES(9001,'Synthetic Primary'),(9002,'Synthetic Secondary'),(9003,'Synthetic Peer');
      INSERT INTO projects(id,project_number,project_name,public_works) VALUES(8001,'SYN-1','Synthetic Project',false),(8002,'SYN-2','Synthetic Other',true);
      INSERT INTO compliance_types(id,compliance_name,requires_expiration) VALUES(6001,'NJ PWC',true),(6002,'NJ BRC',false);
    `);
    const before = await query("SELECT to_jsonb(c) data FROM contractors c ORDER BY id");
    await db.exec(fs.readFileSync(path.join(root, "supabase", "20261121_company_merge.sql"), "utf8"));
    assert.deepEqual(await query("SELECT to_jsonb(c)-'merged_into_contractor_id' data FROM contractors c ORDER BY id"),
      before, "Migration must not merge or alter existing contractor data");
    assert.equal((await one("SELECT count(*)::int n FROM company_merges")).n, 0);
    assert.ok((await preview()).blockers.some((message) => message.includes("Unrecognized contractor dependency")),
      "The installed-schema fixture must reproduce the newly introduced BRC membership FK");
    await db.exec(fs.readFileSync(path.join(root, "supabase", "20261205_company_merge_brc_session_preservation.sql"), "utf8"));
    assert.deepEqual(await query("SELECT to_jsonb(c)-'merged_into_contractor_id' data FROM contractors c ORDER BY id"),
      before, "The corrective migration must not modify contractor data");
    assert.equal((await preview()).blockers.length, 0, "Known dependencies must not produce a false catalogue blocker");
    assert.equal((await preview()).counts.nj_brc_verification_session_members.primary, 0);

    await scenario("dedicated permission, inactive actor and no direct capability grants", async () => {
      await assert.rejects(preview(9001, 9002, uuid(2)), (e) => e.code === "42501");
      await query("UPDATE role_permissions SET can_view=true,can_manage=true WHERE role='Merge Operator' AND module='company_merge'");
      assert.equal((await preview(9001, 9002, uuid(3))).primary.id, 9001);
      await query("UPDATE user_profiles SET status='Inactive' WHERE auth_user_id=$1", [uuid(3)]);
      await assert.rejects(preview(9001, 9002, uuid(3)), (e) => e.code === "42501");
      for (const role of ["anon", "authenticated", "service_role"]) {
        await db.exec(`SET ROLE ${role}`);
        await assert.rejects(query("INSERT INTO company_merge_authorizations VALUES(pg_backend_pid(),txid_current(),$1)", [uuid(100)]), (e) => e.code === "42501");
        if (role !== "service_role") await assert.rejects(preview(), (e) => e.code === "42501");
        await db.exec("RESET ROLE");
      }
    });
    await scenario("preview is read-only, distinct companies, confirmation, stale fields and exact replay", async () => {
      await assert.rejects(preview(9001, 9001), (e) => e.code === "22023");
      const o = await options();
      assert.equal((await one("SELECT count(*)::int n FROM company_merges")).n, 0);
      await assert.rejects(merge({ ...o, confirmed: false }), (e) => e.code === "22023");
      await assert.rejects(merge({ ...o, choices: { ...o.choices, company_name: null } }), (e) => e.code === "22023");
      await assert.rejects(merge({ ...o, choices: { ...o.choices, company_name: "altered browser name" } }), (e) => e.code === "22023");
      await query("UPDATE contractors SET city='Changed' WHERE id=9002");
      await assert.rejects(merge(o), (e) => e.code === "40001");
      const current = await options();
      const result = await merge(current);
      assert.ok(![9001, 9002, 9003].includes(result.successor_id));
      assert.equal((await merge(current)).successor_id, result.successor_id);
      assert.equal((await merge(current)).already_processed, true);
      await assert.rejects(merge({ ...current, choices: { ...current.choices, city: "secondary" } }), (e) => e.code === "40001");
      assert.equal((await one("SELECT count(*)::int n FROM company_merges")).n, 1);
    });
    await scenario("project collision union, source lineage and future imported ownership removal", async () => {
      await query(`INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES
        (9001,8001,ARRAY['MYCOI']),(9002,8001,ARRAY['PROCORE']),(9002,8002,ARRAY['MANUAL'])`);
      const p = await preview();
      assert.deepEqual(p.projects, { primary: 1, secondary: 2, shared: 1, union: 2 });
      const r = await merge(await options());
      const live = await query("SELECT project_id,ownership_sources FROM contractor_projects WHERE contractor_id=$1 AND active ORDER BY project_id", [r.successor_id]);
      assert.equal(live.length, 2);
      assert.deepEqual(live[0].ownership_sources, ["MERGE", "MYCOI", "PROCORE"]);
      assert.ok(!live[0].ownership_sources.includes("MANUAL"));
      await query("SELECT set_project_assignment_source($1,8001,'MYCOI',false)", [r.successor_id]);
      await query("SELECT set_project_assignment_source($1,8001,'PROCORE',false)", [r.successor_id]);
      assert.equal((await one("SELECT active FROM contractor_projects WHERE contractor_id=$1 AND project_id=8001", [r.successor_id])).active, true);
      assert.equal((await one("SELECT count(*)::int n FROM contractor_projects WHERE contractor_id IN(9001,9002) AND NOT active")).n, 3);
      assert.equal((await one("SELECT count(*)::int n FROM company_merge_lineage WHERE category='contractor_projects' AND after_row IS NOT NULL")).n, 3);
    });
    await scenario("contacts preserve UUID, consent, business phone and sent Communications references", async () => {
      await query(`INSERT INTO contractor_contacts(id,contractor_id,contact_name,is_primary_contact,sms_consent_recorded,sms_consent_date,business_phone)
        VALUES($1,9001,'Synthetic One',true,true,'2026-01-01','201-555-0101'),($2,9002,'Synthetic Two',true,false,null,null)`, [uuid(10), uuid(11)]);
      await query("INSERT INTO communication_messages(id,channel,body,status) VALUES($1,'email','Synthetic sent history','Sent')", [uuid(20)]);
      await query("INSERT INTO communication_recipients(message_id,recipient_type,recipient_name,contractor_contact_id) VALUES($1,'contractor_contact','Original sent name',$2)", [uuid(20), uuid(10)]);
      await query("SELECT set_config('app.company_merge_authorized','true',true)");
      await assert.rejects(query("UPDATE contractor_contacts SET contractor_id=9003 WHERE id=$1", [uuid(10)]), (e) => e.code === "23514");
      await assert.rejects(merge(await options()), (e) => e.code === "22023");
      const r = await merge(await options({ primaryContact: uuid(11) }));
      const contacts = await query("SELECT id,contractor_id,is_primary_contact,sms_consent_recorded,business_phone FROM contractor_contacts ORDER BY id");
      assert.equal(contacts.length, 2);
      assert.equal(contacts[0].id, uuid(10));
      assert.equal(contacts[0].sms_consent_recorded, true);
      assert.equal(contacts[0].business_phone, "201-555-0101");
      assert.equal(contacts[0].contractor_id, r.successor_id);
      assert.equal(contacts[1].is_primary_contact, true);
      assert.equal((await one("SELECT recipient_name FROM communication_recipients")).recipient_name, "Original sent name");
    });
    await scenario("tiered subs remap both directions, consolidate collisions and retire self-collapse as history", async () => {
      await query(`INSERT INTO contractor_tiered_subs(contractor_id,tiered_sub_contractor_id) VALUES
        (9001,9003),(9002,9003),(9001,9002)`);
      const r = await merge(await options());
      const edges = await query("SELECT contractor_id,tiered_sub_contractor_id FROM contractor_tiered_subs WHERE active");
      assert.deepEqual(edges, [{ contractor_id: r.successor_id, tiered_sub_contractor_id: 9003 }]);
      assert.equal((await one("SELECT count(*)::int n FROM contractor_tiered_subs WHERE NOT active")).n, 3);
      assert.equal((await one("SELECT count(*)::int n FROM company_merge_lineage WHERE category='contractor_tiered_subs' AND after_row->>'retired_internal_edge'='true'")).n, 1);
    });
    await scenario("explicit current compliance winner, identifiers, permanent losing history and ancestor exclusions", async () => {
      await query(`INSERT INTO compliance_records(id,contractor_id,compliance_type_id,registration_number,effective_date,expiration_date)
        VALUES(7001,9001,6001,'SYN-A','2026-01-01','2027-01-01'),(7002,9002,6001,'SYN-B','2026-01-01','2028-01-01')`);
      const o = await options({ compliance: { 6001: 7002 } });
      await assert.rejects(merge({ ...o, compliance: {} }), (e) => e.code === "22023");
      await assert.rejects(merge({ ...o, compliance: { 6001: 9999 } }), (e) => e.code === "40001");
      const r = await merge(o);
      assert.equal((await one("SELECT nj_pwc_number FROM contractors WHERE id=$1", [r.successor_id])).nj_pwc_number, "SYN-B");
      assert.deepEqual(await one("SELECT contractor_id,active,is_current FROM compliance_records WHERE id=7001"),
        { contractor_id: 9001, active: false, is_current: false });
      assert.deepEqual(await one("SELECT contractor_id,active,is_current FROM compliance_records WHERE id=7002"),
        { contractor_id: r.successor_id, active: true, is_current: true });
      assert.equal((await one("SELECT count(*)::int n FROM compliance_records")).n, 2);
      assert.deepEqual((await one("SELECT company_merge_ancestors($1) ids", [r.successor_id])).ids.sort((a, b) => a - b),
        [r.successor_id, 9001, 9002].sort((a, b) => a - b));
    });
    await scenario("myCOI composite policy identity and Procore mapping retirement require explicit rematch", async () => {
      await seedMappingEvidence();
      await query("INSERT INTO contractor_insurance(contractor_id,certificate_on_file,last_verified_date) VALUES(9001,true,'2026-01-02')");
      await query("INSERT INTO contractor_insurance_history(contractor_id,coi_on_file,verified_date) VALUES(9001,true,'2026-01-02'),(9002,false,'2026-01-03')");
      const impact = await preview();
      assert.equal(impact.counts.mycoi_contractor_divisions.primary, 1);
      assert.equal(impact.counts.mycoi_division_mappings.primary, 1);
      assert.equal(impact.counts.mycoi_policy_divisions.primary, 1);
      const r = await merge(await options());
      assert.deepEqual(await query("SELECT contractor_id,certificate_on_file,to_char(last_verified_date,'YYYY-MM-DD') last_verified_date FROM contractor_insurance ORDER BY contractor_id"),
        [{ contractor_id: 9001, certificate_on_file: true, last_verified_date: "2026-01-02" }]);
      assert.deepEqual(await query("SELECT contractor_id,coi_on_file,to_char(verified_date,'YYYY-MM-DD') verified_date FROM contractor_insurance_history ORDER BY id"),
        [{ contractor_id: 9001, coi_on_file: true, verified_date: "2026-01-02" },
          { contractor_id: 9002, coi_on_file: false, verified_date: "2026-01-03" }]);
      assert.equal((await one("SELECT count(*)::int n FROM company_merge_lineage WHERE category='contractor_insurance'")).n, 1);
      assert.equal((await one("SELECT count(*)::int n FROM company_merge_lineage WHERE category='contractor_insurance_history'")).n, 2);
      assert.equal((await one("SELECT active FROM mycoi_vendor_mappings WHERE id=5001")).active, false);
      assert.equal((await one("SELECT contractor_id FROM mycoi_policies")).contractor_id, 9001);
      assert.deepEqual(await one("SELECT policy_id,contractor_division_id,vendor_mapping_id FROM mycoi_policy_divisions"),
        { policy_id: 5004, contractor_division_id: 5003, vendor_mapping_id: 5001 });
      assert.equal((await one("SELECT count(*)::int n FROM procore_vendor_mappings")).n, 0);
      assert.equal((await one("SELECT count(*)::int n FROM company_merge_lineage WHERE category='procore_vendor_mappings'")).n, 1);
      for (const name of ["mycoi_import_reference", "procore_import_reference"]) {
        const reference = (await one(`SELECT ${name}() result`)).result;
        assert.ok(!reference.contractors.some((c) => [9001, 9002].includes(c.id)));
        assert.ok(reference.contractors.some((c) => c.id === r.successor_id));
      }
      assert.equal((await one("SELECT contractor_id FROM procore_import_lineage")).contractor_id, 9002);
      await assert.rejects(query("INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,accepted_by,import_run_id,import_history_id) VALUES('stale','Stale',9001,$1,$2,4001)", [uuid(1), uuid(50)]), (e) => e.code === "23514");
      await query("INSERT INTO procore_vendor_mappings(vendor_key,raw_vendor_name,contractor_id,accepted_by,import_run_id,import_history_id) VALUES('explicit rematch','Rematched',$1,$2,$3,4001)", [r.successor_id, uuid(1), uuid(50)]);
    });
    await scenario("open BRC verification sessions block merges and stopped-session evidence stays with its predecessor", async () => {
      await query("INSERT INTO nj_brc_verification_sessions(id,status,member_count,created_by,updated_by) VALUES($1,'paused',1,$2,$2)",
        [uuid(501), uuid(1)]);
      await query("INSERT INTO nj_brc_verification_session_members(session_id,contractor_id,ordinal,state) VALUES($1,9002,1,'prepared')",
        [uuid(501)]);
      for (const status of ["prepared", "paused"]) {
        await query("UPDATE nj_brc_verification_sessions SET status=$2 WHERE id=$1", [uuid(501), status]);
        const openPreview = await preview();
        assert.equal(openPreview.counts.nj_brc_verification_session_members.secondary, 1);
        assert.ok(openPreview.blockers.some((message) => message.includes("Open NJ BRC verification session")));
        await assert.rejects(merge(await options()), (error) => error.code === "55000");
      }

      await query("UPDATE nj_brc_verification_sessions SET status='stopped' WHERE id=$1", [uuid(501)]);
      await query("UPDATE nj_brc_verification_session_members SET state='skipped',skipped_at=now() WHERE session_id=$1", [uuid(501)]);
      const stoppedBefore = await one("SELECT to_jsonb(m) row FROM nj_brc_verification_session_members m");
      const stoppedPreview = await preview();
      assert.equal(stoppedPreview.blockers.length, 0);
      const result = await merge(await options());
      assert.deepEqual(await one("SELECT to_jsonb(m) row FROM nj_brc_verification_session_members m"), stoppedBefore);
      const lineage = await one(`SELECT before_row,after_row FROM company_merge_lineage
        WHERE merge_id=$1 AND category='nj_brc_verification_session_members'`, [uuid(100)]);
      assert.equal(lineage.before_row.contractor_id, 9002);
      assert.equal(lineage.after_row.contractor_id, 9002);
      assert.equal(lineage.after_row.preserved_on_predecessor, true);
      assert.equal(lineage.after_row.session_status, "stopped");
      assert.equal((await one("SELECT merged_into_contractor_id FROM contractors WHERE id=9002")).merged_into_contractor_id,
        result.successor_id);
      await assert.rejects(query("UPDATE nj_brc_verification_session_members SET ordinal=2 WHERE session_id=$1", [uuid(501)]),
        (error) => error.code === "23514");
      await assert.rejects(query("INSERT INTO nj_brc_verification_session_members(session_id,contractor_id,ordinal,state) VALUES($1,9002,2,'prepared')",
        [uuid(502)]), (error) => error.code === "23514");
    });
    await scenario("archive guards prevent reactivation, identity reuse, deletion and stale operational writes", async () => {
      await merge(await options());
      for (const sql of [
        "UPDATE contractors SET active=true WHERE id=9001",
        "UPDATE contractors SET merged_into_contractor_id=null WHERE id=9001",
        "UPDATE contractors SET id=9004 WHERE id=9001",
        "DELETE FROM contractors WHERE id=9001",
        "INSERT INTO contractor_contacts(contractor_id,contact_name) VALUES(9001,'Stale')",
        "INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES(9001,8001,ARRAY['MANUAL'])",
      ]) await assert.rejects(query(sql), (e) => e.code === "23514");
      await assert.rejects(preview(), (e) => e.code === "40001");
      await assert.rejects(query("INSERT INTO contractors(company_name,creation_source) VALUES('Forged','MERGE')"), (e) => e.code === "23514");
    });
    await scenario("open exceptions, pending requests, working imports and unsent Communications block", async () => {
      await query("INSERT INTO nj_pwc_sync_exceptions(contractor_id,reason,kind) VALUES(9001,'Multiple Matches','failure')");
      assert.ok((await preview()).blockers.some((s) => /exception/i.test(s)));
      await assert.rejects(merge(await options()), (e) => e.code === "55000");
      await query("DELETE FROM nj_pwc_sync_exceptions");
      await query("INSERT INTO procore_import_runs(file_name,created_by,source_rows,decisions) VALUES('Synthetic.xlsx',$1,'[{\"row\":2}]',$2)", [uuid(1), JSON.stringify({ vendors: { synthetic: { action: "MATCH", contractorId: 9001 } } })]);
      assert.ok((await preview()).blockers.some((s) => /unfinished import/i.test(s)));
    });
    await scenario("administrative unlink exclusions survive a merge and original unlink rows stay immutable", async () => {
      await query(`INSERT INTO compliance_records(id,contractor_id,compliance_type_id,registration_number,active,is_current)
        VALUES(7001,9001,6001,'BLOCK-123',false,false)`);
      await query(`INSERT INTO compliance_record_unlinks(record_id,contractor_id,compliance_type_id,registration_key,reason,unlinked_by)
        VALUES(7001,9001,6001,'BLOCK123','Synthetic administrative unlink',$1)`, [uuid(1)]);
      const r = await merge(await options());
      assert.equal((await one("SELECT contractor_id FROM compliance_record_unlinks")).contractor_id, 9001);
      await assert.rejects(query(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number)
        VALUES($1,6001,'block 123')`, [r.successor_id]), /unlinked/);
      await assert.rejects(query("UPDATE compliance_records SET contractor_id=$1 WHERE id=7001", [r.successor_id]), (e) => e.code === "23514");
    });
    await scenario("a new tiered cycle is blocked instead of silently creating invalid relationships", async () => {
      await query("INSERT INTO contractor_tiered_subs(contractor_id,tiered_sub_contractor_id,assigned_date) VALUES(9001,9003,'2026-01-01'),(9003,9002,'2026-01-01')");
      assert((await preview()).blockers.some((message) => message.includes("cycle")));
      await assert.rejects(merge(await options()), (e) => e.code === "55000");
    });
    await scenario("unrecognized new foreign key columns on known dependency tables fail closed", async () => {
      await query("ALTER TABLE documents ADD COLUMN synthetic_company_id INTEGER REFERENCES contractors(id)");
      assert((await preview()).blockers.some((message) => message.includes("Unrecognized contractor dependency")));
      await assert.rejects(merge(await options()), (e) => e.code === "55000");
    });
    await scenario("unknown future contractor dependency tables fail closed", async () => {
      await query("CREATE TABLE synthetic_future_contractor_links(id integer PRIMARY KEY, contractor_id integer REFERENCES contractors(id))");
      assert((await preview()).blockers.some((message) => message.includes("Unrecognized contractor dependency")));
      await assert.rejects(merge(await options()), (e) => e.code === "55000");
    });
    await scenario("pending registry/review, unfinished MyCOI, followups and reminders independently block", async () => {
      await query("INSERT INTO compliance_sync_search_requests(contractor_id,searched_company_name,origin,status) VALUES(9001,'Synthetic','user','pending')");
      assert((await preview()).blockers.some((value) => value.includes("registry search")));
      await query("DELETE FROM compliance_sync_search_requests");
      await query(`INSERT INTO nj_brc_search_requests(contractor_id,company_name,brc_name_control,federal_tax_id,taxpayer_id_submission)
        VALUES(9001,'Synthetic','SYNT','123456789','123456789000')`);
      assert((await preview()).blockers.some((value) => value.includes("BRC")));
      await query("DELETE FROM nj_brc_search_requests");
      await query("INSERT INTO compliance_sync_review_queue(contractor_id,compliance_name,exception_message) VALUES(9002,'NJ PWC','Synthetic pending')");
      assert((await preview()).blockers.some((value) => value.includes("review")));
      await query("DELETE FROM compliance_sync_review_queue");
      await query("INSERT INTO mycoi_import_runs(file_name,created_by,source_rows,decisions) VALUES('Synthetic.xlsx',$1,'[{\"row\":2}]',$2)", [uuid(1), JSON.stringify({ vendors: { synthetic: 9001 } })]);
      assert((await preview()).blockers.some((value) => value.includes("unfinished import")));
      await query("DELETE FROM mycoi_import_runs");
      await query("INSERT INTO contractor_followups(contractor_id,subject,followup_date,followup_method) VALUES(9001,'Synthetic','2026-10-27','Email')");
      assert((await preview()).blockers.some((value) => value.includes("follow-up")));
      await query("DELETE FROM contractor_followups");
      await query("INSERT INTO compliance_records(id,contractor_id,compliance_type_id) VALUES(7001,9001,6001)");
      await query(`INSERT INTO reminders(contractor_id,compliance_record_id,reminder_stage,expiration_date_snapshot,scheduled_date)
        VALUES(9001,7001,'30 Day','2026-12-01','2026-11-01')`);
      assert((await preview()).blockers.some((value) => value.includes("reminder")));
    });
    await scenario("terminal BRC immutable snapshots stay original and merge never queues registry work", async () => {
      await query(`INSERT INTO nj_brc_search_requests(contractor_id,company_name,brc_name_control,federal_tax_id,taxpayer_id_submission,status)
        VALUES(9001,'Synthetic','SYNT','123456789','123456789000','no_match')`);
      const before = (await one("SELECT to_jsonb(r) row FROM nj_brc_search_requests r")).row;
      await merge(await options());
      assert.deepEqual((await one("SELECT to_jsonb(r) row FROM nj_brc_search_requests r")).row, before);
      assert.equal((await one("SELECT count(*)::int n FROM compliance_sync_search_requests")).n, 0);
      assert.equal((await one("SELECT count(*)::int n FROM compliance_sync_review_queue")).n, 0);
      assert.equal((await one("SELECT count(*)::int n FROM nj_pwc_sync_state")).n, 0);
    });
    await scenario("indirect Communications are counted; drafts block and sent evidence keeps record IDs", async () => {
      await query("INSERT INTO compliance_records(id,contractor_id,compliance_type_id) VALUES(7001,9001,6001)");
      await query("INSERT INTO communication_messages(id,channel,subject,body,status) VALUES($1,'email','Synthetic','Body','Draft')", [uuid(91)]);
      await query("INSERT INTO communication_compliance_items(message_id,compliance_record_id) VALUES($1,7001)", [uuid(91)]);
      assert.equal((await preview()).counts.communication_messages.primary, 1);
      assert((await preview()).blockers.some((value) => value.includes("communication")));
      await assert.rejects(merge(await options()), (e) => e.code === "55000");
      await query("UPDATE communication_messages SET status='Sent' WHERE id=$1", [uuid(91)]);
      const r = await merge(await options());
      assert.equal((await one("SELECT contractor_id FROM compliance_records WHERE id=7001")).contractor_id, r.successor_id);
      assert.equal((await one("SELECT compliance_record_id FROM communication_compliance_items")).compliance_record_id, 7001);
    });
    await scenario("successors can be merged again with complete recursive permanent ancestry", async () => {
      await query("INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES(9001,8001,ARRAY['MANUAL'])");
      const successor = (await merge(await options())).successor_id;
      const next = await preview(successor, 9003);
      const second = await merge({
        primary: successor, secondary: 9003, snapshot: next.snapshot, operation: uuid(101),
        choices: Object.fromEntries(next.fields.map((field) => [field, "primary"])),
        compliance: {}, primaryContact: null, confirmed: true, actor: uuid(1),
      });
      assert.deepEqual((await one("SELECT company_merge_ancestors($1) ids", [second.successor_id])).ids.sort((a, b) => a - b),
        [9001, 9002, 9003, successor, second.successor_id].sort((a, b) => a - b));
      assert.equal((await one("SELECT count(*)::int n FROM company_merges")).n, 2);
      await assert.rejects(query("DELETE FROM company_merge_lineage"), (e) => e.code === "42501");
      await assert.rejects(query("UPDATE company_merges SET choices='{}'"), (e) => e.code === "42501");
    });
    await scenario("late failure rolls back created identity, relationships, mappings, receipts and audit", async () => {
      await query("INSERT INTO contractor_projects(contractor_id,project_id,ownership_sources) VALUES(9001,8001,ARRAY['MYCOI'])");
      await query("INSERT INTO contractor_contacts(contractor_id,contact_name) VALUES(9002,'Rollback Person')");
      await query("INSERT INTO compliance_records(id,contractor_id,compliance_type_id,registration_number) VALUES(7001,9001,6001,'SYN-ROLLBACK')");
      await seedMappingEvidence();
      await db.exec(`CREATE FUNCTION synthetic_merge_failure() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.action='COMPANIES_MERGED' THEN RAISE EXCEPTION 'Synthetic late failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER synthetic_merge_failure BEFORE INSERT ON administration_audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_merge_failure();`);
      const counts = async () => one(`SELECT (SELECT count(*) FROM contractors)::int contractors,
        (SELECT count(*) FROM contractor_projects)::int projects,(SELECT count(*) FROM contractor_contacts)::int contacts,
        (SELECT count(*) FROM company_merges)::int merges,(SELECT count(*) FROM company_merge_lineage)::int lineage,
        (SELECT count(*) FROM administration_audit_log)::int audits`);
      const before = await counts();
      await assert.rejects(merge(await options()), /Synthetic late failure/);
      assert.deepEqual(await counts(), before);
      assert.equal((await one("SELECT active FROM mycoi_vendor_mappings WHERE id=5001")).active, true);
      assert.equal((await one("SELECT contractor_id FROM procore_vendor_mappings")).contractor_id, 9002);
      assert.equal((await one("SELECT contractor_id FROM compliance_records WHERE id=7001")).contractor_id, 9001);
      assert.equal((await one("SELECT active FROM contractor_projects")).active, true);
      assert.equal((await one("SELECT contractor_id FROM contractor_contacts")).contractor_id, 9002);
      assert.equal((await one("SELECT count(*)::int n FROM company_merge_authorizations")).n, 0);
    });

    await db.exec(`
      ALTER TABLE contractors ADD COLUMN dba_name text;
      CREATE FUNCTION communication_actor_allowed(uuid,text,text) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
      CREATE TABLE requirement_notification_rules(id uuid PRIMARY KEY,compliance_type_id integer,insurance_item_key text,
        automatic_enabled boolean,schedule_type text,eligibility_authority text,revision integer);
      CREATE TABLE requirement_notification_intervals(rule_id uuid,days_before_expiration integer,enabled boolean,template_id uuid);
      CREATE TABLE communication_template_automation_approvals(template_id uuid,template_revision integer);
    `);
    await db.exec(fs.readFileSync(path.join(root, "supabase", "20261211_requirement_notice_preview.sql"), "utf8"));
    assert.ok((await preview()).blockers.some((message) => message.includes("Unrecognized contractor dependency")));
    await db.exec(fs.readFileSync(path.join(root, "supabase", "20261213_company_merge_requirement_notices.sql"), "utf8"));
    assert.equal((await preview()).blockers.length, 0, "Known notice history must not block all Company Merges");

    await scenario("requirement notice identity follows verified contact transfers across merges without rewriting history", async () => {
      const notice = uuid(801), testNotice = uuid(802), firstContact = uuid(803), secondContact = uuid(804);
      const earlierNotice = uuid(807);
      const rule = uuid(805), template = uuid(806);
      await query("INSERT INTO compliance_types(id,compliance_name,requires_expiration) VALUES(6003,'Synthetic expiring requirement',true)");
      await query("INSERT INTO compliance_records(id,contractor_id,compliance_type_id,expiration_date) VALUES(7003,9001,6003,CURRENT_DATE+30)");
      await query(`INSERT INTO contractor_contacts(id,contractor_id,contact_name,email,receives_compliance_email)
        VALUES($1,9001,'Original Contact','original@example.invalid',true),($2,9002,'Different Contact','other@example.invalid',true)`,
        [firstContact, secondContact]);
      await query("INSERT INTO communication_templates(id,name,category,channel,subject,body,is_active) VALUES($1,'Notice','Expiration Reminder','email','Subject','Body',true)", [template]);
      await query("INSERT INTO communication_template_automation_approvals VALUES($1,1)", [template]);
      await query("INSERT INTO requirement_notification_rules VALUES($1,6003,NULL,true,'expiration','current_requirement',1)", [rule]);
      await query("INSERT INTO requirement_notification_intervals VALUES($1,30,true,$2),($1,60,true,$2)", [rule, template]);
      await query("INSERT INTO communication_messages(id,channel,subject,body,status) VALUES($1,'email','Notice','Body','Sent'),($2,'email','[TEST] Notice','Body','Sent'),($3,'email','Earlier notice','Body','Sent')", [notice, testNotice, earlierNotice]);
      await query("INSERT INTO communication_contractors(message_id,contractor_id) VALUES($1,9001),($2,9002),($3,9001)", [notice, testNotice, earlierNotice]);
      await query(`INSERT INTO requirement_notice_communications
        (message_id,rule_id,contractor_id,contact_id,expiration_date,interval_days,intended_contact_name,intended_email,is_test,template_id,template_revision)
        VALUES($1,$3,9001,$4,CURRENT_DATE+30,30,'Original Contact','original@example.invalid',false,$6,1),
              ($2,$3,9002,$5,CURRENT_DATE+30,30,'Different Contact','other@example.invalid',true,$6,1),
              ($7,$3,9001,$4,CURRENT_DATE+30,60,'Original Contact','original@example.invalid',false,$6,1)`,
        [notice, testNotice, rule, firstContact, secondContact, template, earlierNotice]);
      const historyBefore = (await one("SELECT to_jsonb(n) data FROM requirement_notice_communications n WHERE message_id=$1", [notice])).data;
      const mergePreview = await preview();
      assert.equal(mergePreview.blockers.length, 0);
      assert.equal(mergePreview.counts.requirement_notice_communications.primary, 2);
      assert.equal(mergePreview.counts.requirement_notice_communications.secondary, 1);
      const successor = (await merge(await options())).successor_id;
      const noticePreview = async (contractor, contactId) =>
        (await one("SELECT preview_requirement_notice($1,$2,$3,$4,NULL) result", [uuid(1), rule, contractor, contactId])).result;
      assert.equal((await noticePreview(successor, firstContact)).duplicate, true);
      const different = await noticePreview(successor, secondContact);
      assert.equal(different.duplicate, false, "A test send must not suppress the different contact");
      assert.equal(different.other_recipient_sent, true);
      assert.deepEqual((await one("SELECT to_jsonb(n) data FROM requirement_notice_communications n WHERE message_id=$1", [notice])).data, historyBefore);
      assert.equal((await one("SELECT count(*)::int n FROM company_merge_lineage WHERE merge_id=$1 AND category='requirement_notice_communications' AND after_row->>'preserved_on_predecessor'='true'", [uuid(100)])).n, 3);

      await query("UPDATE compliance_records SET expiration_date=CURRENT_DATE+60 WHERE id=7003");
      assert.equal((await noticePreview(successor, firstContact)).duplicate, false, "A new expiration cycle is independent");
      await query("UPDATE compliance_records SET expiration_date=CURRENT_DATE+30 WHERE id=7003");
      const next = await preview(successor, 9003);
      const final = await merge({
        primary: successor, secondary: 9003, snapshot: next.snapshot, operation: uuid(101),
        choices: Object.fromEntries(next.fields.map((field) => [field, "primary"])),
        compliance: Object.fromEntries(next.compliance.map((c) => [c.compliance_type_id, c.records[0].id])),
        primaryContact: null, confirmed: true, actor: uuid(1),
      });
      assert.equal((await noticePreview(final.successor_id, firstContact)).duplicate, true, "Contact transfer must be proven at every merge");
      await query("INSERT INTO company_merge_authorizations VALUES(pg_backend_pid(),txid_current(),$1)", [uuid(100)]);
      await query("DELETE FROM company_merge_lineage WHERE merge_id=$1 AND category='contractor_contacts' AND source_id=$2", [uuid(100), firstContact]);
      await query("DELETE FROM company_merge_authorizations WHERE backend_pid=pg_backend_pid() AND transaction_id=txid_current()");
      await assert.rejects(noticePreview(final.successor_id, firstContact), /lineage is incomplete/);
    });
  } finally { await db.close(); }
});
