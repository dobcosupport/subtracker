import assert from "node:assert/strict";

export async function testImportOwnership({ db, actor, read, stage, apply, buildMycoiPreview }) {
  const migration = read("supabase/20261107_mycoi_import_project_ownership.sql");
  const state = async () => Object.fromEntries(await Promise.all([
    "contractors", "contractor_projects", "mycoi_import_runs", "mycoi_policies",
    "mycoi_vendor_mappings", "mycoi_division_mappings", "mycoi_contractor_divisions",
    "mycoi_policy_divisions", "import_history", "project_source_snapshots", "administration_audit_log", "activity_log",
  ].map(async (table) => [table, (await db.query(
    `SELECT coalesce(jsonb_agg(r ORDER BY r::text),'[]') value FROM (SELECT to_jsonb(t) r FROM ${table} t) rows`,
  )).rows[0].value])));
  const beforeMigration = await state();
  await assert.rejects(db.exec(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), /division by zero/);
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT to_regprocedure('mycoi_apply_import_transaction(uuid,integer,text,jsonb,jsonb,uuid,jsonb)') name")).rows[0].name, null);
  await db.exec(migration);
  assert.deepEqual(await state(), beforeMigration, "Migration changes no historical data, finalized review, or ownership");

  const getRun = async (id) => (await db.query("SELECT * FROM mycoi_import_runs WHERE id=$1", [id])).rows[0];
  const membership = async (contractor, project) => (await db.query(
    "SELECT * FROM contractor_projects WHERE contractor_id=$1 AND project_id=$2 AND active", [contractor, project],
  )).rows[0];
  const own = async (contractor, project, source) => db.query(
    "SELECT set_project_assignment_source($1,$2,$3,true)", [contractor, project, source],
  );
  const numbers = ["17-003", "20-005", "21-002", "21-004", "22-002", "22-004", "23-004", "23-006", "23-007",
    "23-008", "24-001", "24-002", "24-003", "25-001", "25-002", "25-003", "25-006", "25-007", "25-008", "25-010",
    "19-005", "20-004", "23-001", "23-003", "25-005", "25-011", "26-001", "26-002", "26-004"];
  await db.query("INSERT INTO contractors(id,company_name) VALUES(59,'SYNTHETIC B&B Iron Works')");
  for (const [index, number] of numbers.entries()) {
    await db.query("INSERT INTO projects(id,project_number,project_name) VALUES($1,$2,'Synthetic B&B validation')",
      [100 + index, `SYN-${number}`]);
    await own(59, 100 + index, "MANUAL");
  }
  const sourceRow = (index, vendor = "SYNTHETIC B&B Iron Works", policies = true) => ({
    row: index + 2, "Vendor Name": vendor, "Division Name": `SYN-${numbers[index]} - synthetic`,
    "Vendor Email": "", "Vendor Phone": "", "Compliance Status": "Compliant Finalized",
    "Policy Expiration Dates": policies
      ? "policyNumber: SYN-BB; expirationDate: 12/27/2026; isExpired: false; policyLines: General Liability" : "",
  });
  const stageBb = async (rows, extra = {}) => {
    const run = await stage(rows);
    run.decisions.vendors["synthetic b&b iron works"] = 59;
    for (const [index, number] of numbers.entries()) run.decisions.divisions[`syn-${number} - synthetic`] = 100 + index;
    Object.assign(run.decisions, extra);
    await db.query("UPDATE mycoi_import_runs SET file_name='SYNTHETIC Compliance(3) validation.xlsx',decisions=$2 WHERE id=$1",
      [run.id, JSON.stringify(run.decisions)]);
    return run;
  };
  const rows = numbers.slice(0, 20).map((_, index) => sourceRow(index, undefined, ![2, 16, 17].includes(index)));
  rows.push({ ...sourceRow(20, "Unresolved B&B-like vendor"), row: 99 });
  const bb = await stageBb(rows);
  const beforeStage = await membership(59, 100);
  assert.deepEqual(beforeStage.ownership_sources, ["MANUAL"], "Approving a match is not an ownership write");
  await apply(bb);
  const imported = await getRun(bb.id);
  assert.equal(imported.status, "Partial");
  assert.equal(imported.imported_rows.length, 20);
  for (let index = 0; index < 29; index++) {
    assert.deepEqual((await membership(59, 100 + index)).ownership_sources,
      index < 20 ? ["MANUAL", "MYCOI"] : ["MANUAL"],
      `Synthetic B&B ${numbers[index]}: only successfully imported pairs gain MYCOI`);
  }
  assert.equal((await db.query("SELECT count(*)::integer n FROM project_source_snapshots WHERE import_run_id=$1", [bb.id])).rows[0].n, 0);
  const events = (await db.query(
    "SELECT * FROM administration_audit_log WHERE action='PROJECT_SOURCE_ADDED' AND details->>'source'='MYCOI' AND details->>'contractor_id'='59'",
  )).rows;
  assert.equal(events.length, 20);
  assert.ok(events.every((e) => e.user_id === actor && e.details.import_history_id === imported.import_history_id));
  const reimport = await stageBb(rows.slice(0, 20));
  await apply(reimport);
  assert.equal((await db.query(
    "SELECT count(*)::integer n FROM administration_audit_log WHERE action='PROJECT_SOURCE_ADDED' AND details->>'source'='MYCOI' AND details->>'contractor_id'='59'",
  )).rows[0].n, 20, "Idempotent imports do not duplicate source-added audits");
  const alias = await stageBb([sourceRow(0, "Synthetic B&B alias"), { ...sourceRow(0), row: 90 }]);
  alias.decisions.vendors["synthetic b&b alias"] = 59;
  await db.query("UPDATE mycoi_import_runs SET decisions=$2 WHERE id=$1", [alias.id, JSON.stringify(alias.decisions)]);
  await apply(alias);
  assert.equal((await db.query(
    "SELECT count(*)::integer n FROM contractor_projects WHERE contractor_id=59 AND project_id=100 AND active",
  )).rows[0].n, 1, "Multiple vendor aliases retain one effective pair");

  const closeoutReference = (await db.query("SELECT mycoi_import_reference() value")).rows[0].value;
  const closeoutPreview = buildMycoiPreview(imported.source_rows, imported.decisions, closeoutReference);
  const stats = {
    totalRows: imported.source_row_count, totalVendors: closeoutPreview.vendors.length,
    matchedExistingVendors: closeoutPreview.vendors.filter((v) => v.contractorId).length, contractorsAdded: 0,
    unmatchedVendors: closeoutPreview.vendors.filter((v) => !v.contractorId).length, stagedContractorsNotCreated: 0,
    matchedProjects: closeoutPreview.summary.matchedDivisions, unresolvedProjects: closeoutPreview.summary.divisionsRequiringReview,
    policiesImported: imported.metrics.policies,
  };
  const beforeFinalize = await state();
  await db.query("SELECT mycoi_finalize_import($1,$2,$3,$4::jsonb,$5::jsonb,$6)", [
    bb.id, imported.revision, closeoutReference.token, JSON.stringify(stats),
    JSON.stringify({ preview: closeoutPreview, contractors: closeoutReference.contractors, projects: closeoutReference.projects }), actor,
  ]);
  const afterFinalize = await state();
  for (const table of Object.keys(beforeFinalize).filter((table) => !["mycoi_import_runs", "administration_audit_log"].includes(table))) {
    assert.deepEqual(afterFinalize[table], beforeFinalize[table], `Finalize after additive Import leaves ${table} unchanged`);
  }
  const finalizedBb = await getRun(bb.id);
  assert.equal(finalizedBb.status, "Partial", "Finalize permits unmatched vendors and is not another ownership commit");
  assert.ok(finalizedBb.finalized_at);
  const beforeDenied = await state();
  await assert.rejects(apply(finalizedBb), /read-only/);
  await assert.rejects(apply(finalizedBb, true), /read-only/);
  assert.deepEqual(await state(), beforeDenied, "Finalized import cannot be replayed or accepted as COMPLETE");

  // All existing source combinations and inactive history use the same source helper.
  await db.query("INSERT INTO contractors(id,company_name) VALUES(60,'Synthetic Source Overlap')");
  await own(60, 101, "PROCORE");
  await own(60, 102, "MANUAL");
  await own(60, 102, "PROCORE");
  await own(60, 103, "MYCOI");
  await own(60, 104, "MANUAL");
  await db.query("SELECT set_project_assignment_source(60,104,'MANUAL',false)");
  const inactive = (await db.query("SELECT * FROM contractor_projects WHERE contractor_id=60 AND project_id=104")).rows[0];
  const overlapRows = [0, 1, 2, 4].map((index) => sourceRow(index, "Synthetic Source Overlap"));
  overlapRows.push({ ...sourceRow(5, "Ignored Source"), row: 80 });
  const overlap = await stageBb(overlapRows, { ignored: [80] });
  overlap.decisions.vendors["synthetic source overlap"] = 60;
  await db.query("UPDATE mycoi_import_runs SET decisions=$2 WHERE id=$1", [overlap.id, JSON.stringify(overlap.decisions)]);
  await apply(overlap);
  assert.deepEqual((await membership(60, 100)).ownership_sources, ["MYCOI"], "Missing assignment becomes MYCOI-only");
  assert.deepEqual((await membership(60, 101)).ownership_sources, ["PROCORE", "MYCOI"]);
  assert.deepEqual((await membership(60, 102)).ownership_sources, ["MANUAL", "PROCORE", "MYCOI"]);
  assert.deepEqual((await membership(60, 103)).ownership_sources, ["MYCOI"], "Absent MYCOI pair survives partial import");
  assert.equal(await membership(60, 105), undefined, "Ignored pair is not added");
  assert.deepEqual((await db.query("SELECT * FROM contractor_projects WHERE id=$1", [inactive.id])).rows[0], inactive);
  assert.equal((await membership(60, 104)).mycoi_owned, true, "New effective row preserves inactive history");

  const addName = "Synthetic Import-time Add";
  const added = await stageBb([sourceRow(21, addName)], { addContractors: [addName.toLowerCase()] });
  const beforeFailure = await state();
  await db.exec("ALTER TABLE administration_audit_log ADD CONSTRAINT fail_import_source CHECK(action <> 'PROJECT_SOURCE_ADDED') NOT VALID");
  await assert.rejects(apply(added), /fail_import_source/);
  assert.deepEqual(await state(), beforeFailure, "Source audit failure rolls back contractor creation, records, metrics, history and ownership");
  await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT fail_import_source");
  await apply(added);
  const created = (await db.query("SELECT * FROM contractors WHERE company_name=$1", [addName])).rows[0];
  assert.equal(created.creation_source, "MYCOI");
  assert.deepEqual((await membership(created.id, 121)).ownership_sources, ["MYCOI"], "Approved Add gains real-ID ownership during Import");
  const denied = await stageBb([sourceRow(22)]);
  const beforeDeniedImport = await state();
  await assert.rejects(apply(denied, false, { actor: "00000000-0000-0000-0000-000000000002" }), /permissions/);
  await assert.rejects(apply({ ...denied, revision: denied.revision - 1 }), /changed/);
  assert.deepEqual(await state(), beforeDeniedImport, "Permission and revision failures cannot write ownership or records");

  const beforeComplete = await state();
  const complete = await stageBb([sourceRow(0), sourceRow(2, undefined, false)]);
  await apply(complete, true);
  assert.equal((await membership(59, 100)).mycoi_owned, true);
  assert.deepEqual((await membership(59, 101)).ownership_sources, ["MANUAL"], "Only COMPLETE removes absent MYCOI");
  assert.deepEqual((await membership(59, 102)).ownership_sources, ["MANUAL"], "COMPLETE retains its existing policy-linked pair rule");
  assert.deepEqual((await membership(60, 101)).ownership_sources, ["PROCORE"]);
  assert.deepEqual((await membership(60, 102)).ownership_sources, ["MANUAL", "PROCORE"]);
  assert.equal(await membership(60, 100), undefined, "COMPLETE can deactivate MYCOI-only membership");
  assert.ok(beforeComplete.project_source_snapshots.length <
    (await db.query("SELECT * FROM project_source_snapshots")).rows.length);

  const finalized = (await db.query("SELECT * FROM mycoi_import_runs WHERE finalized_at IS NOT NULL AND artifacts_purged_at IS NULL LIMIT 1")).rows[0];
  assert.ok(finalized);
  const beforeFinalizedAttempt = await state();
  await assert.rejects(apply(finalized), /read-only/);
  assert.deepEqual(await state(), beforeFinalizedAttempt, "Historical finalized imports remain read-only without retroactive repair");
  const reference = (await db.query("SELECT mycoi_import_reference() value")).rows[0].value;
  assert.ok(buildMycoiPreview(bb.source_rows, bb.decisions, reference, imported.imported_rows).ready.every((v) => v.raw !== "SYNTHETIC B&B Iron Works"));
  await db.exec("SET ROLE service_role");
  await assert.rejects(db.query("SELECT mycoi_apply_import_transaction(null,1,'','[]','[]',null,null)"), /permission denied/);
  await assert.rejects(db.query("SELECT mycoi_apply_import_data(null,1,'','[]','[]',null)"), /permission denied/);
  await db.exec("RESET ROLE");
  console.log("PASS: prospective migration leaves historical/finalized data unchanged; synthetic B&B 29 assignments/20 imports/3 division-only; Import adds source ownership atomically; absent/unresolved/ignored pairs untouched; all source overlaps; inactive history; alias/idempotence; actor/import audit; approved Add real IDs; audit-failure rollback; Finalize with unmatched vendors changes no business data; COMPLETE-only absence removal and policy rule; finalized/permission/revision/direct-write guards");
}
