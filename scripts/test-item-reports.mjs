import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url), cells = [];
const cache = new Map();
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const loadedModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, { module: loadedModule, exports: loadedModule.exports, Date, Intl, Set,
  require: id => {
    if (id.startsWith(".")) return load(path.resolve(path.dirname(file), `${id}.ts`));
    if (id === "jspdf-autotable") return { default: (document, options) => require(id).default(document, {
      ...options, didDrawCell: data => cells.push({ section: data.section, row: data.row.index, column: data.column.index,
        page: document.internal.getCurrentPageInfo().pageNumber, text: data.cell.text.join(" "),
        fill: data.cell.styles.fillColor, font: data.cell.styles.fontSize,
        y: data.cell.y, bottom: data.cell.y + data.cell.height }),
    }) };
    assert.equal(id, "jspdf", "PDF is presentation-only; it must not fetch data or calculate requirements.");
    return require(id);
  } });
  cache.set(file, loadedModule.exports);
  return loadedModule.exports;
}
const { itemReportPdf } = load("services\\item-report-pdf.ts");
const { itemReportColumns, itemReportExpiration, itemReportColor } = load("services\\item-reports.ts");
const project = { id: 11, project_number: "21-002", project_name: "School", public_works: false, status: "Active" };
const context = "21-002 - School";
const fixture = count => Array.from({ length: count }, (_, index) => ({
  id: `missing:${index}`, contractorId: Math.floor(index / 2) + 1,
  companyName: `Company ${Math.floor(index / 2) + 1}`, item: index % 2 ? "Worker's Comp" : "NJ BRC",
  status: "Missing Information", assignedProjects: context,
  expirationDate: null, daysRemaining: null,
}));
const input = rows => ({ rows, report: "missing-information", scope: { kind: "project", project }, search: "", status: "All statuses",
  generatedAt: new Date("2026-11-09T14:00:00Z") });

test("Missing Information PDF preserves exact four columns, rows, scope and readable red treatment", () => {
  const rows = fixture(80), before = JSON.stringify(rows);
  cells.length = 0;
  const document = itemReportPdf(input(rows));
  assert.ok(Math.abs(document.internal.pageSize.getWidth() - 279.4) < .1);
  assert.ok(Math.abs(document.internal.pageSize.getHeight() - 215.9) < .1);
  assert.equal(document.getNumberOfPages(), 4);
  const body = cells.filter(cell => cell.section === "body");
  assert.equal(body.length, rows.length * 4);
  rows.forEach((row, index) => {
    const printed = body.filter(cell => cell.row === index);
    assert.deepEqual(printed.map(cell => cell.text), [row.companyName, row.item, row.status, context]);
    assert.equal(new Set(printed.map(cell => cell.page)).size, 1);
    printed.forEach(cell => {
      assert.deepEqual(Array.from(cell.fill), [249, 202, 207]);
      assert.equal(cell.font, 9);
      assert.ok(cell.y >= 19 && cell.bottom <= 201);
    });
  });
  assert.equal(JSON.stringify(rows), before);
  for (let page = 1; page <= document.getNumberOfPages(); page++) {
    const text = document.internal.pages[page].join("\n");
    assert.equal((text.match(/SubTracker \/ Missing Information \/ 21-002 - School/g) ?? []).length, 1);
    assert.ok(text.includes(`Page ${page} of ${document.getNumberOfPages()}`));
    assert.deepEqual(cells.filter(cell => cell.page === page && cell.section === "head").map(cell => cell.text),
      ["Company Name", "Missing Item", "Status", "Assigned Projects"]);
  }
  assert.ok(document.output().includes("80 missing items | 40 contractors"));
  assert.doesNotMatch(document.output(), /23-007|25-900|Fully Compliant/);
});

test("All Projects retains broader assignments and filters without changing rows", () => {
  const rows = fixture(2).map(row => ({ ...row, assignedProjects: "21-002, 23-007, 25-900" }));
  const document = itemReportPdf({ ...input(rows), scope: { kind: "all" }, search: "Company 1",
    status: "Missing Information" });
  assert.ok(document.output().includes("SubTracker / Missing Information / All Projects"));
  assert.ok(document.output().includes("21-002, 23-007, 25-900"));
  assert.ok(document.output().includes("Search: Company 1"));
  assert.ok(document.output().includes("2 missing items | 1 contractors"));
});

test("Invalid selected-project projections fail closed without broader fallback", () => {
  for (const invalid of [
    input([{ ...fixture(1)[0], assignedProjects: "21-002, 23-007" }]),
    input([...fixture(1), ...fixture(1)]),
    input([{ ...fixture(1)[0], status: "Active" }]),
    { ...input(fixture(1)), scope: { kind: "project", project: { ...project, id: 0 } } },
    { ...input(fixture(1)), generatedAt: new Date("invalid") },
  ]) assert.throws(() => itemReportPdf(invalid), /invalid/);
});

test("expiration reports share inclusive boundaries and preserve authoritative source expiration overrides", () => {
  const record = { record_key: "compliance:1", contractor_id: 1, company_name: "Example", compliance_name: "NJ PWC",
    registration_number: "present", expiration_date: null, days_remaining: 999, calculated_status: "Active" };
  for (const [days, status, color] of [
    [91, "Current", null], [90, "61-90 Days", [255, 246, 202]], [61, "61-90 Days", [255, 246, 202]],
    [60, "31-60 Days", [255, 232, 201]], [31, "31-60 Days", [255, 232, 201]],
    [30, "0-30 Days", [255, 222, 222]], [0, "0-30 Days", [255, 222, 222]], [-1, "Expired", [249, 202, 207]],
  ]) {
    const date = new Date(Date.parse("2026-11-09T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
    const result = itemReportExpiration({ ...record, expiration_date: date, calculated_status: days <= 0 ? "Expired" : "Active" }, "2026-11-09");
    assert.equal(result.status, status);
    assert.equal(result.daysRemaining, days);
    if (color) {
      assert.deepEqual(Array.from(itemReportColor(status).fill), color);
      cells.length = 0;
      const report = status === "Expired" ? "expired-items" : "upcoming-expirations";
      const rows = [{ ...fixture(1)[0], item: "NJ PWC", status, expirationDate: date, daysRemaining: days }];
      const document = itemReportPdf({ ...input(rows), report });
      assert.deepEqual(cells.filter(cell => cell.section === "head").map(cell => cell.text),
        Array.from(itemReportColumns[report], column => column.label));
      for (const cell of cells.filter(cell => cell.section === "body")) {
        assert.deepEqual(Array.from(cell.fill), color, "Entire row uses authoritative bucket.");
      }
      assert.ok(document.output().includes(`(${String(days)}) Tj`));
      assert.ok(document.output().includes(`SubTracker / ${report === "expired-items" ? "Expired Items" : "Upcoming Expirations"} / ${context}`));
    }
  }
  assert.equal(itemReportExpiration({ ...record, calculated_status: "Expired", expiration_date: "2027-12-01" }, "2026-11-09").status, "Expired",
    "Registry/source expiration must not be erased by a future date.");
  assert.equal(itemReportExpiration({ ...record, compliance_name: "NJ BRC", expiration_date: "1990-01-01" }, "2026-11-09").status, "Active");
  assert.equal(itemReportExpiration({ ...record, calculated_status: "Missing Information", expiration_date: "2026-11-08" }, "2026-11-09").status, "Missing Information");
  assert.throws(() => itemReportExpiration({ ...record, expiration_date: "2026-02-30" }, "2026-11-09"), /invalid/);
});

test("both expiration PDFs retain exact columns and running scope on every page", () => {
  for (const [report, status, date, days] of [
    ["expired-items", "Expired", "2026-11-08", -1],
    ["upcoming-expirations", "31-60 Days", "2026-12-10", 31],
  ]) {
    const rows = fixture(80).map(row => ({ ...row, item: "General Liability", status, expirationDate: date, daysRemaining: days }));
    cells.length = 0;
    const document = itemReportPdf({ ...input(rows), report });
    assert.ok(document.getNumberOfPages() > 1);
    const columns = Array.from(itemReportColumns[report], column => column.label);
    const body = cells.filter(cell => cell.section === "body");
    assert.equal(body.length, rows.length * columns.length);
    for (let page = 1; page <= document.getNumberOfPages(); page++) {
      assert.deepEqual(cells.filter(cell => cell.page === page && cell.section === "head").map(cell => cell.text), columns);
      assert.ok(document.internal.pages[page].join("\n").includes(
        `SubTracker / ${report === "expired-items" ? "Expired Items" : "Upcoming Expirations"} / ${context}`));
      assert.ok(document.internal.pages[page].join("\n").includes(`Page ${page} of ${document.getNumberOfPages()}`));
    }
    for (let row = 0; row < rows.length; row++) {
      const printed = body.filter(cell => cell.row === row);
      assert.equal(new Set(printed.map(cell => cell.page)).size, 1, "An item must not split across pages.");
      assert.ok(printed.every(cell => cell.y >= 19 && cell.bottom <= 201));
      assert.equal(printed.find(cell => cell.column === 2).text, report === "expired-items" ? "11/08/2026" : "12/10/2026");
      assert.equal(printed.find(cell => cell.column === 3).text, String(days));
    }
    const broader = rows.map(row => ({ ...row, assignedProjects: "21-002, 23-007" }));
    assert.ok(itemReportPdf({ ...input(broader), report, scope: { kind: "all" } }).output().includes("21-002, 23-007"));
    assert.throws(() => itemReportPdf({ ...input(broader), report }), /invalid/);
  }
});
