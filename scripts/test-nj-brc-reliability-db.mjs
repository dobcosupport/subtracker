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
      let pwcFunctionSnapshot;
      if (file === "20261201_nj_brc_verification_queue.sql" || file === "20261202_nj_brc_attended_batches.sql") {
        pwcFunctionSnapshot = await rows(`SELECT p.oid::regprocedure::text AS signature,
          pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname ILIKE '%pwc%'
          ORDER BY p.oid::regprocedure::text`);
      }
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
      if (pwcFunctionSnapshot) {
        const pwcFunctionsAfter = await rows(`SELECT p.oid::regprocedure::text AS signature,
          pg_get_functiondef(p.oid) AS definition
          FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname ILIKE '%pwc%'
          ORDER BY p.oid::regprocedure::text`);
        assert.deepEqual(pwcFunctionsAfter, pwcFunctionSnapshot,
          "the NJ BRC queue migration must not change any existing PWC function");
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
      assert.equal((await one(`SELECT bucket FROM nj_brc_verification_queue WHERE contractor_id=$1`, [contractor])).bucket,
        "needs_review", "a rejected completed review is not Ready");
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
    await t.test("full active population classification and prepared-only session lifecycle", async () => {
      const makeContractor = async (label, options = {}) => one(`INSERT INTO contractors(
        company_name, brc_name_control, federal_tax_id, nj_brc_number, material_vendor_only
      ) VALUES($1,$2,$3,$4,$5) RETURNING id`, [
        label, options.nameControl ?? "SYNT", options.fein ?? "12-3456789",
        options.masterBrc ?? null, options.materialOnly ?? false,
      ]);
      const recordBrc = async (contractorId, number, verified = true) => {
        const typeId = (await one("SELECT id FROM compliance_types WHERE compliance_name='NJ BRC'")).id;
        return one(`INSERT INTO compliance_records(
          contractor_id,compliance_type_id,registration_number,verified_date,verified_by,verification_source
        ) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`, [
          contractorId, typeId, number, verified ? "2026-01-01" : null,
          verified ? "Synthetic Reviewer" : null, verified ? "NJ BRC Website" : null,
        ]);
      };
      const addRequest = async (contractorId, status, resultType = status) => {
        const row = await one("SELECT company_name,brc_name_control,federal_tax_id FROM contractors WHERE id=$1", [contractorId]);
        return one(`INSERT INTO nj_brc_search_requests(
          contractor_id,company_name,brc_name_control,federal_tax_id,taxpayer_id_submission,status,result_type
        ) VALUES($1,$2,$3,$4,'123456789000',$5,$6) RETURNING id`, [
          contractorId, row.company_name, row.brc_name_control, row.federal_tax_id, status, resultType,
        ]);
      };

      const ready = await makeContractor("Synthetic Material-Only Ready", { materialOnly: true });
      const readyTwo = await makeContractor("Synthetic Second Ready");
      const readyThree = await makeContractor("Synthetic Third Ready");
      const readyFour = await makeContractor("Synthetic Fourth Ready");
      const readyFive = await makeContractor("Synthetic Fifth Ready");
      const punctuation = await makeContractor("Synthetic O'Connor Ready");
      const verified = await makeContractor("Synthetic Verified with Failed History");
      await recordBrc(verified.id, "CERT-VERIFIED");
      await addRequest(verified.id, "failed");
      const existing = await makeContractor("Synthetic Existing Without Provenance", { masterBrc: "MASTER-ONLY" });
      const missing = await makeContractor("   ", { fein: null, nameControl: "BAD" });
      const noResult = await makeContractor("Synthetic No Result");
      await addRequest(noResult.id, "no_match");
      const failed = await makeContractor("Synthetic Failed");
      await addRequest(failed.id, "failed");
      const invalidInput = await makeContractor("Synthetic Historical Invalid Input");
      await addRequest(invalidInput.id, "invalid_input");
      const olderActive = await makeContractor("Synthetic Older Active Request");
      await addRequest(olderActive.id, "pending", null);
      await addRequest(olderActive.id, "no_match");
      const independentPending = await makeContractor("Synthetic Independent Pending Review");
      const independentRejected = await makeContractor("Synthetic Independent Rejected Review");
      const mismatch = await makeContractor("Synthetic Master Conflict", { masterBrc: "MASTER-NUMBER" });
      const duplicateCurrent = await makeContractor("Synthetic Duplicate Current With Blank Latest");
      await rows("ALTER TABLE compliance_sync_review_queue DISABLE TRIGGER compliance_sync_review_queue_nj_brc_guard");
      try {
        await rows(`INSERT INTO compliance_sync_review_queue(contractor_id,compliance_name,status)
          VALUES($1,'NJ BRC','pending'),($2,'NJ BRC','rejected')`,
        [independentPending.id, independentRejected.id]);
      } finally {
        await rows("ALTER TABLE compliance_sync_review_queue ENABLE TRIGGER compliance_sync_review_queue_nj_brc_guard");
      }
      const inactiveTypeContractor = await makeContractor("Synthetic Inactive BRC Type");
      await recordBrc(inactiveTypeContractor.id, "CERT-INACTIVE-TYPE");
      const brcTypeId = (await one("SELECT id FROM compliance_types WHERE compliance_name='NJ BRC'")).id;
      await rows("UPDATE compliance_types SET active=false WHERE id=$1", [brcTypeId]);
      assert.equal((await one(`SELECT bucket FROM nj_brc_verification_queue WHERE contractor_id=$1`,
        [inactiveTypeContractor.id])).bucket, "existing_brc",
      "inactive compliance types are excluded from current verification, leaving only the synchronized master number");
      assert.equal((await one(`SELECT count(*)::int n FROM contractor_compliance_status
        WHERE contractor_id=$1 AND compliance_name='NJ BRC'`, [inactiveTypeContractor.id])).n, 0,
      "the read model follows the dashboard's active compliance-type rule");
      await rows("UPDATE compliance_types SET active=true WHERE id=$1", [brcTypeId]);
      await rows("ALTER TABLE compliance_records DISABLE TRIGGER compliance_records_sync_contractor_registration");
      try {
        await recordBrc(mismatch.id, "COMPLIANCE-NUMBER");
        await recordBrc(duplicateCurrent.id, "CERT-OLDER-NONBLANK");
        await recordBrc(duplicateCurrent.id, "", false);
      }
      finally { await rows("ALTER TABLE compliance_records ENABLE TRIGGER compliance_records_sync_contractor_registration"); }

      const bucketOf = async (id) => (await one(
        "SELECT bucket FROM nj_brc_verification_queue WHERE contractor_id=$1", [id],
      )).bucket;
      assert.equal(await bucketOf(ready.id), "ready", "material-only active contractors remain in the queue");
      assert.equal(await bucketOf(verified.id), "verified", "accepted verification outranks a later terminal failure");
      assert.equal(await bucketOf(existing.id), "existing_brc");
      assert.equal(await bucketOf(missing.id), "missing_information");
      assert.equal(await bucketOf(noResult.id), "no_result");
      assert.equal(await bucketOf(failed.id), "failed");
      assert.equal(await bucketOf(invalidInput.id), "needs_review");
      assert.equal(await bucketOf(olderActive.id), "needs_review",
        "an older active request remains blocking despite a newer terminal request");
      assert.equal(await bucketOf(independentPending.id), "needs_review",
        "an independent legacy BRC review blocks even without a request link");
      assert.equal(await bucketOf(independentRejected.id), "needs_review",
        "a latest rejected legacy BRC review blocks even without a request link");
      const mismatchSummary = await one(`SELECT bucket,brc_number,compliance_state
        FROM nj_brc_verification_queue WHERE contractor_id=$1`, [mismatch.id]);
      assert.equal(mismatchSummary.bucket, "needs_review", JSON.stringify(mismatchSummary));
      const duplicateSummary = await one(`SELECT bucket,brc_number,compliance_state
        FROM nj_brc_verification_queue WHERE contractor_id=$1`, [duplicateCurrent.id]);
      assert.deepEqual(duplicateSummary, {
        bucket: "needs_review",
        brc_number: "CERT-OLDER-NONBLANK",
        compliance_state: "Active",
      }, "duplicate current records remain reviewable without hiding their older accepted number");
      assert.equal((await one(`SELECT count(*)::int n FROM nj_brc_verification_queue
        WHERE contractor_id=$1 AND fein_status='valid' AND bucket='verified'`, [verified.id])).n, 1,
      "the read model exposes only FEIN validity, not the FEIN itself");

      const countSqlPath = process.env.BRC_PHASE_A_COUNTS_SQL;
      if (countSqlPath) {
        const aggregateRows = await rows(fs.readFileSync(countSqlPath, "utf8"));
        assert.deepEqual(Object.keys(aggregateRows[0]).sort(), [
          "active_total", "bucket", "contractor_count", "current_compliant_count", "material_only_total",
        ]);
        assert.equal(aggregateRows.find((row) => row.bucket === "all").contractor_count,
          aggregateRows.filter((row) => row.bucket !== "all").reduce((sum, row) => sum + Number(row.contractor_count), 0),
        "standalone bucket counts partition all active contractors");
        assert.ok(aggregateRows.find((row) => row.bucket === "all").material_only_total > 0);
        assert.equal(aggregateRows.find((row) => row.bucket === "all").current_compliant_count,
          (await one(`SELECT count(DISTINCT cr.contractor_id)::int n FROM compliance_records cr
            JOIN compliance_types ct ON ct.id=cr.compliance_type_id
            WHERE ct.compliance_name='NJ BRC' AND ct.active AND cr.active AND cr.is_current
              AND nullif(trim(cr.registration_number),'') IS NOT NULL`)).n);
      }

      const beforeQueueRead = await one("SELECT count(*)::int n FROM nj_brc_verification_sessions");
      const queuePage = (await one(`SELECT public.get_nj_brc_verification_queue(
        'ready','Synthetic Material-Only Ready',1,25) result`)).result;
      assert.equal(queuePage.total_filtered, 1);
      assert.equal(queuePage.rows.length, 1);
      assert.equal(queuePage.rows[0].contractor_id, ready.id);
      assert.equal(queuePage.counts.all,
        Object.entries(queuePage.counts).filter(([key]) => key !== "all").reduce((sum, [, count]) => sum + count, 0),
      "single-RPC bucket counts reconcile to full active population");
      const punctuationSearch = (await one(`SELECT public.get_nj_brc_verification_queue(
        'ready','O''Connor',1,25) result`)).result;
      assert.equal(punctuationSearch.total_filtered, 1);
      assert.equal(punctuationSearch.rows[0].contractor_id, punctuation.id,
        "literal parameterized search preserves company punctuation");
      await assert.rejects(rows(
        "SELECT public.get_nj_brc_verification_queue('bad','',1,25)", [],
      ), /Unsupported NJ BRC queue bucket/);
      assert.equal((await one("SELECT count(*)::int n FROM nj_brc_verification_sessions")).n,
        beforeQueueRead.n, "queue read RPC has no write side effects");

      assert.equal((await one(`SELECT has_table_privilege('authenticated',
        'public.nj_brc_verification_sessions','select') allowed`)).allowed, false);
      assert.equal((await one(`SELECT has_table_privilege('service_role',
        'public.nj_brc_verification_sessions','select') allowed`)).allowed, true);
      const selectedFive = [readyFour.id, ready.id, readyFive.id, readyTwo.id, readyThree.id];
      const requestsBeforeBatch = (await one("SELECT count(*)::int n FROM nj_brc_search_requests")).n;
      const sessionId = (await one(
        "SELECT create_nj_brc_verification_session($1::integer[]) id", [selectedFive],
      )).id;
      assert.deepEqual(await rows(`SELECT contractor_id,ordinal FROM nj_brc_verification_session_members
        WHERE session_id=$1 ORDER BY ordinal`, [sessionId]),
      selectedFive.map((contractor_id, index) => ({ contractor_id, ordinal: index + 1 })));
      assert.equal((await one("SELECT count(*)::int n FROM nj_brc_search_requests")).n, requestsBeforeBatch,
        "creating a five-company administrative batch creates no NJ search requests");
      const sessionDetail = (await one(
        "SELECT public.get_nj_brc_verification_session($1) result", [sessionId],
      )).result;
      assert.equal(sessionDetail.member_count, 5);
      assert.deepEqual(sessionDetail.members.map((member) => [
        member.contractor_id, member.ordinal, member.state, member.request_id,
      ]), selectedFive.map((id, index) => [id, index + 1, "prepared", null]),
      "session detail RPC returns exactly five frozen members in ordinal order");
      const requestForOtherContractor = await addRequest(verified.id, "failed");
      await assert.rejects(rows(`UPDATE nj_brc_verification_session_members
        SET request_id=$1 WHERE session_id=$2 AND contractor_id=$3`,
      [requestForOtherContractor.id, sessionId, ready.id]), /nj_brc_verification_session_member_request_contractor_fk/);
      await rows(`UPDATE nj_brc_verification_session_members
        SET state='skipped',skipped_at=now() WHERE session_id=$1 AND contractor_id=$2`,
      [sessionId, readyTwo.id]);
      assert.equal((await one(`SELECT count(*)::int n FROM nj_brc_verification_session_members
        WHERE session_id=$1`, [sessionId])).n, 5,
      "terminal member outcomes remain retained in the manifest");
      await assert.rejects(rows(`UPDATE nj_brc_verification_session_members
        SET state='completed' WHERE session_id=$1 AND contractor_id=$2`,
      [sessionId, ready.id]), /nj_brc_verification_session_member_outcome_state/);
      assert.equal((await one("SELECT status FROM nj_brc_verification_sessions WHERE id=$1", [sessionId])).status, "prepared");
      await assert.rejects(rows(
        "SELECT create_nj_brc_verification_session($1::integer[])", [[ready.id, existing.id]],
      ), /still be Ready/);
      assert.equal((await rows("SELECT * FROM set_nj_brc_verification_session_state($1,'pause')", [sessionId]))[0].status, "paused");
      assert.equal((await rows("SELECT * FROM set_nj_brc_verification_session_state($1,'resume')", [sessionId]))[0].status, "running");
      assert.equal((await rows("SELECT * FROM set_nj_brc_verification_session_state($1,'stop')", [sessionId]))[0].status, "stopped");
      assert.equal((await one(`SELECT count(*)::int n FROM nj_brc_verification_session_events
        WHERE session_id=$1`, [sessionId])).n, 4);
    });
    await t.test("attended batches create exactly five sequential canonical requests without replay or approvals", async () => {
      await rows(`UPDATE nj_brc_search_requests SET status='failed',result_type='failed',completed_at=now()
        WHERE status IN ('pending','claimed','processing','human_verification_required')`);
      await rows("DELETE FROM nj_brc_worker_lease");
      await lease();
      const selected = [];
      for (let n = 1; n <= 5; n++) {
        selected.push((await one(`INSERT INTO contractors(company_name,brc_name_control,federal_tax_id)
          VALUES($1,'ATTE','00-1234567') RETURNING id`, [`Attended Sequential ${n}`])).id);
      }
      const sessionId = (await one("SELECT create_nj_brc_verification_session($1::int[]) id", [selected])).id;
      const count = async () => (await one("SELECT count(*)::int n FROM nj_brc_search_requests")).n;
      const before = await count();
      const control = async (action, requestId = null, worker = owner) => (await one(
        "SELECT control_nj_brc_batch($1,$2,$3,$4) result", [worker, sessionId, action, requestId],
      )).result;
      assert.equal((await control("next")).session.status, "prepared");
      assert.equal(await count(), before);
      await rows("SELECT * FROM set_nj_brc_verification_session_state($1,'start')", [sessionId]);
      const seen = new Set();
      for (let index = 0; index < selected.length; index++) {
        // Worker service RPCs must not depend on a browser JWT or forged claims.
        await rows("SELECT set_config('request.jwt.claim.sub','',false)");
        await rows("SET ROLE service_role");
        const next = await control("next");
        await rows("RESET ROLE");
        await rows("SELECT set_config('request.jwt.claim.sub',$1,false)", [actor]);
        assert.equal(next.member.ordinal, index + 1);
        assert.equal(next.request.contractor_id, selected[index]);
        assert.equal(next.request.taxpayer_id_submission, "001234567000");
        assert.equal(next.request.status, "claimed");
        assert.equal("federal_tax_id" in next.request, false);
        assert.equal(seen.has(next.request.id), false);
        seen.add(next.request.id);
        assert.equal(await count(), before + index + 1, "just-in-time, never mass creation");
        const read = (await one("SELECT get_owned_nj_brc_batch($1,$2) result", [owner,sessionId])).result;
        assert.equal(read.request, null, "GET only exposes safe control, not executable inputs");
        assert.equal(read.member.request_status, "claimed");
        assert.equal((await claim()).length, 0, "legacy global claims cannot recover batch work");
        await assert.rejects(control("complete", next.request.id), /not safely persisted/);
        const kind = index === 4 ? "successful_certificate" : index % 2 ? "failed" : "no_match";
        await report(next.request.id, kind, kind === "successful_certificate"
          ? { ...evidence, taxpayer_name: "Attended Sequential 5" } : {});
        const done = await control("complete", next.request.id);
        assert.equal(done.member.state, "completed");
        assert.equal(done.session.completed_count, index + 1);
        assert.deepEqual(await control("complete", next.request.id), done, "completion retries are idempotent");
      }
      const finished = await control("next");
      assert.equal(finished.session.status, "completed");
      assert.equal(finished.request, null);
      assert.equal(await count(), before + 5);
      const final = await one(`SELECT r.status,q.status review_status FROM nj_brc_search_requests r
        JOIN compliance_sync_review_queue q ON q.id=r.review_queue_id WHERE r.id=$1`, [[...seen].at(-1)]);
      assert.deepEqual(final, { status: "review_required", review_status: "pending" });
      assert.equal((await one(`SELECT count(*)::int n FROM compliance_records cr
        JOIN compliance_types ct ON ct.id=cr.compliance_type_id
        WHERE cr.contractor_id=ANY($1::int[]) AND ct.compliance_name='NJ BRC'`, [selected])).n, 0);
      assert.equal((await one(`SELECT count(*)::int n FROM administration_audit_log
        WHERE action='NJ_BRC_BATCH_REQUEST' AND user_id=$1 AND details->>'session_id'=$2`,
      [actor,sessionId])).n, 5, "requests retain the session creator as the real administrative actor");
      assert.equal((await one(`SELECT count(*)::int n FROM nj_brc_verification_session_events
        WHERE session_id=$1 AND actor_kind='worker' AND actor_id IS NULL AND worker_instance_id=$2`,
      [sessionId,owner])).n, 1, "worker completion does not invent an administrative verifier");
    });

    const makeAttended = async (label, size = 2) => {
      const ids = [];
      for (let n = 0; n < size; n++) {
        ids.push((await one(`INSERT INTO contractors(company_name,brc_name_control,federal_tax_id)
          VALUES($1,'ATTE','00-1234567') RETURNING id`, [`Attended ${label} ${n}`])).id);
      }
      const id = (await one("SELECT create_nj_brc_verification_session($1::int[]) id", [ids])).id;
      await rows("SELECT * FROM set_nj_brc_verification_session_state($1,'start')", [id]);
      return {
        id, ids,
        control: async (action, requestId = null, worker = owner) => (await one(
          "SELECT control_nj_brc_batch($1,$2,$3,$4) result", [worker,id,action,requestId],
        )).result,
        admin: (action) => rows("SELECT * FROM set_nj_brc_verification_session_state($1,$2)", [id,action]),
      };
    };
    await t.test("pause mid-request blocks source transitions and next but permits durable report/complete and explicit resume", async () => {
      const b = await makeAttended("Pause");
      const next = await b.control("next");
      await rows("SELECT set_nj_brc_search_request_state($1,$2,'processing')", [next.request.id,owner]);
      await b.admin("pause");
      assert.equal((await b.control("next")).request, null);
      assert.equal((await b.control("next")).session.status, "paused");
      await assert.rejects(rows("SELECT set_nj_brc_search_request_state($1,$2,'processing')", [next.request.id,owner]), /not running/);
      await report(next.request.id, "no_match");
      const done = await b.control("complete",next.request.id);
      assert.equal(done.member.state, "completed");
      assert.equal(done.session.status, "paused");
      await b.admin("resume");
      const second = await b.control("next");
      assert.equal(second.member.ordinal, 2);
      assert.notEqual(second.request.id,next.request.id);
      await report(second.request.id,"failed");
      assert.equal((await b.control("complete",second.request.id)).session.status,"completed");
      await assert.rejects(b.admin("resume"),/transition/);
    });
    await t.test("stopped sessions save in-flight terminal outcomes but cannot resume, claim, or reopen via worker pause", async () => {
      const b = await makeAttended("Stop");
      const next = await b.control("next");
      await b.admin("stop");
      assert.equal((await b.control("pause")).session.status,"stopped");
      assert.equal((await b.control("next")).request,null);
      await report(next.request.id,"failed");
      const complete = await b.control("complete",next.request.id);
      assert.equal(complete.session.status,"stopped");
      assert.equal(complete.member.state,"completed");
      await assert.rejects(b.admin("resume"),/transition/);
      await assert.rejects(b.admin("start"),/transition/);
      assert.equal((await one("SELECT count(*)::int n FROM nj_brc_verification_session_members WHERE session_id=$1 AND request_id IS NOT NULL",[b.id])).n,1);
    });
    await t.test("lease takeover closes interrupted source work and reconciles once then pauses, never replaying", async () => {
      const b = await makeAttended("Takeover");
      const next = await b.control("next");
      await rows("UPDATE nj_brc_worker_lease SET expires_at=now()-interval '1 second'");
      for (const action of ["next","pause","complete"]) {
        await assert.rejects(b.control(action,action==="complete" ? next.request.id : null),/lease/);
      }
      await assert.rejects(rows("SELECT get_owned_nj_brc_batch($1,$2)",[owner,b.id]),/lease/);
      await lease(other);
      await assert.rejects(b.control("next"),/lease/);
      const reconciled = await b.control("next",null,other);
      assert.equal(reconciled.request,null);
      assert.equal(reconciled.member.state,"completed");
      assert.equal(reconciled.member.request_status,"failed");
      assert.equal(reconciled.session.status,"paused");
      await b.admin("resume");
      assert.equal((await b.control("complete",next.request.id,other)).session.status,"running",
        "duplicate completion must not re-pause an acknowledged interruption");
      const second = await b.control("next",null,other);
      assert.equal(second.member.ordinal,2);
      await report(second.request.id,"no_match",{},other);
      assert.equal((await b.control("complete",second.request.id,other)).session.status,"completed");
      await lease(other,"release");
      await lease();
    });
    await t.test("release and same-instance relaunch reconcile running or paused interrupted members without replacement", async () => {
      for (const paused of [false,true]) {
        const b = await makeAttended(`Release ${paused ? "Paused" : "Running"}`);
        const next = await b.control("next");
        if (paused) await b.admin("pause");
        await lease(owner,"release");
        const interrupted = await one("SELECT status,result_type,error_code FROM nj_brc_search_requests WHERE id=$1",[next.request.id]);
        assert.deepEqual(interrupted,{status:"failed",result_type:"failed",error_code:"worker_shutdown"});
        await lease();
        if (paused) {
          assert.equal((await b.control("next")).session.status,"paused");
          await b.admin("resume");
        }
        const reconciled = await b.control("next");
        assert.equal(reconciled.session.status,"paused","interruption requires explicit acknowledgement before advancing");
        assert.equal(reconciled.member.state,"completed");
        assert.equal(reconciled.member.request_id,next.request.id);
        assert.equal(reconciled.request,null);
        assert.equal((await one("SELECT count(*)::int n FROM nj_brc_search_requests WHERE contractor_id=$1",[b.ids[0]])).n,1);
        await b.admin("resume");
        const second = await b.control("next");
        assert.equal(second.member.ordinal,2);
        await report(second.request.id,"no_match");
        assert.equal((await b.control("complete",second.request.id)).session.status,"completed");
      }
    });
    await t.test("report and administrative pause preserve result in either serialized order; lease errors do not claim persisted pause", async () => {
      for (const reportFirst of [true,false]) {
        const b = await makeAttended(`PauseReport ${reportFirst}`,1);
        const next = await b.control("next");
        await assert.rejects(b.control("next",null,other),/lease/);
        assert.equal((await one("SELECT status FROM nj_brc_verification_sessions WHERE id=$1",[b.id])).status,"running",
          "lease rejection rolls back without pretending a session pause persisted");
        const operations = [
          () => report(next.request.id,"no_match"),
          () => b.admin("pause"),
        ];
        if (!reportFirst) operations.reverse();
        await Promise.all(operations.map((operation)=>operation()));
        const completed = await b.control("complete",next.request.id);
        assert.equal(completed.session.status,"paused");
        assert.equal(completed.member.state,"completed");
        assert.equal(completed.member.request_status,"no_match");
      }
    });
    await t.test("current input drift, inactive company, active request, and new accepted compliance are skipped without requests", async () => {
      const b = await makeAttended("Drift",5);
      await rows("UPDATE contractors SET federal_tax_id=NULL WHERE id=$1",[b.ids[0]]);
      await rows("UPDATE contractors SET active=false WHERE id=$1",[b.ids[1]]);
      const existing = (await one("SELECT * FROM create_nj_brc_search_request($1,'001234567000')",[b.ids[2]])).id;
      await rows(`INSERT INTO compliance_records(contractor_id,compliance_type_id,registration_number,
        active,is_current,verified_date,verified_by,verification_source)
        SELECT $1,id,'ATTENDED-ACCEPTED',true,true,now(),'Synthetic Reviewer','Manual'
        FROM compliance_types WHERE compliance_name='NJ BRC'`,[b.ids[3]]);
      for (let index=0;index<4;index++) {
        const skipped = await b.control("next");
        assert.equal(skipped.member.ordinal,index+1);
        assert.equal(skipped.member.state,"skipped");
        assert.ok(skipped.member.reason);
        assert.equal(skipped.request,null);
      }
      assert.equal((await one(`SELECT count(*)::int n FROM nj_brc_verification_session_members
        WHERE session_id=$1 AND request_id IS NOT NULL`,[b.id])).n,0);
      const last = await b.control("next");
      assert.equal(last.member.ordinal,5);
      await report(last.request.id,"no_match");
      const done = await b.control("complete",last.request.id);
      assert.equal(done.session.status,"completed");
      assert.equal(done.session.skipped_count,4);
      assert.equal((await one("SELECT status FROM nj_brc_search_requests WHERE id=$1",[existing])).status,"pending");
    });
    await t.test("configuration disabled pauses; repeated/concurrent next never creates two requests; completion cannot cross sessions", async () => {
      const b = await makeAttended("Concurrency");
      await rows("UPDATE compliance_sync_settings SET enabled=false WHERE compliance_name='NJ BRC'");
      assert.equal((await b.control("next")).session.status,"paused");
      await rows("UPDATE compliance_sync_settings SET enabled=true WHERE compliance_name='NJ BRC'");
      await b.admin("resume");
      const next = await b.control("next");
      const otherBatch = await makeAttended("Other");
      await assert.rejects(otherBatch.control("complete",next.request.id),/not a member/);
      assert.equal((await otherBatch.control("next")).session.status,"paused","only one source request may be in flight");
      const concurrent = await Promise.all([b.control("next"),b.control("next")]);
      assert.equal(concurrent.filter((r)=>r.request).length,0,"a previously delivered request is never returned again");
      assert.equal(concurrent[0].session.status,"paused","ambiguous repeated delivery fails closed even for the same instance");
      assert.equal((await one("SELECT status FROM nj_brc_search_requests WHERE id=$1",[next.request.id])).status,"failed");
      assert.equal((await b.control("complete",next.request.id)).member.state,"completed");
      await b.admin("resume");
      const second = await b.control("next");
      await report(second.request.id,"failed");
      await b.control("complete",second.request.id);
      assert.equal((await one(`SELECT has_function_privilege('authenticated',
        'public.control_nj_brc_batch(uuid,uuid,text,uuid)','execute') allowed`)).allowed,false);
      assert.equal((await one(`SELECT has_function_privilege('authenticated',
        'public.get_owned_nj_brc_batch(uuid,uuid)','execute') allowed`)).allowed,false);
      assert.equal((await one(`SELECT has_function_privilege('service_role',
        'public.control_nj_brc_batch(uuid,uuid,text,uuid)','execute') allowed`)).allowed,true);
    });
    await t.test("restart reconciles persisted review results; malformed or orphan results are never marked complete or replayed", async () => {
      const b = await makeAttended("Reconcile");
      const next = await b.control("next");
      await report(next.request.id,"successful_certificate",{
        ...evidence,taxpayer_name:"Attended Reconcile 0",
      });
      // Simulate process exit after result storage, before the complete callback.
      const reconciled = await b.control("next");
      assert.equal(reconciled.request,null);
      assert.equal(reconciled.member.state,"completed");
      assert.equal(reconciled.member.request_status,"review_required");
      const second = await b.control("next");
      await report(second.request.id,"no_match");
      await b.control("complete",second.request.id);

      const orphan = await makeAttended("Orphan",1);
      const orphanNext = await orphan.control("next");
      await rows("UPDATE nj_brc_search_requests SET worker_instance_id=NULL WHERE id=$1",[orphanNext.request.id]);
      const unknown = await orphan.control("next");
      assert.equal(unknown.session.status,"paused");
      assert.equal(unknown.request,null);
      assert.equal(unknown.member.state,"prepared","unknown ownership cannot pretend a failed result persisted");
      await assert.rejects(orphan.control("complete",orphanNext.request.id),/not safely persisted/);
      await orphan.admin("resume");
      assert.equal((await orphan.control("next")).session.status,"paused","explicit resume cannot replay unknown submissions");
      await orphan.admin("stop");
      await rows(`UPDATE nj_brc_search_requests SET status='failed',result_type='failed',completed_at=now()
        WHERE id=$1`,[orphanNext.request.id]);

      const corrupt = await makeAttended("ReviewGate",1);
      const corruptNext = await corrupt.control("next");
      await report(corruptNext.request.id,"successful_certificate",{
        ...evidence,taxpayer_name:"Attended ReviewGate 0",
      });
      await rows("UPDATE nj_brc_search_requests SET review_queue_id=NULL WHERE id=$1",[corruptNext.request.id]);
      await assert.rejects(corrupt.control("complete",corruptNext.request.id),/not safely persisted/);
      const uncertain = await corrupt.control("next");
      assert.equal(uncertain.session.status,"paused");
      assert.equal(uncertain.member.state,"prepared");
      assert.equal(uncertain.request,null);
      assert.equal((await one(`SELECT count(*)::int n FROM nj_brc_search_requests WHERE contractor_id=$1`,
        [corrupt.ids[0]])).n,1);
    });
    await t.test("session list aggregates all 5000 members without embedded-row truncation and caps only session rows", async () => {
      await db.exec("BEGIN");
      try {
        const ids = await rows(`INSERT INTO contractors(company_name,brc_name_control,federal_tax_id)
          SELECT 'Synthetic Aggregate '||n,'AGGR','00-1234567' FROM generate_series(1,5000) n RETURNING id`);
        const sessionId = (await one("SELECT create_nj_brc_verification_session($1::int[]) id",[ids.map((r)=>r.id)])).id;
        await rows(`UPDATE nj_brc_verification_session_members SET
          state=CASE WHEN ordinal<=3500 THEN 'completed' ELSE 'skipped' END,
          completed_at=CASE WHEN ordinal<=3500 THEN now() END,
          skipped_at=CASE WHEN ordinal>3500 THEN now() END
          WHERE session_id=$1 AND ordinal<=4700`,[sessionId]);
        const actualTotal = (await one("SELECT count(*)::int n FROM nj_brc_verification_sessions")).n;
        let result = (await one("SELECT list_nj_brc_verification_sessions() result")).result;
        const summary = result.sessions.find((s)=>s.id===sessionId);
        assert.equal(result.total,actualTotal);
        assert.equal(summary.member_count,5000);
        assert.equal(summary.completed_count,3500);
        assert.equal(summary.skipped_count,1200);
        assert.equal(summary.current_ordinal,4701);
        assert.equal("members" in summary,false);
        assert.deepEqual(Object.keys(summary).sort(),[
          "id","status","created_at","updated_at","member_count","last_error",
          "completed_count","skipped_count","current_ordinal",
        ].sort());
        await rows(`INSERT INTO nj_brc_verification_sessions(member_count,created_by,updated_by,created_at)
          SELECT 1,$1,$1,clock_timestamp()+make_interval(secs=>n) FROM generate_series(1,110) n`,[actor]);
        result = (await one("SELECT list_nj_brc_verification_sessions() result")).result;
        assert.equal(result.sessions.length,100);
        assert.equal(result.total,actualTotal+110,"total counts all sessions, not only the recent page");
        assert.ok(result.sessions.every((s)=>s.completed_count===0 && s.skipped_count===0 && s.current_ordinal===null));
        assert.equal((await one(`SELECT has_function_privilege('authenticated',
          'public.list_nj_brc_verification_sessions()','execute') allowed`)).allowed,false);
      } finally {
        await db.exec("ROLLBACK");
      }
    });
    console.log(`Applied ${files.length} dated migrations plus base schema in isolated PGlite; no remote connection.`);
  } finally { await db.close(); }
});
