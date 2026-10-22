import assert from "node:assert/strict";

export async function testCompliance3Correction({ db, actor, read, stage, buildMycoiPreview }) {
  const runId = "d621b20f-109b-432e-b5c4-6739b80d02b1";
  const administrator = "00000000-0000-0000-0000-000000000003";
  const migration = read("supabase/20261108_compliance3_ownership_correction.sql");
  const tables = ["contractors", "projects", "contractor_projects", "mycoi_import_runs", "mycoi_vendor_mappings",
    "mycoi_division_mappings", "mycoi_contractor_divisions", "mycoi_policies", "mycoi_policy_divisions",
    "import_history", "project_source_snapshots", "administration_audit_log", "activity_log"];
  const state = async (receipts = true) => Object.fromEntries(await Promise.all(
    [...tables, ...(receipts ? ["mycoi_ownership_correction_receipts"] : [])].map(async (table) => [table,
      (await db.query(`SELECT coalesce(jsonb_agg(r ORDER BY r::text),'[]') value
        FROM (SELECT to_jsonb(t) r FROM ${table} t) rows`)).rows[0].value]),
  ));
  const propose = async () => (await db.query("SELECT mycoi_compliance3_ownership_proposal() value")).rows[0].value;
  const correct = async (token, user = administrator) => (await db.query(
    "SELECT mycoi_correct_compliance3_ownership($1,$2) value", [user, token],
  )).rows[0].value;
  const own = async (contractor, project, source) => db.query(
    "SELECT set_project_assignment_source($1,$2,$3,true)", [contractor, project, source],
  );
  const getRun = async () => (await db.query("SELECT * FROM mycoi_import_runs WHERE id=$1", [runId])).rows[0];
  await db.exec("BEGIN");
  try {
    // Every write in this test is confined to the in-memory PGlite fixture and rolled back at the end.
    await db.exec("DELETE FROM project_source_snapshots");
    await db.query("INSERT INTO user_profiles VALUES($1,'Administrator','Active','Synthetic Administrator','admin@example.invalid',true)", [administrator]);
    await db.exec(`INSERT INTO contractors(id,company_name) VALUES
      (259,'Historical Synthetic B&B'),(260,'Historical Source Overlaps'),(261,'Historical Rejected Vendor');
      SELECT setval(pg_get_serial_sequence('contractors','id'),(SELECT max(id) FROM contractors));
      INSERT INTO import_history(id,file_name) VALUES(10,'Compliance(3).xlsx')
        ON CONFLICT(id) DO UPDATE SET file_name=EXCLUDED.file_name;`);
    for (let index = 0; index < 29; index++) {
      await db.query("INSERT INTO projects(id,project_number,project_name) VALUES($1,$2,'Historical synthetic project')",
        [300 + index, `HIST-${index}`]);
      await own(259, 300 + index, "MANUAL");
    }
    const combinations = [[], ["MANUAL"], ["PROCORE"], ["MANUAL", "PROCORE"], ["MYCOI"],
      ["MANUAL", "MYCOI"], ["PROCORE", "MYCOI"], ["MANUAL", "PROCORE", "MYCOI"], ["MANUAL"]];
    for (const [index, sources] of combinations.entries()) {
      for (const source of sources) await own(260, 300 + index, source);
    }
    await db.query("SELECT set_project_assignment_source(260,308,'MANUAL',false)");
    const row = (number, project, vendor, policy = true) => ({
      row: number, "Vendor Name": vendor, "Division Name": `HIST-${project} - retained division`,
      "Vendor Email": "", "Vendor Phone": "", "Compliance Status": "Compliant Finalized",
      "Policy Expiration Dates": policy
        ? "policyNumber: HIST-ONLY; expirationDate: 12/27/2026; isExpired: false; policyLines: General Liability" : "",
    });
    const rows = Array.from({ length: 20 }, (_, index) => row(index + 2, index, "Historical Synthetic B&B", ![2, 16, 17].includes(index)));
    rows.push(...Array.from({ length: 9 }, (_, index) => row(index + 30, index, "Historical Source Overlaps")));
    rows.push(row(50, 0, "Historical Alias"), row(60, 1, "Historical Approved Add"),
      row(100, 0, "Historical Unmatched"), row(101, 0, "Historical Ignored"),
      { ...row(102, 0, "Historical Staged Add"), "Vendor Phone": "invalid" },
      { ...row(103, 0, "Historical Rejected Vendor"), "Vendor Phone": "invalid" },
      { ...row(104, 0, "Historical Rejected Vendor"), "Division Name": "Unresolved project" });
    let run = await stage(rows);
    run.decisions.vendors = { "historical synthetic b&b": 259, "historical source overlaps": 260,
      "historical alias": 259, "historical rejected vendor": 261 };
    run.decisions.divisions = Object.fromEntries(Array.from({ length: 29 }, (_, index) => [`hist-${index} - retained division`, 300 + index]));
    run.decisions.ignored = [101];
    run.decisions.addContractors = ["historical approved add", "historical staged add"];
    await db.query("UPDATE mycoi_import_runs SET id=$2,file_name='Compliance(3).xlsx',import_history_id=10,decisions=$3 WHERE id=$1",
      [run.id, runId, JSON.stringify(run.decisions)]);
    run = await getRun();
    let reference = (await db.query("SELECT mycoi_import_reference() value")).rows[0].value;
    const ready = buildMycoiPreview(run.source_rows, run.decisions, reference).ready;
    const audits = [
      { user_id: actor, user_name: "Synthetic", user_email: "synthetic@example.invalid", action: "MYCOI_MAPPINGS_ACCEPTED",
        details: { mappings: ready.map((v) => ({ kind: "vendor", raw: v.raw, contractor_id: v.createContractor ? null : v.contractorId })) } },
      { user_id: actor, user_name: "Synthetic", user_email: "synthetic@example.invalid", action: "MYCOI_IMPORT_APPLIED",
        details: { source_rows: ready.flatMap((v) => v.rows) } },
    ];
    // Reproduce the actual earlier transaction, which omitted ordinary Import ownership.
    await db.query("SELECT mycoi_apply_import_transaction($1,$2,$3,$4::jsonb,$5::jsonb,$6,null)", [
      runId, run.revision, reference.token, JSON.stringify(ready), JSON.stringify(audits), actor,
    ]);
    run = await getRun();
    reference = (await db.query("SELECT mycoi_import_reference() value")).rows[0].value;
    const preview = buildMycoiPreview(run.source_rows, { ...run.decisions, ignored: [] }, reference);
    const stats = {
      totalRows: run.source_row_count, totalVendors: preview.vendors.length, matchedExistingVendors: 4,
      contractorsAdded: 1, unmatchedVendors: 2, stagedContractorsNotCreated: 1, matchedProjects: 20,
      unresolvedProjects: 1, policiesImported: run.metrics.policies,
    };
    await db.query("SELECT mycoi_finalize_import($1,$2,$3,$4::jsonb,$5::jsonb,$6)", [
      runId, run.revision, reference.token, JSON.stringify(stats),
      JSON.stringify({ preview, contractors: reference.contractors, projects: reference.projects }), actor,
    ]);
    const beforeMigration = await state(false);
    // A nested savepoint models transactional migration rollback without ending the test transaction.
    await db.exec("SAVEPOINT migration_test");
    await assert.rejects(db.exec(migration.replace(/^.*?BEGIN;/s, "").replace(/COMMIT;\s*$/, "SELECT 1/0;")), /division by zero/);
    await db.exec("ROLLBACK TO SAVEPOINT migration_test");
    assert.equal((await db.query("SELECT to_regclass('mycoi_ownership_correction_receipts') name")).rows[0].name, null);
    await db.exec(migration.replace(/^.*?BEGIN;/s, "").replace(/COMMIT;\s*$/, ""));
    await db.exec(read("supabase/20261109_compliance3_proposal_token_timezone.sql")
      .replace(/^.*?BEGIN;/s, "").replace(/COMMIT;\s*$/, ""));
    assert.deepEqual(await state(false), beforeMigration, "Installing definitions does not execute a correction");
    const plan = await propose();
    const sessionTimezone = (await db.query("SHOW TimeZone")).rows[0].TimeZone;
    for (const timezone of ["UTC", "America/New_York", "Etc/GMT+5", "Asia/Kolkata"]) {
      await db.query("SELECT set_config('TimeZone',$1,true)", [timezone]);
      assert.deepEqual(await propose(), plan, "Proposal and token must not depend on caller timezone");
      assert.equal((await db.query("SHOW TimeZone")).rows[0].TimeZone, timezone,
        "Function-local UTC must preserve the caller timezone");
    }
    await db.query("SELECT set_config('TimeZone',$1,true)", [sessionTimezone]);
    assert.deepEqual(plan.counts, {
      source_rows: 36, imported_source_rows: 31, eligible_source_rows: 31, excluded_source_rows: 5,
      eligible_pairs: 30, eligible_contractors: 3, eligible_projects: 20,
      existing_assignments_to_gain: 23, missing_assignments_to_create: 3, already_correct: 4,
      policy_linked_pairs: 27, division_only_pairs: 3,
    });
    const bb = plan.pairs.filter((p) => p.contractor_id === 259);
    assert.equal(bb.length, 20);
    assert.ok(bb.every((p) => JSON.stringify(p.prior_ownership_sources) === '["MANUAL"]'
      && JSON.stringify(p.resulting_ownership_sources) === '["MANUAL","MYCOI"]'));
    assert.equal(plan.pairs.find((p) => p.contractor_id === 259 && p.project_id === 300).evidence.length, 2, "Aliases deduplicate pairs, not evidence");
    assert.deepEqual(new Set(plan.excluded_rows.map((r) => r.exclusion_reason)), new Set([
      "unmatched_vendor_not_imported", "ignored_source_row", "unexecuted_add_not_imported", "unresolved_records_not_imported", "unresolved_project_not_imported",
    ]));
    const expectNoWrite = async (operation, pattern) => {
      const before = await state();
      await db.exec("SAVEPOINT failed_attempt");
      await assert.rejects(operation, pattern);
      await db.exec("ROLLBACK TO SAVEPOINT failed_attempt");
      assert.deepEqual(await state(), before, "Any failed correction must roll back the whole transaction");
    };
    await expectNoWrite(() => correct(plan.proposal_token, actor), /administrator/);
    await expectNoWrite(() => correct("0".repeat(32)), /changed/);
    await expectNoWrite(() => correct(null), /reviewed proposal token/);
    await db.exec("SAVEPOINT inactive_administrator");
    await db.query("UPDATE user_profiles SET status='Inactive' WHERE auth_user_id=$1", [administrator]);
    await expectNoWrite(() => correct(plan.proposal_token), /administrator/);
    await db.exec("ROLLBACK TO SAVEPOINT inactive_administrator");
    const roleAdministrator = "00000000-0000-0000-0000-000000000004";
    await db.query("INSERT INTO user_profiles VALUES($1,'Administrator','Active','Role Administrator','role-admin@example.invalid',false)", [roleAdministrator]);
    await expectNoWrite(() => correct(plan.proposal_token, roleAdministrator), /administrator/);
    await db.exec(`INSERT INTO role_permissions(role,module,can_view,can_add,can_edit)
      SELECT 'Administrator',module,true,true,true FROM (VALUES ('imports'),('insurance'),('projects')) modules(module)`);
    await db.exec("SAVEPOINT permitted_role_administrator");
    assert.equal((await correct(plan.proposal_token, roleAdministrator)).ownership_additions, 26);
    await db.exec("ROLLBACK TO SAVEPOINT permitted_role_administrator");
    // Exercise every independent proof gate, not just the imported-row flag.
    const proofCases = [
      ["UPDATE mycoi_vendor_mappings SET import_history_id=null WHERE contractor_id=259", "vendor_mapping_provenance_changed_or_missing"],
      ["UPDATE mycoi_division_mappings SET project_id=328 WHERE division_name_key='hist-0 - retained division'", "project_mapping_provenance_changed_or_missing"],
      ["UPDATE mycoi_contractor_divisions SET import_history_id=null WHERE division_mapping_id IN (SELECT id FROM mycoi_division_mappings WHERE division_name_key='hist-0 - retained division')", "imported_division_provenance_changed_or_missing"],
      [`UPDATE administration_audit_log SET details=jsonb_set(details,'{source_rows}','[]') WHERE action='MYCOI_IMPORT_APPLIED' AND object_id='${runId}'`, "successful_import_audit_missing"],
      [`UPDATE administration_audit_log SET details=jsonb_set(details,'{mappings}',details->'mappings'||'[{"kind":"vendor","raw":"Historical Synthetic B&B","contractor_id":261}]') WHERE action='MYCOI_MAPPINGS_ACCEPTED' AND object_id='${runId}'`, "accepted_mapping_audit_conflict"],
    ];
    for (const [sql, reason] of proofCases) {
      await db.exec("SAVEPOINT proof_change");
      await db.exec(sql);
      const changed = await propose();
      assert.ok(changed.excluded_rows.some((e) => e.exclusion_reason === reason), reason);
      await expectNoWrite(() => correct(plan.proposal_token), /changed/);
      await db.exec("ROLLBACK TO SAVEPOINT proof_change");
    }
    await db.exec("SAVEPOINT ownership_change");
    await own(259, 300, "PROCORE");
    await expectNoWrite(() => correct(plan.proposal_token), /changed/);
    await db.exec("ROLLBACK TO SAVEPOINT ownership_change");
    await db.exec("SAVEPOINT complete_authority");
    await db.query("INSERT INTO project_source_snapshots VALUES('MYCOI',$1,10,clock_timestamp(),$2,'[]')", [runId, actor]);
    await expectNoWrite(() => correct(plan.proposal_token), /subsequent COMPLETE/);
    await db.exec("ROLLBACK TO SAVEPOINT complete_authority");

    for (const [table, constraint, check] of [
      ["contractor_projects", "fail_ownership_write", "NOT ('MYCOI'=ANY(ownership_sources))"],
      ["administration_audit_log", "fail_standard_audit", "action <> 'PROJECT_SOURCE_ADDED'"],
      ["administration_audit_log", "fail_correction_audit", "action <> 'MYCOI_PROJECT_OWNERSHIP_CORRECTED'"],
      ["activity_log", "fail_activity_write", "activity_type <> 'Project Source ADDED'"],
      ["mycoi_ownership_correction_receipts", "fail_receipt_write", "false"],
    ]) {
      await db.exec(`ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK(${check}) NOT VALID`);
      await expectNoWrite(() => correct(plan.proposal_token), new RegExp(constraint));
      await db.exec(`ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`);
    }
    const before = await state();
    const result = await correct(plan.proposal_token);
    assert.equal(result.ownership_additions, 26);
    assert.equal(result.ownership_removals, 0);
    assert.equal(result.replayed, false);
    const after = await state();
    for (const table of tables.filter((t) => !["contractor_projects", "administration_audit_log", "activity_log"].includes(t))) {
      assert.deepEqual(after[table], before[table], `No unrelated ${table} data may change`);
    }
    const changedKeys = new Set(plan.pairs.filter((p) => p.action !== "NO_CHANGE").map((p) => `${p.contractor_id}:${p.project_id}`));
    for (const assignment of before.contractor_projects) {
      const updated = after.contractor_projects.find((p) => p.id === assignment.id);
      if (!assignment.active || !changedKeys.has(`${assignment.contractor_id}:${assignment.project_id}`)) {
        assert.deepEqual(updated, assignment, "Unrelated/already-correct/inactive assignments remain byte-for-byte unchanged");
      } else {
        assert.ok(updated.active);
        assert.ok(assignment.ownership_sources.every((s) => updated.ownership_sources.includes(s)), "Every original source is preserved");
        assert.ok(updated.mycoi_owned);
      }
    }
    assert.equal(after.contractor_projects.length - before.contractor_projects.length, 3);
    const correctionAudits = after.administration_audit_log.filter((a) => a.action === "MYCOI_PROJECT_OWNERSHIP_CORRECTED");
    assert.equal(correctionAudits.length, 26);
    assert.equal(after.activity_log.length - before.activity_log.length, 26);
    for (const event of correctionAudits) {
      assert.equal(event.user_id, administrator);
      assert.equal(event.details.import_run_id, runId);
      assert.equal(event.details.import_history_id, 10);
      assert.equal(event.details.source, "MYCOI");
      assert.ok(event.details.prior_ownership_sources.every((s) => event.details.resulting_ownership_sources.includes(s)));
      assert.ok(event.details.timestamp && event.details.actor_id === administrator);
      assert.match(event.details.reason, /omitted by the earlier Import behavior/);
      assert.ok(event.details.evidence.every((e) => e.import_audit_ids.length > 0 && e.source_row));
      assert.ok(after.administration_audit_log.some((a) => a.action === "PROJECT_SOURCE_ADDED"
        && a.object_id === event.object_id && a.user_id === administrator && a.details.import_history_id === 10));
    }
    const second = await correct(plan.proposal_token);
    assert.equal(second.replayed, true);
    assert.deepEqual(await state(), after, "Identical retry adds no ownership, assignments, receipts, activity or audit events");
    await expectNoWrite(() => correct("f".repeat(32)), /already applied/);
    await db.exec("SAVEPOINT denied_role; SET ROLE authenticated");
    await assert.rejects(propose, /permission denied/);
    await db.exec("ROLLBACK TO SAVEPOINT denied_role");
    await db.exec("SAVEPOINT denied_role; SET ROLE authenticated");
    await assert.rejects(() => correct(plan.proposal_token), /permission denied/);
    await db.exec("ROLLBACK TO SAVEPOINT denied_role");
    await db.exec("SAVEPOINT denied_role; SET ROLE service_role");
    await assert.rejects(() => db.exec("DELETE FROM mycoi_ownership_correction_receipts"), /permission denied/);
    await db.exec("ROLLBACK TO SAVEPOINT denied_role");
    console.log("PASS: scoped retained Compliance(3) proposal; exact successful rows/audits/frozen identities/mapping proof; policy-linked + division-only; 29/20/9 synthetic B&B; all source combinations; alias deduplication; approved Add vs unexecuted Add; ignored/unmatched/unresolved excluded; other-import/stale-proof rejection; reviewed-token and administrator guards; write/standard-audit/correction-audit/activity/receipt failure rollback; no removals or unrelated writes; idempotent receipt replay with no duplicate audits/assignments; finalized import unchanged; service-only ACL");
  } finally {
    await db.exec("ROLLBACK");
  }
}
