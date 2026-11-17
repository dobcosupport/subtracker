import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";

const require = createRequire(import.meta.url);
const provenance = { last_imported_at: "2026-10-27T20:23:50Z", import_reference: "Synthetic import", import_history_id: 7 };
const vendor = { id: 1, contractor_id: 8, raw_vendor_name: "Synthetic Vendor", vendor_email: "vendor@example.invalid", vendor_phone: "555-0100", active: true, ...provenance };
const division = (id, projectId, status = "Compliant Finalized") => ({
  id, vendor_mapping_id: 1, active: true, is_current: true, compliance_status: status, ...provenance,
  division: { raw_division_name: `Raw ${id}`, project_id: projectId, project: { project_number: `26-00${projectId}`, project_name: `Project ${projectId}` } },
});
const policy = (id, expired, divisionIds, overrides = {}) => ({
  id, contractor_id: 8, vendor_mapping_id: 1, policy_line: "General Liability", policy_number: `POLICY-${id}`,
  expiration_date: expired ? "2099-01-01" : "2020-01-01", expired, active: true, is_current: true, source: "myCOI",
  divisions: divisionIds.map(id => ({ contractor_division_id: id })), ...provenance, ...overrides,
});
const data = {
  vendors: [vendor, { ...vendor, id: 2, raw_vendor_name: "Second Vendor", vendor_email: null, vendor_phone: null, last_imported_at: null }, { ...vendor, id: 3, active: false }],
  divisions: [division(11, 1), division(12, 2), division(13, 3, "Review Needed"), { ...division(14, 7), active: false }, division(15, 4), division(16, 5), division(17, 6)],
  policies: [
    policy(1, false, [11, 12]), policy(2, true, [11]), policy(3, null, [11]),
    policy(4, false, []), policy(5, false, [14]), policy(6, true, [12], { vendor_mapping_id: 2 }),
    policy(7, true, [11], { active: false }), policy(8, true, [11], { is_current: false }),
    policy(9, true, [11], { vendor_mapping_id: 3 }),
    policy(10, false, [15]), policy(11, true, [16]), policy(12, null, [17]),
  ],
};
let result = { contractorId: 8, data, error: null };
let canView = true;
let projectFilter = "all";
let projectSearch = "";
let hookIndex = 0;
const loaded = { exports: {} };
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL("../src/components/contractors/MycoiInsurancePanel.tsx", import.meta.url), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2020 },
}).outputText, { module: loaded, exports: loaded.exports, require(name) {
  if (name === "react") return { useEffect() {}, useState() {
    const index = hookIndex++;
    if (index === 0) return [result];
    if (index === 1) return [projectFilter, value => { projectFilter = value; }];
    return [projectSearch, value => { projectSearch = value; }];
  } };
  if (name === "react/jsx-runtime") return require(name);
  if (name.endsWith(".module.css")) return { __esModule: true, default: new Proxy({}, { get: (_, key) => key }) };
  if (name === "@/components/SessionContext") return { useSessionProfile: () => ({ permissions: [{ module: "insurance", can_view: canView }] }) };
  if (name === "@/services/mycoi") return { getMycoiInsurance() { throw new Error("Rendering must not start imports or writes"); } };
  if (name === "@/components/style3/Style3Icon" || name === "@/components/style3/Style3Chevron") return { __esModule: true, default: () => null };
  throw new Error(`Unexpected dependency: ${name}`);
} });
const render = (props = {}) => {
  hookIndex = 0;
  return loaded.exports.default({ contractorId: 8, ...props });
};
const html = (props) => renderToStaticMarkup(render(props));
const find = (tree, predicate) => !React.isValidElement(tree) ? [] : [
  ...(predicate(tree) ? [tree] : []),
  ...React.Children.toArray(tree.props.children).flatMap(child => find(child, predicate)),
];
const summary = find(render(), element => element.props["aria-label"] === "Imported myCOI summary")[0];
assert.deepEqual(React.Children.toArray(summary.props.children).map(metric => Array.from(metric.props.children, item => item.props.children)), [
  ["Projects", 6], ["Unique Policies", 9], ["Current (Unique)", 4], ["Expired (Unique)", 3],
], "Unique current imported policies counted once, with unknown expiry neither Current nor Expired");
assert.match(summary.props.title, /Contractor-level unique imported policy records, counted once across projects, not project-policy associations/);
assert.match(summary.props.title, /vendor-alias identities are preserved/);
const sections = html().match(/<details\b[\s\S]*?<\/details>/g);
assert.equal(sections.length, 7, "Six mapped projects plus unassigned policies");
assert.ok(sections.every(section => section.includes('name="mycoi-projects-8"') && !/<details[^>]*\bopen/.test(section)),
  "Native named accordions start collapsed and allow only one expanded project");
assert.match(sections[0], /26-001 · Project 1/);
assert.match(sections[0], /Imported myCOI workflow state, not policy validity[^>]*>myCOI: Compliant Finalized/);
assert.match(sections[0], /3 Policies<\/strong>.*1 Current.*1 Expired/);
assert.match(sections[0], /2020-01-01<\/td><td><span[^>]*>Current/);
assert.match(sections[0], /2099-01-01<\/td><td><span[^>]*>Expired/);
assert.match(sections[0], /Not provided<\/span>/, "Unknown imported flag is not converted into Current");
assert.match(sections[1], /POLICY-1/);
assert.match(sections[1], /POLICY-6/);
assert.match(sections[2], /Review Needed/);
assert.match(sections[2], /No current policies associated with this project/);
assert.match(sections[6], /POLICY-4/);
assert.match(sections[6], /POLICY-5/);
assert.match(sections[2], />0 Policies<\/span>/);
assert.match(sections[2], /neutral[^>]*>0 Expired/);
assert.match(sections[4], /All 1 imported policy for this project is expired/);
assert.doesNotMatch(sections[0], /All .* imported policies/);
const filterButton = name => find(render(), element => element.type === "button" && renderToStaticMarkup(element).includes(name))[0];
assert.match(html(), /All Projects \(6\)/);
assert.match(html(), /Has Expired Policies \(3\)/);
assert.match(html(), /Current Only \(1\)/);
assert.match(html(), /No Policies \(1\)/);
filterButton("Has Expired Policies").props.onClick();
assert.equal((html().match(/<details\b/g) ?? []).length, 3);
assert.match(html(), /26-001 · Project 1/);
assert.match(html(), /26-002 · Project 2/);
assert.match(html(), /26-005 · Project 5/);
assert.doesNotMatch(html(), /Other \/ Unassigned/);
filterButton("Current Only").props.onClick();
assert.equal((html().match(/<details\b/g) ?? []).length, 1);
assert.match(html(), /26-004 · Project 4/);
assert.doesNotMatch(html(), /26-00[12356] · Project/);
filterButton("No Policies").props.onClick();
assert.equal((html().match(/<details\b/g) ?? []).length, 1);
assert.match(html(), /26-003 · Project 3/);
filterButton("All Projects").props.onClick();
const search = value => find(render(), element => element.type === "input" && element.props.type === "search")[0].props.onChange({ target: { value } });
search(" 26-005 ");
assert.equal((html().match(/<details\b/g) ?? []).length, 1);
assert.match(html(), /26-005 · Project 5/);
search("pRoJeCt 4");
assert.match(html(), /26-004 · Project 4/);
filterButton("Has Expired Policies").props.onClick();
assert.match(html(), /No insurance projects match the selected filters/);
search("");
filterButton("All Projects").props.onClick();
assert.doesNotMatch(html(), /POLICY-[789]/);
assert.equal(find(render(), element => element.props["aria-label"] === "myCOI vendor information").length, 2);
for (const label of ["Vendor", "Email", "Phone", "Last Import"]) assert.match(html(), new RegExp(`<dt>${label}</dt>`));
assert.match(html({ historyOnly: true }), /POLICY-7/);
assert.match(html({ historyOnly: true }), /Historical \/ Superseded/);
assert.match(html({ historyOnly: true }), /Synthetic import/);
result = { contractorId: 8, data: { vendors: [], divisions: [], policies: [] }, error: null };
assert.match(html(), /No myCOI vendor mapping has been established/);
assert.equal((html().match(/<dd>0<\/dd>/g) ?? []).length, 4);
result = { contractorId: 8, data: null, error: "Synthetic read failure" };
assert.match(html(), /role="alert"[^>]*>Synthetic read failure/);
assert.doesNotMatch(html(), /Imported myCOI summary/);
result = null;
assert.match(html(), /Loading myCOI insurance/);
canView = false;
assert.match(html(), /You do not have permission/);
assert.doesNotMatch(html(), /Imported myCOI summary/);
console.log("PASS: dynamic counts and filters, number/name search, imported flag authority including unknown/zero policies, aligned status structure, all-expired warning, shared/unassigned/history preservation, exclusive accordions and read permissions/errors.");
