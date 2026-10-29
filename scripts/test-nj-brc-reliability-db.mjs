import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
const directory = path.resolve("supabase");
const sql = (name) => fs.readFileSync(path.join(directory, name), "utf8");
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
const actor = "00000000-0000-4000-8000-000000000003";

test("NJ BRC final migration chain, authoritative lease and transactional regressions", async (t) => {
  const db = await PGlite.create();
  const rows = async (text, args = []) => (await db.query(text, args)).rows;
  const one = async (text, args) => (await rows(text, args))[0];
  const lease = (id = owner, action = "acquire") => rows("SELECT manage_nj_brc_worker_lease($1,$2)", [id, action]);
  const claim = (id = owner) => rows("SELECT * FROM claim_nj_brc_search_request($1)", [id]);
  const evidence = {
    taxpayer_name: "Synthetic BRC Builders LLC", certificate_number: "CERT-ONLY-001", effective_date: "2020-01-01",
    source_url: "https://www1.state.nj.us/TYTR_BRC/servlet/common/BRCLogin",
    verified_at: "2026-10-29T12:00:00Z", match_rationale: "Exact normalized taxpayer identity.", discrepancy_warnings: [],
  };
  const report = (id, kind, value = {}, worker = owner) => rows("SELECT * FROM report_nj_brc_search_result($1,$2,$3,$4::jsonb,$3)",
    [id, worker, kind, JSON.stringify(value)]);
  const approve = (id) => one("SELECT approve_nj_brc_search_request($1,'Synthetic approval') id", [id]);
  let contractor;
  const enqueue = async () => {
    const r = await one("SELECT * FROM create_nj_brc_search_request($1,'001234567000')", [contractor]);
    return r.id;
  };
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,raw_user_meta_data jsonb DEFAULT '{}',
        last_sign_in_at timestamptz,confirmation_sent_at timestamptz,invited_at timestamptz);
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
        $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_user::text$$;
    `);
    // Repository setup requires permission functions before base-table policies.
    for (const file of ["20260929_user_management.sql"]) {
      await db.exec(sql(file).split("INSERT INTO public.role_permissions")[0] + "\nCOMMIT;");
    }
    await db.exec(sql("subtracker_schema.sql"));
    const files = fs.readdirSync(directory).filter((file) => /^\d{8}_.+\.sql$/.test(file)).sort();
    // These same-day migrations have explicit dependencies rather than alphabetical order.
    const moveAfter = (file, prerequisite) => {
      files.splice(files.indexOf(file), 1);
      files.splice(files.indexOf(prerequisite) + 1, 0, file);
    };
    moveAfter("20261002_compliance_records_synced_status.sql", "20261002_synced_compliance_records.sql");
    moveAfter("20261002_admin_compliance_sync_access.sql", "20261002_compliance_sync_admin.sql");
    moveAfter("20261014_nj_pwc_registry_sync_functions.sql", "20261014_nj_pwc_registry_sync_schema.sql");
    for (const file of files) {
      if (file === "20261130_nj_brc_reliability.sql") {
        // The deployed catalog lacks a column that historical source adds.
        // Reproduce that observed drift instead of inventing it in the fixture.
        await db.exec("ALTER TABLE compliance_sync_exceptions DROP COLUMN result_status");
        assert.match((await one(`SELECT pg_get_functiondef('report_nj_brc_search_result(uuid,uuid,text,jsonb,text)'::regprocedure) definition`)).definition,
          /result_status/);
        await db.exec("BEGIN");
        try {
          const probe = await one(`INSERT INTO contractors(company_name,brc_name_control,federal_tax_id)
            VALUES('Synthetic Defect Probe','SYNT','00-1234567') RETURNING id`);
          const request = await one(`INSERT INTO nj_brc_search_requests(contractor_id,company_name,brc_name_control,
            federal_tax_id,taxpayer_id_submission,status,worker_instance_id,claim_worker_key)
            VALUES($1,'Synthetic Defect Probe','SYNT','00-1234567','001234567000','processing',$2,'nj-brc') RETURNING id`,
          [probe.id,owner]);
          await assert.rejects(report(request.id,"website_error"),/result_status.*does not exist/);
        } finally { await db.exec("ROLLBACK"); }
      }
      if (file === "20261121_company_merge.sql") {
        await db.exec("ALTER TABLE role_permissions RENAME CONSTRAINT role_permissions_manage_check TO role_permissions_check1");
      }
      if (file === "20261103_contractor_contact_consolidation.sql") {
        // This historical data migration intentionally requires a fixed inventory.
        // Supply equivalent synthetic rows, never copied production contacts.
        await db.exec(`INSERT INTO contractors(company_name,contact_name,email)
          SELECT 'Migration Fixture '||n,CASE WHEN n<=163 THEN 'Synthetic Contact '||n END,
            'fixture-'||n||'@example.invalid' FROM generate_series(1,318) n;
          INSERT INTO contractor_contacts(contractor_id,contact_name,email)
            SELECT id,'Alternate Fixture Contact','alternate-'||id||'@example.invalid'
            FROM contractors ORDER BY id LIMIT 2;`);
      }
      // Old permission migrations assumed every table had an id sequence;
      // insurance instead uses contractor_id. Guard only that catalog lookup.
      const migration = sql(file).replaceAll(
        "pg_get_serial_sequence('public.' || table_row.table_name, 'id')",
        "(CASE WHEN EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=table_row.table_name AND column_name='id') THEN pg_get_serial_sequence('public.' || table_row.table_name, 'id') END)",
      );
      try { await db.exec(migration); } catch (error) {
        throw new Error(`Migration ${file}: ${error.message}`, { cause: error });
      }
    }
    await rows("INSERT INTO auth.users(id,email) VALUES($1,'brc-reviewer@example.invalid')", [actor]);
    await rows(`INSERT INTO user_profiles(auth_user_id,name,email,role,status,system_administrator)
      VALUES($1,'Synthetic Reviewer','brc-reviewer@example.invalid','Administrator','Active',true)`, [actor]);
    await rows("INSERT INTO auth.users(id,email) VALUES($1,'brc-reader@example.invalid')", [other]);
    await rows(`INSERT INTO user_profiles(auth_user_id,name,email,role,status)
      VALUES($1,'Synthetic Reader','brc-reader@example.invalid','Read Only','Active')`, [other]);
    await rows("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor]);
    contractor = (await one(`INSERT INTO contractors(company_name,brc_name_control,federal_tax_id)
      VALUES('Synthetic BRC Builders LLC','SYNT','00-1234567') RETURNING id`)).id;

    await t.test("deployed schema shape has no invented exception result_status column", async () => {
      assert.equal((await one(`SELECT count(*)::int n FROM information_schema.columns
        WHERE table_name='compliance_sync_exceptions' AND column_name='result_status'`)).n, 0);
      assert.equal((await one(`SELECT count(*)::int n FROM pg_proc WHERE proname IN
        ('company_merge_execute','unlink_contractor_registration','approve_nj_brc_search_request')`)).n, 3);
      assert.equal((await one(`SELECT has_function_privilege('service_role',
        'close_interrupted_nj_brc_requests(uuid,text)','execute') allowed`)).allowed,false);
    });
    await t.test("only one directory/machine can acquire, claim or submit", async () => {
      await assert.rejects(claim(), /lease/);
      await lease();
      await assert.rejects(lease(other), /already held/);
      const id = await enqueue();
      assert.equal((await claim())[0].id, id);
      await assert.rejects(claim(other), /lease/);
      await assert.rejects(report(id, "no_match", {}, other), /lease/);
      await report(id, "no_match", { match_rationale: "No certificate found." });
    });
    await t.test("queue keeps snapshots immutable, deduplicates active requests, and rejects unauthorized actors", async () => {
      const id = await enqueue();
      assert.equal(await enqueue(),id);
      await assert.rejects(rows("UPDATE nj_brc_search_requests SET company_name='Changed' WHERE id=$1",[id]),/immutable/);
      await rows("SELECT set_config('request.jwt.claim.sub',$1,false)",[other]);
      try { await assert.rejects(enqueue(),/manage permission/); }
      finally { await rows("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]); }
      await claim();
      await assert.rejects(rows("SELECT set_nj_brc_search_request_state($1,$2,'pending')",[id,owner]),/Invalid/);
      await report(id,"no_match");
    });
    await t.test("health/test acknowledgement renews ownership atomically, preserves real poll timestamps and sequence guards", async () => {
      const payload = {
        worker_key: "nj-brc",instance_id: owner,started_at: new Date().toISOString(),sequence: 1,
        lifecycle: "ready",browser_connected: true,last_poll_at: null,
        file_modified_at: "2020-01-01T00:00:00Z",loaded_hash: "a".repeat(64),current_hash: "a".repeat(64),
      };
      await rows("UPDATE compliance_sync_workers SET test_id=$1,test_requested_at=now(),test_acknowledged_at=NULL WHERE worker_key='nj-brc'",[other]);
      const result = await one("SELECT report_nj_brc_worker($1) result",[JSON.stringify(payload)]);
      assert.equal(result.result.ok,true); assert.equal(result.result.test_id,other);
      assert.equal((await one("SELECT last_poll_at FROM compliance_sync_workers WHERE worker_key='nj-brc'")).last_poll_at,null);
      const leaseBefore = await one("SELECT * FROM nj_brc_worker_lease");
      await assert.rejects(rows("SELECT report_nj_brc_worker($1)",[JSON.stringify(payload)]),/rejected/);
      assert.deepEqual(await one("SELECT * FROM nj_brc_worker_lease"),leaseBefore,"a rejected report cannot extend its lease");
      await rows("SELECT report_nj_brc_worker($1)",[JSON.stringify({ ...payload,sequence: 2,event: "test",test_id: other,message: "Synthetic acknowledgement" })]);
      assert.ok((await one("SELECT test_acknowledged_at FROM compliance_sync_workers WHERE worker_key='nj-brc'")).test_acknowledged_at);
    });
    for (const kind of ["website_error", "failed", "no_match", "ambiguous_result", "invalid_input", "identity_mismatch"]) {
      await t.test(`${kind} is terminal, evidenced, idempotent and creates an exception`, async () => {
        const id = await enqueue();
        await claim();
        await rows("SELECT set_nj_brc_search_request_state($1,$2,'processing')", [id, owner]);
        const result = await report(id, kind, { match_rationale: `Synthetic ${kind}`, ...(
          kind === "website_error" ? { source_url: evidence.source_url } : {}) });
        assert.equal(result[0].status, kind);
        assert.equal((await report(id, kind))[0].idempotent, true);
        if (kind === "failed") await assert.rejects(report(id,"no_match"),/different classification/);
        const r = await one("SELECT * FROM nj_brc_search_requests WHERE id=$1", [id]);
        assert.ok(r.completed_at);
        assert.equal(r.result_evidence.match_rationale, `Synthetic ${kind}`);
        assert.equal((await one("SELECT count(*)::int n FROM compliance_sync_exceptions WHERE contractor_id=$1", [contractor])).n > 0, true);
        assert.deepEqual(await claim(), []);
      });
    }
    await t.test("protection/temporary website failure diagnostics retain bounded metadata", async () => {
      for (const classification of ["protection", "temporary_failure", "timeout", "navigation_failure", "unrecognized"]) {
        const id = await enqueue(); await claim();
        await report(id, "website_error", { match_rationale: classification });
        await rows("SELECT * FROM attach_nj_brc_page_diagnostics($1,$2,$3)", [id, owner, JSON.stringify({
          classification, stage: "result", page_url: evidence.source_url + "?token=private",
          page_text: "Taxpayer 001234567000", iframe_count: 1, response_status: 503,
          iframes: [{ url: "https://example.invalid/protection?key=private", title: "Access denied", visible: true }],
          protection_detected: classification === "protection",
        })]);
        const d = (await one("SELECT result_evidence FROM nj_brc_search_requests WHERE id=$1", [id])).result_evidence.page_diagnostics;
        assert.equal(d.classification, classification);
        assert.equal(d.response_status, 503);
        assert.equal(d.iframe_count, 1);
        assert.doesNotMatch(JSON.stringify(d), /private|001234567/);
      }
    });
    await t.test("reporting failure retains original evidence and cannot strand a claimed request", async () => {
      const id = await enqueue(); await claim();
      await db.exec(`CREATE FUNCTION fail_brc_exception() RETURNS trigger LANGUAGE plpgsql AS
        $$BEGIN RAISE EXCEPTION 'Injected transient database failure'; END$$;
        CREATE TRIGGER injected_failure BEFORE INSERT ON compliance_sync_exceptions
        FOR EACH ROW EXECUTE FUNCTION fail_brc_exception();`);
      await assert.rejects(report(id, "ambiguous_result", { match_rationale: "Ambiguous" }), /Injected/);
      assert.equal((await one("SELECT status FROM nj_brc_search_requests WHERE id=$1", [id])).status, "claimed");
      await db.exec("DROP TRIGGER injected_failure ON compliance_sync_exceptions");
      await rows("SELECT * FROM store_nj_brc_reporting_failure($1,$2,'ambiguous_result',$3)", [
        id, owner, JSON.stringify({ match_rationale: "Original ambiguous evidence", certificate_number: "FIXTURE" }),
      ]);
      const r = await one("SELECT * FROM nj_brc_search_requests WHERE id=$1", [id]);
      assert.equal(r.status, "failed");
      assert.equal(r.result_evidence.attempted_result_type, "ambiguous_result");
      assert.equal(r.result_evidence.certificate_number, "FIXTURE");
      assert.equal(r.result_evidence.match_rationale, "Original ambiguous evidence");
      assert.ok(r.completed_at);
      assert.equal((await report(id,"ambiguous_result"))[0].idempotent,true,"lost failure response can be retried without replay");
    });
    await t.test("website-error fallback remains terminal and ownership fenced", async () => {
      const id = await enqueue(); await claim();
      await rows("SELECT * FROM store_nj_brc_terminal_error($1,$2,'website_error','Protection',$3)", [id, owner,
        JSON.stringify({ match_rationale: "Protection",source_url: evidence.source_url,office_use_only: "Synthetic evidence" })]);
      assert.equal((await one("SELECT status FROM nj_brc_search_requests WHERE id=$1", [id])).status, "website_error");
      const original = (await one("SELECT result_evidence FROM nj_brc_search_requests WHERE id=$1",[id])).result_evidence;
      assert.equal(original.office_use_only,"Synthetic evidence");
      await rows("SELECT * FROM store_nj_brc_terminal_error($1,$2,'website_error','Different',$3)",[id,owner,
        JSON.stringify({ match_rationale: "Do not replace" })]);
      assert.deepEqual((await one("SELECT result_evidence FROM nj_brc_search_requests WHERE id=$1",[id])).result_evidence,original);
      await assert.rejects(rows("SELECT * FROM store_nj_brc_terminal_error($1,$2,'website_error','Protection')", [id, other]), /lease/);
    });
    await t.test("expired crash closes interrupted human-wait work, audits, and fences stale results", async () => {
      const id = await enqueue(); await claim();
      await rows("SELECT set_nj_brc_search_request_state($1,$2,'human_verification_required')", [id, owner]);
      await db.exec("UPDATE nj_brc_worker_lease SET expires_at=clock_timestamp()-interval '1 second'");
      await assert.rejects(report(id, "website_error"), /lease/);
      await lease(other);
      const r = await one("SELECT * FROM nj_brc_search_requests WHERE id=$1", [id]);
      assert.equal(r.status, "failed");
      assert.equal(r.error_code, "worker_lease_expired");
      assert.ok(r.completed_at);
      assert.equal((await one("SELECT count(*)::int n FROM administration_audit_log WHERE object_id=$1", [id])).n, 1);
      await assert.rejects(report(id, "no_match"), /lease/);
      await lease(other, "release"); await lease();
    });
    await t.test("legitimate result stages, direct writes blocked, and approval is atomic/audited/non-expiring", async () => {
      const previous = await one(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,notes)
        SELECT $1,id,'OLD-SYNTHETIC-CERT','Retain this historical evidence' FROM compliance_types
        WHERE compliance_name='NJ BRC' RETURNING id`,[contractor]);
      const id = await enqueue(); await claim();
      const r = (await report(id, "successful_certificate", evidence))[0];
      assert.equal(r.status, "review_required");
      await rows("SELECT set_config('request.jwt.claim.sub',$1,false)",[other]);
      try { await assert.rejects(approve(id),/manage permission/); }
      finally { await rows("SELECT set_config('request.jwt.claim.sub',$1,false)",[actor]); }
      await db.exec("SET ROLE authenticated");
      try {
        await assert.rejects(rows("UPDATE compliance_sync_review_queue SET status='approved' WHERE id=$1", [r.review_queue_id]), /permission denied|transactional RPC|approval RPC/);
      } finally { await db.exec("RESET ROLE"); }
      await assert.rejects(rows("UPDATE compliance_sync_review_queue SET status='approved' WHERE id=$1", [r.review_queue_id]), /transactional RPC|approval RPC/);
      const before = (await one("SELECT count(*)::int n FROM compliance_records WHERE contractor_id=$1", [contractor])).n;
      await db.exec("ALTER TABLE administration_audit_log ADD CONSTRAINT injected_audit CHECK(action<>'APPROVE') NOT VALID");
      await assert.rejects(approve(id), /injected_audit/);
      assert.equal((await one("SELECT status FROM nj_brc_search_requests WHERE id=$1", [id])).status, "review_required");
      assert.equal((await one("SELECT status FROM compliance_sync_review_queue WHERE id=$1", [r.review_queue_id])).status, "pending");
      assert.equal((await one("SELECT count(*)::int n FROM compliance_records WHERE contractor_id=$1", [contractor])).n, before);
      assert.equal((await one("SELECT active FROM compliance_records WHERE id=$1",[previous.id])).active,true);
      await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT injected_audit");
      await db.exec("SET ROLE authenticated");
      const approved = await approve(id);
      await db.exec("RESET ROLE");
      const record = await one("SELECT * FROM compliance_records WHERE id=$1", [approved.id]);
      assert.equal(record.expiration_date, null);
      assert.equal(record.registration_number, evidence.certificate_number);
      assert.deepEqual(await one("SELECT active,is_current,notes FROM compliance_records WHERE id=$1",[previous.id]),{
        active: false,is_current: false,notes: "Retain this historical evidence",
      });
      assert.equal((await one("SELECT count(*)::int n FROM reminders WHERE compliance_record_id=$1",[approved.id])).n,0);
      const review = await one("SELECT * FROM compliance_sync_review_queue WHERE id=$1", [r.review_queue_id]);
      assert.equal(review.status, "approved");
      assert.equal(review.approval_source, "nj-brc-manual");
      assert.equal(review.reviewed_by, "brc-reviewer@example.invalid");
      assert.equal((await one("SELECT status FROM nj_brc_search_requests WHERE id=$1", [id])).status, "completed");
      const audit = await one("SELECT * FROM administration_audit_log WHERE action='APPROVE' AND object_id=$1", [id]);
      assert.ok(audit.object_label);
      assert.equal(audit.details.compliance_record_id, approved.id);
      await assert.rejects(approve(id), /not awaiting approval/);
      assert.equal((await one("SELECT calculated_status,days_remaining,expiration_date FROM contractor_compliance_status WHERE compliance_record_id=$1", [approved.id])).calculated_status, "Active");
      await rows("UPDATE compliance_records SET expiration_date='2021-01-01' WHERE id=$1", [approved.id]);
      const status = await one("SELECT * FROM contractor_compliance_status WHERE compliance_record_id=$1", [approved.id]);
      assert.equal(status.calculated_status, "Active"); assert.equal(status.expiration_date, null); assert.equal(status.days_remaining, null);
    });
    await t.test("malformed evidence and altered review cannot be approved", async () => {
      const id = await enqueue(); await claim();
      await assert.rejects(report(id, "successful_certificate", {}), /missing required/);
      const r = (await report(id, "successful_certificate", evidence))[0];
      await db.exec("ALTER TABLE compliance_sync_review_queue DISABLE TRIGGER compliance_sync_review_queue_nj_brc_guard");
      await rows("UPDATE compliance_sync_review_queue SET brc_evidence=brc_evidence-'taxpayer_name' WHERE id=$1", [r.review_queue_id]);
      await db.exec("ALTER TABLE compliance_sync_review_queue ENABLE TRIGGER compliance_sync_review_queue_nj_brc_guard");
      await assert.rejects(approve(id), /incomplete/);
      assert.equal((await one("SELECT status FROM nj_brc_search_requests WHERE id=$1", [id])).status, "review_required");
      await rows("SELECT reject_nj_brc_search_request($1,'Synthetic rejected evidence')", [id]);
    });
    await t.test("shutdown closes own in-flight request, preserves evidence, does not requeue", async () => {
      const id = await enqueue(); await claim();
      await lease(owner, "release");
      const r = await one("SELECT * FROM nj_brc_search_requests WHERE id=$1", [id]);
      assert.equal(r.status, "failed"); assert.equal(r.error_code, "worker_shutdown"); assert.ok(r.completed_at);
      await lease(other); assert.deepEqual(await claim(other), []);
    });
    await t.test("PWC expiry is unchanged and BRC has no reminder candidates", async () => {
      const pwcType = (await one("SELECT id FROM compliance_types WHERE compliance_name='NJ PWC'")).id;
      const record = await one(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,expiration_date)
        VALUES($1,$2,'PWC-FIXTURE',CURRENT_DATE-1) RETURNING id`, [contractor,pwcType]);
      assert.equal((await one("SELECT calculated_status FROM contractor_compliance_status WHERE compliance_record_id=$1", [record.id])).calculated_status,"Expired");
      assert.equal((await one(`SELECT count(*)::int n FROM contractor_compliance_status
        WHERE compliance_name='NJ BRC' AND (days_remaining IS NOT NULL OR expiration_date IS NOT NULL)`)).n,0);
    });
    console.log(`Applied ${files.length} dated migrations plus base schema in isolated PGlite; no remote connection.`);
  } finally { await db.close(); }
});
