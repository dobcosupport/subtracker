import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

process.on("uncaughtException", (error) => {
  console.error(`Proposal failed: ${error.message}`);
  process.exitCode = 1;
});

const require = createRequire(import.meta.url);
const { PGlite } = require("@electric-sql/pglite");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output), "Provide an absolute local output directory");
assert.ok(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY, "Server read credentials are required");
const runId = "d621b20f-109b-432e-b5c4-6739b80d02b1";
const reads = [
  ["mycoi_import_runs", "*", { id: `eq.${runId}` }],
  ["administration_audit_log", "id,audit_date,action,object_type,object_id,details", {
    object_id: `eq.${runId}`, action: "in.(MYCOI_IMPORT_APPLIED,MYCOI_MAPPINGS_ACCEPTED,MYCOI_IMPORT_FINALIZED)",
  }],
  ["mycoi_vendor_mappings", "id,contractor_id,raw_vendor_name,vendor_name_key,active,import_history_id,import_reference,created_at,updated_at"],
  ["mycoi_division_mappings", "id,raw_division_name,division_name_key,project_id,active,created_at,updated_at"],
  ["mycoi_contractor_divisions", "id,vendor_mapping_id,division_mapping_id,active,is_current,import_history_id,import_reference,last_imported_at,created_at,updated_at"],
  ["mycoi_policies", "id,contractor_id,vendor_mapping_id,active,is_current,import_history_id,import_reference"],
  ["mycoi_policy_divisions", "id,policy_id,contractor_division_id,vendor_mapping_id"],
  ["contractor_projects", "id,contractor_id,project_id,active,ownership_sources,assigned_date,removed_date,created_at"],
  ["contractors", "id,company_name,active,creation_source,creation_import_history_id"],
  ["projects", "id,project_number,project_name,status"],
  ["import_history", "id,file_name", { id: "eq.10" }],
  ["project_source_snapshots", "source,import_run_id,import_history_id,accepted_at", {}, "source,import_run_id"],
];
async function read(table, select, filters = {}, order = "id") {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const url = new URL(`/rest/v1/${table}`, process.env.NEXT_PUBLIC_SUPABASE_URL);
    for (const [name, value] of Object.entries({ select, ...filters, order, limit: "500", offset: String(offset) })) url.searchParams.set(name, value);
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    // Deliberately GET-only: this tool has no RPC, apply mode, or database write client.
    const response = await fetch(url, { method: "GET", headers: { apikey: key, Authorization: `Bearer ${key}` } });
    if (!response.ok) throw new Error(`${table} read failed (${response.status}): ${await response.text()}`);
    const batch = await response.json();
    assert.ok(Array.isArray(batch), `${table}: expected rows`);
    rows.push(...batch);
    if (batch.length < 500) return rows;
  }
}
const capturedAt = new Date().toISOString();
const data = Object.fromEntries(await Promise.all(reads.map(async (args) => [args[0], await read(...args)])));
assert.equal(data.mycoi_import_runs.length, 1, "Exact retained run is required");
const db = await PGlite.create();
let proposal;
try {
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE user_profiles(auth_user_id uuid PRIMARY KEY,role text,status text,name text,email text,system_administrator boolean);
    CREATE TABLE role_permissions(role text,module text,can_view boolean,can_add boolean,can_edit boolean);
    CREATE TABLE mycoi_import_runs(id uuid PRIMARY KEY,file_name text,import_history_id integer,revision integer,
      finalized_at timestamptz,artifacts_purged_at timestamptz,finalized_review jsonb,source_rows jsonb,
      imported_rows jsonb,imported_vendor_keys jsonb,decisions jsonb,last_imported_at timestamptz);
    CREATE TABLE import_history(id integer PRIMARY KEY,file_name text);
    CREATE TABLE administration_audit_log(id bigint,audit_date timestamptz,action text,object_type text,object_id text,details jsonb);
    CREATE TABLE mycoi_vendor_mappings(id integer,contractor_id integer,raw_vendor_name text,vendor_name_key text,
      active boolean,import_history_id integer,import_reference text,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE mycoi_division_mappings(id integer,raw_division_name text,division_name_key text,project_id integer,
      active boolean,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE mycoi_contractor_divisions(id integer,vendor_mapping_id integer,division_mapping_id integer,active boolean,is_current boolean,
      import_history_id integer,import_reference text,last_imported_at timestamptz,created_at timestamptz,updated_at timestamptz);
    CREATE TABLE mycoi_policies(id integer,contractor_id integer,vendor_mapping_id integer,active boolean,is_current boolean,import_history_id integer,import_reference text);
    CREATE TABLE mycoi_policy_divisions(id integer,policy_id integer,contractor_division_id integer,vendor_mapping_id integer);
    CREATE TABLE contractors(id integer,company_name text,active boolean,creation_source text,creation_import_history_id integer);
    CREATE TABLE projects(id integer,project_number text,project_name text,status text);
    CREATE TABLE contractor_projects(id integer,contractor_id integer,project_id integer,active boolean,ownership_sources text[],
      assigned_date date,removed_date date,created_at timestamptz,
      mycoi_owned boolean GENERATED ALWAYS AS ('MYCOI'=ANY(ownership_sources)) STORED);
    CREATE TABLE project_source_snapshots(source text,import_run_id text,import_history_id integer,accepted_at timestamptz);
  `);
  for (const [table, rows] of Object.entries(data)) {
    for (let offset = 0; offset < rows.length; offset += 200) {
      const columns = (await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position", [table],
      )).rows.map((r) => r.column_name);
      await db.query(`INSERT INTO ${table}(${columns.join(",")}) SELECT ${columns.join(",")}
        FROM jsonb_populate_recordset(null::${table},$1::jsonb)`, [JSON.stringify(rows.slice(offset, offset + 200))]);
    }
  }
  await db.exec(fs.readFileSync(path.join(root, "supabase", "20261108_compliance3_ownership_correction.sql"), "utf8"));
  proposal = (await db.query("SELECT mycoi_compliance3_ownership_proposal() value")).rows[0].value;
} finally {
  await db.close();
}
// Refuse to publish a proposal if any prerequisite changed during the read-only calculation.
await Promise.all(reads.map(async (args) => assert.deepEqual(await read(...args), data[args[0]], `${args[0]} changed; rerun preview`)));
const changedPairs = new Set(proposal.pairs.filter((p) => p.action !== "NO_CHANGE").map((p) => `${p.contractor_id}:${p.project_id}`));
const eligibleContractors = new Set(proposal.pairs.map((p) => p.contractor_id));
const eligibleProjects = new Set(proposal.pairs.map((p) => p.project_id));
const unchangedAssignments = data.contractor_projects.filter((a) => !changedPairs.has(`${a.contractor_id}:${a.project_id}`) || !a.active);
const excludedGroups = new Map();
for (const row of proposal.excluded_rows) {
  const key = JSON.stringify([row.vendor_key, row.raw_division, row.exclusion_reason]);
  const group = excludedGroups.get(key) ?? { raw_vendor: row.raw_vendor, raw_division: row.raw_division,
    contractor_id: row.contractor_id, project_id: row.project_id, reason: row.exclusion_reason, source_rows: [], frozen_review_reasons: [] };
  group.source_rows.push(row.source_row);
  group.frozen_review_reasons = [...new Set([...group.frozen_review_reasons,
    ...row.frozen_review_issues.map((i) => `${i.category}: ${i.reason}`)])];
  excludedGroups.set(key, group);
}
const extraCounts = {
  excluded_vendor_division_groups: excludedGroups.size,
  excluded_vendor_keys: new Set(proposal.excluded_rows.map((r) => r.vendor_key)).size,
  excluded_by_reason: Object.fromEntries([...new Set(proposal.excluded_rows.map((r) => r.exclusion_reason))].map((reason) =>
    [reason, proposal.excluded_rows.filter((r) => r.exclusion_reason === reason).length])),
  excluded_ignored_rows: proposal.excluded_rows.filter((r) => r.exclusion_reason === "ignored_source_row").length,
  excluded_unexecuted_add_rows: proposal.excluded_rows.filter((r) => r.exclusion_reason === "unexecuted_add_not_imported").length,
  missing_with_preserved_inactive_history: proposal.pairs.filter((p) => p.action === "CREATE_ASSIGNMENT"
    && unchangedAssignments.some((a) => !a.active && a.contractor_id === p.contractor_id && a.project_id === p.project_id)).length,
  unchanged_active_assignments: unchangedAssignments.filter((a) => a.active).length,
  unchanged_inactive_assignments: unchangedAssignments.filter((a) => !a.active).length,
  contractors_without_eligible_pairs: data.contractors.filter((c) => !eligibleContractors.has(c.id)).length,
  projects_without_eligible_pairs: data.projects.filter((p) => !eligibleProjects.has(p.id)).length,
};
const csv = (headers, rows) => [headers, ...rows].map((row) => row.map((v) =>
  `"${String(v ?? "").replaceAll('"', '""')}"`).join(",")).join("\r\n") + "\r\n";
const outputData = { captured_at: capturedAt, verified_at: new Date().toISOString(), shared_data_mutations: 0,
  proposal, additional_counts: extraCounts, excluded_groups: [...excludedGroups.values()],
  unchanged_assignments: unchangedAssignments,
  unchanged_contractors: data.contractors.filter((c) => !eligibleContractors.has(c.id)),
  unchanged_projects: data.projects.filter((p) => !eligibleProjects.has(p.id)) };
fs.mkdirSync(output, { recursive: true });
fs.writeFileSync(path.join(output, "compliance3-ownership-proposal.json"), JSON.stringify(outputData, null, 2));
fs.writeFileSync(path.join(output, "eligible-pairs.csv"), csv(
  ["contractor_id", "contractor", "project_id", "project_number", "assignment_id", "action", "prior_sources", "result_sources",
    "current_policy_links", "source_rows", "vendor_mapping_ids", "division_mapping_ids", "contractor_division_ids", "import_audit_ids", "import_run_id", "import_history_id"],
  proposal.pairs.map((p) => [p.contractor_id, p.company_name, p.project_id, p.project_number, p.assignment_id, p.action,
    p.prior_ownership_sources.join(" / "), p.resulting_ownership_sources.join(" / "), p.has_current_policy_links,
    p.evidence.map((e) => e.source_row).join(";"), [...new Set(p.evidence.map((e) => e.vendor_mapping_id))].join(";"),
    [...new Set(p.evidence.map((e) => e.division_mapping_id))].join(";"), [...new Set(p.evidence.map((e) => e.contractor_division_id))].join(";"),
    [...new Set(p.evidence.flatMap((e) => e.import_audit_ids))].join(";"), runId, 10])));
fs.writeFileSync(path.join(output, "excluded-relationships.csv"), csv(
  ["vendor", "division", "frozen_contractor_id", "frozen_project_id", "reason", "source_rows", "frozen_review_reasons"],
  [...excludedGroups.values()].map((e) => [e.raw_vendor, e.raw_division, e.contractor_id, e.project_id, e.reason,
    e.source_rows.join(";"), e.frozen_review_reasons.join(" | ")])));
fs.writeFileSync(path.join(output, "unchanged-assignments.csv"), csv(
  ["assignment_id", "contractor_id", "project_id", "active", "ownership_sources"],
  unchangedAssignments.map((a) => [a.id, a.contractor_id, a.project_id, a.active, a.ownership_sources.join(" / ")])));
fs.writeFileSync(path.join(output, "unchanged-contractors.csv"), csv(["contractor_id", "company_name", "active"],
  outputData.unchanged_contractors.map((c) => [c.id, c.company_name, c.active])));
fs.writeFileSync(path.join(output, "unchanged-projects.csv"), csv(["project_id", "project_number", "project_name", "status"],
  outputData.unchanged_projects.map((p) => [p.id, p.project_number, p.project_name, p.status])));
const bnb = proposal.pairs.filter((p) => p.contractor_id === 59).sort((a, b) =>
  a.project_number.localeCompare(b.project_number, "en", { numeric: true }));
const bnbUnchanged = unchangedAssignments.filter((a) => a.active && a.contractor_id === 59).map((a) => ({
  ...a, project_number: data.projects.find((p) => p.id === a.project_id)?.project_number,
})).sort((a, b) => a.project_number.localeCompare(b.project_number, "en", { numeric: true }));
const report = [
  "# Compliance(3) additive ownership correction proposal",
  "", `Read-only capture: ${capturedAt}. All prerequisites reread unchanged before publication.`,
  "**PROPOSED ONLY. No shared-data correction or migration was executed.**",
  "", `Run: ${runId}; history: 10; finalized revision: ${proposal.revision}.`,
  `Reviewed proposal token: \`${proposal.proposal_token}\`. This is a drift guard, not execution authorization.`,
  "", "## Exact counts", "", "| Category | Count |", "|---|---:|",
  ...Object.entries({ ...proposal.counts, ...extraCounts }).filter(([, v]) => typeof v === "number").map(([k, v]) => `| ${k} | ${v} |`),
  "", "Excluded source rows by reason:", ...Object.entries(extraCounts.excluded_by_reason).map(([k, v]) => `- ${k}: ${v}`),
  "", "## Exact B&B proposal (contractor 59)", "",
  "Every eligible row requires agreement between imported-row ledger, same-run Import audit, frozen accepted contractor/project identity,",
  "and exact persisted active mapping/division provenance for history 10 and this run. No name-similarity matching is used.",
  "", "| Project | ID | Before | After | Current evidence | Source row(s) | VM / DM / CD | Import audit(s) |",
  "|---|---:|---|---|---|---|---|---|",
  ...bnb.map((p) => `| ${p.project_number} | ${p.project_id} | ${p.prior_ownership_sources.join(" + ")} | ${p.resulting_ownership_sources.join(" + ")} | ${
    p.has_current_policy_links ? "Policy-linked" : "Resolved division only"} | ${p.evidence.map((e) => e.source_row).join(", ")} | ${
    p.evidence.map((e) => `${e.vendor_mapping_id}/${e.division_mapping_id}/${e.contractor_division_id}`).join(", ")} | ${
    [...new Set(p.evidence.flatMap((e) => e.import_audit_ids))].join(", ")} |`),
  "", "B&B assignments unchanged (remain MANUAL / display MAN):",
  ...bnbUnchanged.map((a) => `- ${a.project_number}, project ${a.project_id}, assignment ${a.id}: ${a.ownership_sources.join(" + ")}`),
  "", "B&B eligible assignments would display MAN / COI from the real database sources after an approved correction.",
  "", "## Complete review files", "",
  "- [eligible-pairs.csv](./eligible-pairs.csv): exact distinct contractor/project set, before/after and original evidence IDs.",
  "- [excluded-relationships.csv](./excluded-relationships.csv): every excluded vendor/division group, row IDs, reason and frozen identity.",
  "- [unchanged-assignments.csv](./unchanged-assignments.csv): all existing assignment rows that will not be changed.",
  "- [unchanged-contractors.csv](./unchanged-contractors.csv) and [unchanged-projects.csv](./unchanged-projects.csv): exact entities with no eligible pairs.",
  "- [compliance3-ownership-proposal.json](./compliance3-ownership-proposal.json): full machine-readable proposal and exact unchanged contractor/project lists.",
  "", "An excluded raw vendor/division is not called a verified contractor/project pair when its identity was never accepted.",
  "An entity with eligible pairs still retains all its unrelated assignments and master data unchanged.",
  "", "## Transaction, audit and retry contract", "",
  "The new service-only correction validates this exact run/file/history, requires retained finalized evidence,",
  "rejects later COMPLETE authority, requires an active authorized administrator and the reviewed proposal token,",
  "and rechecks proof/membership under import/source locks and table locks. Only MYCOI additions use the existing source helper.",
  "Already-MYCOI pairs are skipped without updates/audits. Inactive history is preserved; missing membership gets a new active row.",
  "Each addition gets the standard source audit/activity plus one correction audit containing run/history, prior/result sources,",
  "actor/time/reason and evidence IDs. A single receipt prevents duplicate correction/audit entries on identical retry.",
  "All additions, audits and the receipt commit together or roll back together. Nothing unfinalizes or reimports the source.",
  "", "Definitions are in the NOT APPLIED migration `supabase/20261108_compliance3_ownership_correction.sql`.",
  "Installing the definitions does not execute the correction. Applying/confirming it is a separate controlled, service-only action.",
  "The prospective Import rule remains in the separate NOT APPLIED `20261107_mycoi_import_project_ownership.sql` migration.",
  "", "## Local validation results", "",
  "The real SQL migration and correction passed the isolated PGlite ownership suite:",
  "- Definitions-only migration and migration-failure rollback leave business data unchanged.",
  "- B&B-shaped fixture: 29 original assignments, 20 verified overlaps (including three division-only), nine untouched.",
  "- Full fixture: 30 eligible pairs, 26 additions, three new assignments, four already-correct pairs skipped.",
  "- Exact row/audit/frozen/mapping proof; aliases deduplicated; approved Add included; unexecuted Add, ignored and unresolved excluded.",
  "- Unauthorized/inactive administrators, stale proposal/ownership/evidence, another-import provenance and later COMPLETE authority rejected.",
  "- Forced ownership, standard audit, correction audit, activity and final receipt failures roll back all writes.",
  "- Second identical call returns the saved receipt with zero new assignments, ownership, audit or activity entries.",
  "- All original sources/inactive history and unrelated assignments, contractor/project master data, policies, mappings,",
  "  finalized run/history and snapshots remain unchanged except for eligible additive membership and its audits/receipt.",
  "",
  "No live administrator has been selected or attributed: that is required only for a separately approved execution.",
  "Recalculate/review the service-only proposal after definition installation and before execution; any token drift blocks the correction.",
  "", "No ownership removal, COMPLETE acceptance, source-data deletion, production mutation, import rerun, unfinalization, deployment or push was performed.",
  "",
];
fs.writeFileSync(path.join(output, "REPORT.md"), report.join("\n"));
console.log(JSON.stringify({ capturedAt, proposal_token: proposal.proposal_token, counts: proposal.counts, ...extraCounts,
  bnb_pairs: bnb.length, bnb_unchanged: bnbUnchanged.length, output }, null, 2));
