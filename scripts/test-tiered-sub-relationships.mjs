import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const calls = [];
let tables = {};
let failure = null;
let hookStates = [];
class Query {
  constructor(table) { this.table = table; this.filters = []; this.orders = []; this.start = 0; this.end = Infinity; calls.push(this); }
  select(columns, options) { this.head = options?.head; return this; }
  eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
  neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
  in(column, values) { this.ids = values; this.filters.push((row) => values.includes(row[column])); return this; }
  order(column) { this.orders.push(column); return this; }
  range(start, end) { this.start = start; this.end = end; return this; }
  returns() { return this; }
  then(resolve, reject) {
    if (failure === this.table) return Promise.resolve({ data: null, error: { message: "Synthetic read failure" } }).then(resolve, reject);
    const rows = (tables[this.table] ?? []).filter((row) => this.filters.every((filter) => filter(row))).sort((a, b) => {
      for (const column of this.orders) {
        if (a[column] !== b[column]) return a[column] < b[column] ? -1 : 1;
      }
      return 0;
    });
    return Promise.resolve({ data: this.head ? null : rows.slice(this.start, this.end + 1), error: null, count: rows.length }).then(resolve, reject);
  }
}
const supabase = { from: (table) => new Query(table) };
function compile(source, filename, dependencies = {}) {
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  const loadedModule = { exports: {} };
  const localRequire = (id) => {
    if (id === "@/lib/supabase") return { supabase };
    if (id in dependencies) return dependencies[id];
    if (id === "next/link") return { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
    return require(id);
  };
  vm.runInNewContext(code, { module: loadedModule, exports: loadedModule.exports, require: localRequire, Date, Map, Set }, { filename });
  return loadedModule.exports;
}
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const assignments = compile(read("services\\assignments.ts"), "assignments.ts");
const dashboard = compile(read("services\\dashboard.ts"), "dashboard.ts", { "@/services/assignments": assignments });
const baseline = compile(execFileSync("git", ["--no-pager", "show", "d276979422c2724e27b93a28ac544b16d95f8dde:services/dashboard.ts"], { cwd: root, encoding: "utf8" }), "baseline.ts", { "@/services/assignments": assignments });
const panel = compile(read("src\\components\\contractors\\TieredSubRelationshipsPanel.tsx"), "panel.tsx", {
  "@/services/assignments": assignments, "@/services/dashboard": dashboard,
  react: { ...React, useEffect() {}, useState: () => [hookStates.shift(), () => {}] },
});
const plain = (value) => JSON.parse(JSON.stringify(value));
const row = (id, status = "Active") => ({
  contractor_id: id, company_name: `Contractor ${id}`, contractor_active: true,
  compliance_record_id: id, compliance_type_id: 1, compliance_name: "NJ PWC",
  registration_number: "00123", expiration_date: "2099-01-01", days_remaining: 1000, calculated_status: status,
});
const insurance = (id) => ({
  contractor_id: id, certificate_on_file: true, general_liability_on_file: true,
  general_liability_expiration_date: "2099-01-01", workers_comp_on_file: true, workers_comp_expiration_date: "2099-01-01",
});
const assignment = (id, contractorId, projectId, number, overrides = {}) => ({
  id, contractor_id: contractorId, project_id: projectId, active: true,
  projects: { project_number: number, project_name: `Project ${projectId}`, status: "Active" }, ...overrides,
});
function reset() { calls.length = 0; tables = {}; failure = null; }

test("Dashboard records and counts are identical to committed logic", async () => {
  reset();
  tables = {
    contractor_compliance_status: [
      ...["Active", "90 Day", "60 Day", "30 Day", "Expired", "Missing Information"].map((status, index) => row(index + 1, status)),
      { ...row(7), compliance_record_id: null, compliance_name: null },
      { ...row(1, "30 Day"), compliance_record_id: 8 },
    ],
    contractor_insurance: [
      insurance(1), { ...insurance(2), general_liability_expiration_date: "2000-01-01" },
      { ...insurance(3), certificate_on_file: false }, { ...insurance(4), workers_comp_on_file: false },
      { ...insurance(5), general_liability_expiration_date: null },
    ],
    contractor_projects: [assignment(1, 1, 1, "25-900"), assignment(2, 1, 1, "25-900"), assignment(3, 2, 2, "25-901", { projects: { project_number: "25-901", status: "Completed" } })],
    contractors: [{ id: 1, active: true, material_vendor_only: true }, { id: 2, active: false }],
    projects: [{ id: 1, status: "Active" }, { id: 2, status: "Completed" }],
  };
  const before = await baseline.getDashboardData();
  const after = await dashboard.getDashboardData();
  assert.deepEqual(plain(after), plain(before));
  assert.deepEqual(plain([...after.data.projectNumbersByContractor]), plain([...before.data.projectNumbersByContractor]));
  const ids = [1, 2, 3, 4, 5, 6, 7];
  const statuses = await dashboard.getCompanyComplianceStatuses(ids);
  for (const id of ids) {
    assert.equal(statuses.data.get(id), baseline.getCompanyComplianceStatus(before.data.records.filter((record) => record.contractor_id === id)));
  }
});

test("status retrieval makes two filtered requests, not queries per row", async () => {
  reset();
  tables.contractor_compliance_status = [row(2), row(3, "90 Day"), row(4, "Missing Information"), row(99)];
  tables.contractor_insurance = [2, 3, 4, 99].map(insurance);
  const result = await dashboard.getCompanyComplianceStatuses([2, 3, 4, 2, 8]);
  assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls.map((query) => query.ids)), [[2, 3, 4, 8], [2, 3, 4, 8]]);
  assert.equal(result.data.get(2), "Compliant");
  assert.equal(result.data.get(3), "Expiring");
  assert.equal(result.data.get(4), "Non-Compliant");
  assert.equal(result.data.has(8), false, "Unavailable contractors must not get guessed status");
  assert.equal(result.data.has(99), false);
});

test("empty batches make no requests", async () => {
  reset();
  assert.equal((await dashboard.getCompanyComplianceStatuses([])).data.size, 0);
  assert.equal((await assignments.getAssignmentsForContractors([])).data.length, 0);
  assert.equal(calls.length, 0);
});

test("large ID lists are chunked and compliance results are paginated", async () => {
  reset();
  tables.contractor_compliance_status = Array.from({ length: 1001 }, (_, index) => ({ ...row(1), compliance_record_id: index + 1 }));
  tables.contractor_insurance = [insurance(1)];
  const result = await dashboard.getCompanyComplianceStatuses(Array.from({ length: 101 }, (_, index) => index + 1));
  assert.equal(result.data.get(1), "Compliant");
  assert.equal(calls.filter((query) => query.table === "contractor_compliance_status").length, 3);
  assert.equal(calls.filter((query) => query.table === "contractor_insurance").length, 2);
  assert.ok(calls.every((query) => query.ids.length <= 100));
});

test("batched assignments exclude inactive rows, preserve project status, and paginate", async () => {
  reset();
  tables.contractor_projects = [
    ...Array.from({ length: 1001 }, (_, index) => assignment(index + 1, 2, index + 1, String(index + 1))),
    assignment(2000, 2, 2000, "0", { active: false }),
    assignment(2001, 3, 2001, "25-900", { projects: { project_number: "25-900", status: "Completed" } }),
  ];
  const result = await assignments.getAssignmentsForContractors([2, 3, 2]);
  assert.equal(result.data.length, 1002);
  assert.equal(calls.length, 2);
  assert.equal(result.data.some((item) => item.id === 2000), false);
  assert.equal(result.data.find((item) => item.id === 2001).projects.status, "Completed");
});

test("read failures return explicit errors instead of partial successful data", async () => {
  for (const table of ["contractor_compliance_status", "contractor_insurance", "contractor_projects"]) {
    reset();
    failure = table;
    const result = table === "contractor_projects" ? await assignments.getAssignmentsForContractors([2]) : await dashboard.getCompanyComplianceStatuses([2]);
    assert.equal(result.data, null);
    assert.equal(result.error.message, "Synthetic read failure");
  }
});

test("shared projects intersect active assignments, deduplicate IDs, and sort naturally", () => {
  const parent = [assignment(1, 1, 1, "25-10"), assignment(2, 1, 2, "25-2"), assignment(3, 1, 3, "25-3", { active: false })];
  const child = [assignment(4, 2, 1, "25-10"), assignment(5, 2, 2, "25-2"), assignment(6, 2, 2, "25-2"), assignment(7, 2, 3, "25-3"), assignment(8, 2, 4, "25-4"), assignment(9, 2, 1, "25-10", { active: false })];
  assert.deepEqual(Array.from(panel.getSharedAssignments(parent, child), (item) => item.project_id), [2, 1]);
});

const relationships = [2, 3, 4, 5].map((id) => ({ id, contractor_id: 1, tiered_sub_contractor_id: id, active: id !== 5, tiered_sub_contractor: { company_name: `Sub ${id}` } }));
function renderPanel(projectError = null, statusError = null) {
  hookStates = [
    { key: "2,3,4", assignments: [assignment(1, 2, 1, "25-900")], error: projectError },
    { key: "2,3,4", statuses: new Map([[2, "Compliant"], [3, "Expiring"]]), error: statusError },
  ];
  return renderToStaticMarkup(React.createElement(panel.default, {
    contractorId: 1, companyName: "Parent", relationships,
    parentAssignments: [assignment(2, 1, 1, "25-900")], loading: false, error: null,
  }, React.createElement("button", { type: "button" }, "Manage Tiered Subs")));
}
test("panel renders active-only contractor links, project links, compact badges and controls", () => {
  const html = renderPanel();
  assert.match(html, /Relationships \(3\)/);
  assert.match(html, /href="\/contractors\/2"/);
  assert.doesNotMatch(html, /Sub 5/);
  assert.match(html, /href="\/projects\?projectId=1"/);
  assert.match(html, /Compliant/);
  assert.match(html, /Expiring/);
  assert.match(html, /Status unavailable/);
  assert.match(html, /No Shared Assigned Projects/);
  assert.match(html, /Manage Tiered Subs/);
});
test("status and shared-project failures remain non-blocking and explicit", () => {
  const html = renderPanel("Synthetic project failure", "Synthetic status failure");
  assert.match(html, /href="\/contractors\/2"/);
  assert.match(html, /Shared projects unavailable/);
  assert.doesNotMatch(html, /No Shared Assigned Projects/);
  assert.match(html, /Synthetic project failure/);
  assert.match(html, /Synthetic status failure/);
});

const projectSource = read("src\\app\\projects\\page.tsx");
const projectAst = ts.createSourceFile("projects.tsx", projectSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let deepLinkEffect;
let closeDetail;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(projectAst) === "useEffect" && node.getText(projectAst).includes("requestedProjectId")) deepLinkEffect = node.arguments[0].getText(projectAst);
  if (ts.isVariableDeclaration(node) && node.name.getText(projectAst) === "closeDetail") closeDetail = node.initializer.getText(projectAst);
  ts.forEachChild(node, visit);
}
visit(projectAst);
function expression(value, context) {
  const code = ts.transpileModule(`(${value})`, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  return vm.runInNewContext(code, context);
}
test("project deep links reuse the detail loader and reject invalid/inaccessible IDs", async () => {
  for (const requestedProjectId of ["1", "0", "-1", "abc", "", "999"]) {
    const state = { opened: null, error: null };
    const context = {
      requestedProjectId, handledProjectId: { current: null }, detailRequest: { current: 0 },
      loading: false, error: null, projects: [{ id: 1, project_number: "25-900" }],
      setDeepLinkError: (error) => { state.error = error; }, setDetailProject() {},
      openDetail: async (project) => { state.opened = project.id; },
    };
    expression(deepLinkEffect, context)();
    await Promise.resolve();
    if (requestedProjectId === "1") assert.equal(state.opened, 1);
    else { assert.equal(state.opened, null); assert.ok(state.error); }
  }
});
test("closing linked project removes only projectId from the URL", () => {
  let url;
  const context = {
    requestedProjectId: "1", detailRequest: { current: 0 }, setDetailProject() {},
    searchParams: new URLSearchParams("projectId=1&source=test"), URLSearchParams,
    router: { replace: (value) => { url = value; } },
  };
  expression(closeDetail, context)();
  assert.equal(url, "/projects?source=test");
  assert.equal(context.detailRequest.current, 1);
});
