import assert from "node:assert/strict";

export async function testMycoiLifecycle({ db, actor, read, stage, apply, buildMycoiPreview, importedRun }) {
  const migration = read("supabase/20261106_mycoi_import_finalization.sql");
  await assert.rejects(() => db.exec(migration.replace(/COMMIT;\s*$/, "SELECT 1/0; COMMIT;")), /division by zero/);
  await db.exec("ROLLBACK");
  assert.equal((await db.query("SELECT count(*)::integer n FROM information_schema.columns WHERE table_name='mycoi_import_runs' AND column_name='finalized_at'")).rows[0].n, 0);
  await db.exec(migration);
  const getRun = async (id) => (await db.query("SELECT * FROM mycoi_import_runs WHERE id=$1", [id])).rows[0];
  const packetFor = async (id) => {
    const run = await getRun(id);
    const reference = (await db.query("SELECT mycoi_import_reference() value")).rows[0].value;
    const preview = buildMycoiPreview(run.source_rows, { ...run.decisions, ignored: [] }, reference);
    const stats = {
      totalRows: run.source_row_count, totalVendors: preview.vendors.length,
      matchedExistingVendors: preview.vendors.filter((v) => v.contractorId).length, contractorsAdded: 0,
      unmatchedVendors: preview.vendors.filter((v) => !v.contractorId).length,
      stagedContractorsNotCreated: preview.vendors.filter((v) => v.addContractor && !v.contractorId).length,
      matchedProjects: preview.summary.matchedDivisions, unresolvedProjects: preview.summary.divisionsRequiringReview,
      policiesImported: run.metrics.policies,
    };
    return { revision: run.revision, token: reference.token, stats, review: { preview, contractors: reference.contractors, projects: reference.projects } };
  };
  const finish = async (id, packet, user = actor) => (await db.query(
    "SELECT mycoi_finalize_import($1,$2,$3,$4::jsonb,$5::jsonb,$6) value",
    [id, packet.revision, packet.token, JSON.stringify(packet.stats), JSON.stringify(packet.review), user],
  )).rows[0].value;
  const tables = ["contractors", "projects", "contractor_projects", "project_source_snapshots", "import_history", "activity_log",
    "mycoi_policies", "mycoi_vendor_mappings", "mycoi_division_mappings", "mycoi_contractor_divisions", "mycoi_policy_divisions",
    "contractor_insurance", "contractor_insurance_history", "communication_insurance_items"];
  const businessState = async () => Object.fromEntries(await Promise.all(tables.map(async (table) => [table,
    (await db.query(`SELECT COALESCE(jsonb_agg(record ORDER BY record::text),'[]') value FROM (SELECT to_jsonb(t) record FROM ${table} t) records`)).rows[0].value])));
  const source = { row: 2, "Vendor Name": "Unresolved Company", "Division Name": "Unknown Division", "Vendor Email": "",
    "Vendor Phone": "", "Compliance Status": "Unknown", "Policy Expiration Dates": "" };
  const lifecycle = await stage([source]);
  await db.query("UPDATE mycoi_import_runs SET decisions=jsonb_set(decisions,'{addContractors}','[\"unresolved company\"]'::jsonb) WHERE id=$1", [lifecycle.id]);
  const packet = await packetFor(lifecycle.id);
  const beforeFinish = await businessState();
  await assert.rejects(() => finish(lifecycle.id, packet, "00000000-0000-0000-0000-000000000002"), /permissions/i);
  await assert.rejects(() => finish(lifecycle.id, { ...packet, revision: packet.revision - 1 }), /changed/i);
  await assert.rejects(() => finish(lifecycle.id, { ...packet, token: "stale" }), /changed/i);
  await assert.rejects(() => finish(lifecycle.id, { ...packet, stats: {} }), /statistic/i);
  await assert.rejects(() => finish(lifecycle.id, { ...packet, review: {} }), /required/i);
  await db.exec(`ALTER TABLE administration_audit_log ADD CONSTRAINT fail_finalization CHECK(action <> 'MYCOI_IMPORT_FINALIZED') NOT VALID`);
  await assert.rejects(() => finish(lifecycle.id, packet), /fail_finalization/);
  assert.equal((await getRun(lifecycle.id)).finalized_at, null, "Audit failure rolls finalization back");
  await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT fail_finalization");
  await finish(lifecycle.id, packet);
  const closed = await getRun(lifecycle.id);
  assert.deepEqual(await businessState(), beforeFinish, "Finalize changes NO business records or ownership");
  assert.equal(closed.revision, lifecycle.revision + 1);
  assert.deepEqual(closed.decisions.addContractors, ["unresolved company"]);
  assert.deepEqual(closed.finalized_review, JSON.parse(JSON.stringify(packet.review)));
  assert.deepEqual(closed.closeout, packet.stats);
  await assert.rejects(() => finish(lifecycle.id, packet), /changed/i);
  await assert.rejects(() => db.query("UPDATE mycoi_import_runs SET decisions='{}'::jsonb WHERE id=$1", [lifecycle.id]), /read-only/);
  await assert.rejects(() => db.query("UPDATE mycoi_import_runs SET finalized_at=NULL,finalized_by=NULL,closeout=NULL,finalized_review=NULL WHERE id=$1", [lifecycle.id]), /read-only/);
  const imported = await getRun(importedRun);
  await finish(imported.id, await packetFor(imported.id));
  const frozenImported = await getRun(imported.id);
  const beforeBypass = await businessState();
  await assert.rejects(() => apply(frozenImported, true), /read-only/);
  assert.deepEqual(await businessState(), beforeBypass, "DB guard rolls back COMPLETE writes before deployment/API bypass");
  const audit = (await db.query("SELECT * FROM administration_audit_log WHERE action='MYCOI_IMPORT_FINALIZED' AND object_id=$1", [lifecycle.id])).rows[0];
  assert.equal(audit.user_id, actor); assert.equal(audit.details.portfolio_reconciled, false);
  await assert.rejects(() => db.query("SELECT mycoi_purge_import_artifacts($1)", [lifecycle.id]), /12 months/);
  const open = await stage([source]);
  await assert.rejects(() => db.query("SELECT mycoi_purge_import_artifacts($1)", [open.id]), /finalized imports/);
  // Only isolated fixtures disable immutability to simulate calendar-month retention boundaries.
  const age = async (id, interval) => {
    await db.exec("ALTER TABLE mycoi_import_runs DISABLE TRIGGER mycoi_import_runs_finalized");
    await db.query("UPDATE mycoi_import_runs SET finalized_at=now()-$2::interval WHERE id=$1", [id, interval]);
    await db.exec("ALTER TABLE mycoi_import_runs ENABLE TRIGGER mycoi_import_runs_finalized");
  };
  await age(lifecycle.id, "13 months");
  await db.query("UPDATE mycoi_import_runs SET created_at=now()-interval '2 years' WHERE id=$1", [open.id]);
  const list = async (finalized, offset = 0) => (await db.query("SELECT mycoi_list_import_runs($1,$2) value", [finalized, offset])).rows[0].value;
  assert.ok((await list(false)).some((r) => r.id === open.id), "Old unfinished uploads remain working");
  assert.ok(!(await list(true)).some((r) => r.id === lifecycle.id), "History hidden from finalized_at, not upload date");
  const old = await getRun(lifecycle.id);
  await db.exec(`ALTER TABLE mycoi_import_runs ADD UNIQUE(id,source_row_count);
    CREATE TABLE artifact_dependency(run_id UUID,row_count INTEGER,FOREIGN KEY(run_id,row_count) REFERENCES mycoi_import_runs(id,source_row_count))`);
  await assert.rejects(() => db.query("SELECT mycoi_purge_import_artifacts($1)", [old.id]), /dependent foreign keys/);
  assert.deepEqual((await getRun(old.id)).source_rows, old.source_rows);
  await db.exec("DROP TABLE artifact_dependency; CREATE TABLE retained_run_reference(run_id UUID REFERENCES mycoi_import_runs(id))");
  await db.query("INSERT INTO retained_run_reference VALUES($1)", [old.id]);
  const beforePurge = await businessState();
  const auditsBefore = (await db.query("SELECT * FROM administration_audit_log ORDER BY id")).rows;
  await db.exec(`ALTER TABLE administration_audit_log ADD CONSTRAINT fail_cleanup CHECK(action <> 'MYCOI_IMPORT_ARTIFACTS_PURGED') NOT VALID`);
  await assert.rejects(() => db.query("SELECT mycoi_purge_import_artifacts($1)", [old.id]), /fail_cleanup/);
  assert.deepEqual(await getRun(old.id), old, "Cleanup audit failure rolls payload redaction back");
  await db.exec("ALTER TABLE administration_audit_log DROP CONSTRAINT fail_cleanup");
  await db.query("SELECT mycoi_purge_import_artifacts($1)", [old.id]);
  const purged = await getRun(old.id);
  assert.deepEqual(purged.source_rows, []); assert.deepEqual(purged.imported_rows, []);
  assert.deepEqual(purged.decisions, { vendors: {}, divisions: {}, contacts: {}, ignored: [], addContractors: [] });
  assert.equal(purged.finalized_review, null); assert.ok(purged.artifacts_purged_at);
  for (const key of ["id", "file_name", "created_at", "created_by", "last_imported_at", "finalized_at", "finalized_by", "metrics", "closeout",
    "import_history_id", "revision", "imported_vendor_keys", "imported_policy_ids"]) assert.deepEqual(purged[key], old[key], `Retained: ${key}`);
  assert.deepEqual(await businessState(), beforePurge, "Cleanup retains ALL downstream business records/provenance");
  assert.deepEqual((await db.query("SELECT * FROM administration_audit_log ORDER BY id")).rows.slice(0, auditsBefore.length), auditsBefore);
  assert.equal((await db.query("SELECT count(*)::integer n FROM retained_run_reference WHERE run_id=$1", [old.id])).rows[0].n, 1);
  const auditCount = (await db.query("SELECT count(*)::integer n FROM administration_audit_log")).rows[0].n;
  await db.query("SELECT mycoi_purge_import_artifacts($1)", [old.id]);
  assert.equal((await db.query("SELECT count(*)::integer n FROM administration_audit_log")).rows[0].n, auditCount);
  for (let index = 0; index < 21; index++) {
    const entry = await stage([source]);
    await finish(entry.id, await packetFor(entry.id));
  }
  const first = await list(true), second = await list(true, 20);
  assert.equal(first.length, 20); assert.equal(second.length, 2);
  assert.equal(new Set([...first, ...second].map((r) => r.id)).size, 22);
  assert.ok(first.every((r, i) => !i || new Date(first[i - 1].finalized_at) >= new Date(r.finalized_at)));
  await age(imported.id, "12 months -1 day");
  assert.ok([...await list(true), ...await list(true, 20)].some((r) => r.id === imported.id), "Full 12 calendar months retained");
  await age(imported.id, "13 months");
  const actualBefore = await getRun(imported.id), actualBusiness = await businessState();
  await db.query("SELECT mycoi_purge_import_artifacts($1)", [imported.id]);
  assert.ok(actualBefore.import_history_id); assert.ok(actualBefore.imported_policy_ids.length);
  assert.deepEqual(await businessState(), actualBusiness, "Actual imported contractors/policies/history/ownership survive cleanup");
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`SET ROLE ${role}`);
    for (const sql of ["SELECT mycoi_list_import_runs(false,0)", `SELECT mycoi_purge_import_artifacts('${old.id}')`,
      `SELECT mycoi_finalize_import('${open.id}',1,'x','{}','{}','${actor}')`]) await assert.rejects(() => db.exec(sql), /permission denied/);
    await db.exec("RESET ROLE");
  }
  const servicePacket = await packetFor(open.id);
  await db.exec("SET ROLE service_role");
  assert.ok((await list(false)).length);
  await finish(open.id, servicePacket);
  await db.query("SELECT mycoi_purge_import_artifacts($1)", [old.id]);
  await db.exec("RESET ROLE");
  console.log("PASS: isolated lifecycle/retention — unresolved/staged Adds, atomic close-out audits, immutable finalized imports, no business/ownership changes, 12-calendar-month history/paging, dependency refusal, payload-only idempotent cleanup, retained provenance/audits and service-only ACL; unscheduled.");
}
