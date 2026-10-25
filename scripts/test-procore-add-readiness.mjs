import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const result = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(name, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: result, exports: result.exports,
    require: id => load(id.replace("@/lib/", "src/lib/").replace("@/types/", "types/") + ".ts") });
  cache.set(name, result.exports);
  return result.exports;
}
const { buildProcorePreview } = load("src/lib/procore-preview.ts");
const { PROCORE_HEADINGS } = load("types/procore-import.ts");
const row = (number, project = "25-004", changes = {}) => ({
  ...Object.fromEntries(PROCORE_HEADINGS.map(heading => [heading, ""])),
  row: number, "Company (Vendor) > Name": "A&A Concrete Products Inc.",
  "Company (Vendor) > Business Phone": "(973)835-2239", "Company (Vendor) > Address": "PO BOX 108",
  "Company (Vendor) > City": "Riverdale", "Company (Vendor) > State": "NJ",
  "Company (Vendor) > Zip": "07457", "Project > Number": project, ...changes,
});
const decisions = { vendors: { "a and a concrete products": { action: "ADD" } } };
const reference = { token: "fixture", contractors: [], contacts: [], vendors: [],
  projects: [{ id: 13, project_number: "25-004", project_name: "Fixture" }] };
const blocked = buildProcorePreview([row(20, "25-900")], decisions, reference);
assert.equal(blocked.vendors[0].addContractor, true);
assert.equal(blocked.ready.length, 0);
assert(blocked.vendors[0].issues.some(issue => issue.includes("Unmatched project number 25-900")));
assert.equal(blocked.contacts.length, 0, "Blank contacts never block assignments");
const partial = buildProcorePreview([row(20, "25-900"), row(21), row(22)], decisions, reference);
assert.equal(partial.ready.length, 1);
assert.equal(partial.ready[0].rows.join(","), "21,22");
assert.equal(partial.ready[0].assignments.length, 1);
assert.equal(partial.ready[0].createContractor, true);
assert.equal(partial.summary.readyAssignments, 1);
assert.equal(partial.summary.unresolvedRows, 1);
for (const contact of [
  { "User > Full Name": "", "User > Email Address": "bad-email" },
  { "User > Full Name": "Contact", "User > Email Address": "invalid" },
]) {
  const result = buildProcorePreview([row(20, "25-004", contact)], decisions, reference);
  assert.equal(result.ready.length, 1);
  assert.equal(result.ready[0].contacts.length, 0);
  assert(result.contacts[0].issue);
}
const conflict = buildProcorePreview([row(20), row(21, "25-004", {
  "Company (Vendor) > City": "Different city",
})], decisions, reference);
assert.equal(conflict.ready.length, 0);
assert(conflict.vendors[0].issues.some(issue => issue.includes("Conflicting company city")));
for (const project of ["", "25004", "25-900"]) {
  const result = buildProcorePreview([row(20, project)], decisions, reference);
  assert.equal(result.ready.length, 0);
  assert(result.vendors[0].issues.some(issue => issue.includes("Unmatched project number")));
}
const imported = buildProcorePreview([row(20), row(21)], decisions, reference, [20, 21]);
assert.equal(imported.ready.length, 0);
assert(!imported.vendors[0].issues.some(issue => issue.includes("Unmatched project")));
const unchanged = JSON.stringify({ decisions, reference });
buildProcorePreview([row(20)], decisions, reference);
assert.equal(JSON.stringify({ decisions, reference }), unchanged);
console.log("PASS: saved ADD company resolved independently of exact-project readiness; specific unmatched/blank project and company-conflict diagnostics; partial import, repeated rows, blank/invalid contacts, already-imported rows and immutable input decisions/reference.");

if (process.env.PROCORE_ADD_SNAPSHOT) {
  const snapshot = JSON.parse(fs.readFileSync(process.env.PROCORE_ADD_SNAPSHOT, "utf8"));
  const preview = buildProcorePreview(snapshot.run.source_rows, snapshot.run.decisions,
    snapshot.reference, snapshot.run.imported_rows);
  const vendor = preview.vendors.find(vendor => vendor.key === "a and a concrete products");
  assert.equal(snapshot.run.decisions.vendors[vendor.key].action, "ADD");
  assert.equal(vendor.addContractor, true);
  assert.equal(preview.ready.some(plan => plan.key === vendor.key), false);
  assert(vendor.issues.some(issue => issue.includes("Unmatched project number 25-900")));
  assert.deepEqual(JSON.parse(JSON.stringify(preview.summary)), snapshot.summary,
    "Diagnostics do not change existing eligibility, totals, ownership or import plan");
  assert.deepEqual(JSON.parse(JSON.stringify(preview.ready.filter(plan => plan.key === vendor.key))), snapshot.ready);
  console.log(`PASS: retained production A&A snapshot revision ${snapshot.run.revision}: ADD remains saved, exact 25-900 blocker now visible, no plan/calculation change.`);
}
