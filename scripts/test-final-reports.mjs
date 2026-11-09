import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url), cells = [], cache = new Map();
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
          fill: data.cell.styles.fillColor, font: data.cell.styles.fontSize, bottom: data.cell.y + data.cell.height }),
      }) };
      assert.equal(id, "jspdf", "Presentation helpers cannot fetch data.");
      return require(id);
    },
  });
  cache.set(file, loadedModule.exports);
  return loadedModule.exports;
}
const { finalReportPdf } = load("services\\final-report-pdf.ts");
const { finalReportColumns, finalReportColor, selectedProjectSummary } = load("services\\final-reports.ts");
const { itemReportExpiration } = load("services\\item-reports.ts");
const project = { id: 18, project_number: "24-002", project_name: "NJSDA Garfield ES", public_works: true, status: "Active" };
const context = `${project.project_number} - ${project.project_name}`;
const fixture = count => Array.from({ length: count }, (_, i) => ({
  id: `row:${i}`, contractorId: i + 1, companyName: `Company ${i}`, status: "Compliant", assignedProjects: context,
  item: "General Liability", expirationDate: "2027-01-08", daysRemaining: 60,
  complianceIssues: "", insuranceIssues: "", followupDate: "2026-11-09", lastFollowup: "2026-11-09",
  method: "Email", subject: "Send renewal", notes: "Contractor-level workflow note",
}));
const input = (report, rows) => ({ report, rows, scope: { kind: "project", project }, search: "", status: "All statuses",
  generatedAt: new Date("2026-11-09T14:00:00Z") });

test("final three reports retain their original columns and approved Letter table formatting", () => {
  const expected = {
    "project-compliance": ["Contractor", "Status", "Assigned Projects", "Compliance Issues", "Insurance Issues"],
    insurance: ["Company Name", "Insurance Item", "Status", "Expiration Date", "Days Remaining", "Assigned Projects"],
    "follow-up": ["Company Name", "Status", "Follow-Up Date", "Last Follow-Up", "Method", "Subject", "Notes"],
  };
  for (const [report, headers] of Object.entries(expected)) {
    const rows = fixture(60).map(row => ({ ...row, status: report === "insurance" ? "31-60 Days" : report === "follow-up" ? "Open" : "Compliant" }));
    const before = JSON.stringify(rows);
    cells.length = 0;
    const document = finalReportPdf({ ...input(report, rows), ...(report === "follow-up" ? { scope: { kind: "all" } } : {}) });
    assert.ok(Math.abs(document.internal.pageSize.getWidth() - 279.4) < .1);
    assert.ok(Math.abs(document.internal.pageSize.getHeight() - 215.9) < .1);
    assert.ok(document.getNumberOfPages() > 1);
    assert.deepEqual(Array.from(finalReportColumns[report], col => col.label), headers);
    assert.equal(cells.filter(cell => cell.section === "body").length, rows.length * headers.length);
    for (let page = 1; page <= document.getNumberOfPages(); page++) {
      assert.deepEqual(cells.filter(cell => cell.page === page && cell.section === "head").map(cell => cell.text), headers);
      const text = document.internal.pages[page].join("\n");
      assert.equal((text.match(/SubTracker \//g) ?? []).length, 1);
      assert.ok(text.includes(report === "follow-up" ? "/ All Projects" : `/ ${context}`));
      assert.ok(text.includes(`Page ${page} of ${document.getNumberOfPages()}`));
    }
    for (let index = 0; index < rows.length; index++) {
      const printed = cells.filter(cell => cell.section === "body" && cell.row === index);
      assert.equal(new Set(printed.map(cell => cell.page)).size, 1);
      assert.ok(printed.every(cell => cell.font === 9 && cell.bottom <= 201));
      for (const cell of printed) assert.deepEqual(Array.from(cell.fill), Array.from(finalReportColor(rows[index].status).fill));
      if (report === "project-compliance") assert.equal(printed[2].text, "Selected project");
    }
    assert.equal(JSON.stringify(rows), before);
    assert.doesNotMatch(document.output(), /23-007|25-900/);
  }
});

test("project summary reuses assessments, excludes inapplicable PWC and retains review/material authority", () => {
  const company = { id: 1, name: "Example", materialOnly: false, state: "Fully Compliant", requirements: [
    { requirement: "FEIN", applicable: true, status: "Current" },
    { requirement: "NJ BRC", applicable: true, status: "Current" },
    { requirement: "NJ PWC", applicable: false, status: "Not Required" },
  ] };
  const insurance = { record_key: "insurance:1", contractor_id: 1, company_name: "Example", compliance_name: "General Liability",
    expiration_date: "2026-11-09", days_remaining: 0, calculated_status: "Expired" };
  const unrelated = { ...insurance, contractor_id: 2, expiration_date: "2020-01-01" };
  assert.equal(selectedProjectSummary(company, [unrelated], "2026-11-09").status, "Compliant");
  assert.equal(selectedProjectSummary(company, [insurance, unrelated], "2026-11-09").severity, "0-30 Days");
  assert.equal(selectedProjectSummary(company, [insurance], "2026-11-09").insuranceIssues, "General Liability: 0-30 Days");
  const missing = { ...company, requirements: [...company.requirements, { requirement: "FEIN", applicable: true, status: "Missing" }] };
  assert.equal(selectedProjectSummary(missing, [], "2026-11-09").status, "Non-Compliant");
  assert.match(selectedProjectSummary(missing, [], "2026-11-09").complianceIssues, /FEIN: Missing/);
  const unknown = { ...company, requirements: [{ requirement: "NJ BRC", applicable: false, status: "Unavailable" }] };
  assert.equal(selectedProjectSummary(unknown, [], "2026-11-09").status, "Needs Review");
  assert.match(selectedProjectSummary(unknown, [], "2026-11-09").complianceIssues, /NJ BRC: Unavailable/);
  assert.equal(selectedProjectSummary({ ...missing, materialOnly: true }, [], "2026-11-09").status, "Material Only");
});

test("Insurance colors and day counts reuse all inclusive shared boundaries", () => {
  for (const [days, status] of [[91, "Current"], [90, "61-90 Days"], [61, "61-90 Days"], [60, "31-60 Days"],
    [31, "31-60 Days"], [30, "0-30 Days"], [0, "0-30 Days"], [-1, "Expired"]]) {
    const date = new Date(Date.parse("2026-11-09T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);
    const result = itemReportExpiration({ calculated_status: days <= 0 ? "Expired" : "Active", compliance_name: "General Liability", expiration_date: date }, "2026-11-09");
    assert.equal(result.status, status);
    assert.equal(result.daysRemaining, days);
    cells.length = 0;
    finalReportPdf(input("insurance", [{ ...fixture(1)[0], status, daysRemaining: days, expirationDate: date }]));
    for (const cell of cells.filter(cell => cell.section === "body")) {
      assert.deepEqual(Array.from(cell.fill), Array.from(finalReportColor(status).fill));
    }
  }
  assert.throws(() => finalReportColor("unknown"), /Unsupported/);
});

test("Follow-Up scoped PDF documents the exact model gap and rejects inferred attributed rows", () => {
  for (const scope of [{ kind: "project", project }, { kind: "unassigned" }]) {
    const document = finalReportPdf({ ...input("follow-up", []), scope });
    assert.match(document.output(), /Project-specific Follow-Up unavailable/);
    assert.match(document.output(), /contractor_followups has no project_id/);
    assert.match(document.output(), /Project attribution unavailable/);
    assert.doesNotMatch(document.output(), /0 follow-ups/);
    assert.throws(() => finalReportPdf({ ...input("follow-up", fixture(1)), scope }), /invalid/);
  }
  assert.throws(() => finalReportPdf(input("insurance", [{ ...fixture(1)[0], assignedProjects: "24-002, 23-007" }])), /invalid/);
  assert.throws(() => finalReportPdf(input("project-compliance", [...fixture(1), ...fixture(1)])), /invalid/);
  assert.throws(() => finalReportPdf({ ...input("insurance", fixture(1)), generatedAt: new Date("invalid") }), /invalid/);
});
