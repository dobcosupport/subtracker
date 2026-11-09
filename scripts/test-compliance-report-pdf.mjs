import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { createRequire } from "node:module";
import ts from "typescript";

const require = createRequire(import.meta.url);
const cache = new Map(), cells = [];
function load(file) {
  file = path.resolve(file);
  if (cache.has(file)) return cache.get(file);
  const loadedModule = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { module: loadedModule, exports: loadedModule.exports, Date, Intl, Set, Map, require: id => {
    if (id === "@/lib/supabase") return { supabase: { from() { throw new Error("PDF must not fetch assessment data."); } } };
    if (id.startsWith(".")) return load(path.resolve(path.dirname(file), `${id}.ts`));
    if (id === "jspdf-autotable") return { default: (document, options) => require(id).default(document, {
      ...options, didDrawCell: data => cells.push({
        page: document.internal.getCurrentPageInfo().pageNumber,
        section: data.section, row: data.row.index, column: data.column.index,
        y: data.cell.y, height: data.cell.height, x: data.cell.x, width: data.cell.width,
        fill: data.cell.styles.fillColor, text: data.cell.styles.textColor, value: data.cell.text.join(" "),
        fontSize: data.cell.styles.fontSize,
      }),
    }) };
    return require(id);
  } });
  cache.set(file, loadedModule.exports);
  return loadedModule.exports;
}
const { complianceReportPdf, compliancePdfSummary, compliancePdfRow } = load("services\\compliance-report-pdf.ts");
const { assessProjectContractor, complianceCompanies, filterComplianceCompanies, complianceSummary } = load("services\\project-compliance-assessment.ts");
const project = { id: 11, project_number: "21-002", project_name: "School", public_works: true, status: "Active" };
const generatedAt = new Date("2026-11-09T14:30:00Z");
function fixture(count = 8) {
  const dates = ["2027-02-09", "2027-02-07", "2027-01-08", "2026-12-09", "2026-11-08", null, "2026-11-09", "2027-01-09"];
  const contractors = Array.from({ length: count }, (_, index) => ({
    id: index + 1, company_name: `Company ${String(index + 1).padStart(3, "0")} ${index % 5 === 0 ? "Long Construction and Specialized Contracting Services LLC" : "Builders"}`,
    active: true, federal_tax_id: "present", state: index === 6 ? "NY" : "NJ", nj_brc_number: null, material_vendor_only: index % 8 === 7,
  }));
  const assessments = contractors.flatMap((contractor, index) => assessProjectContractor(contractor, project, {
    contractor_id: contractor.id, project_id: project.id, applicable: !contractor.material_vendor_only,
  }, ["NJ BRC", "NJ PWC"].map(compliance_name => ({
    contractor_id: contractor.id, compliance_name, registration_number: "on-file",
    expiration_date: compliance_name === "NJ PWC" ? dates[index % dates.length] : null, registry_status: null,
  })), "2026-11-09"));
  return complianceCompanies({ contractors, assessments, project });
}
const input = companies => ({ companies, scope: { kind: "project", project }, status: "All statuses", search: "", generatedAt });
const clone = value => JSON.parse(JSON.stringify(value));

test("letter landscape uses exactly three cells per contractor and no detail blocks or data access", () => {
  const companies = fixture(), before = JSON.stringify(companies);
  cells.length = 0;
  const document = complianceReportPdf(input(companies));
  assert.ok(Math.abs(document.internal.pageSize.getWidth() - 279.4) < .1);
  assert.ok(Math.abs(document.internal.pageSize.getHeight() - 215.9) < .1);
  const body = cells.filter(cell => cell.section === "body");
  assert.equal(body.length, companies.length * 3);
  assert.equal(body.filter(cell => cell.column === 0).length, companies.length);
  companies.forEach((company, index) => {
    const row = body.filter(cell => cell.row === index);
    const expected = compliancePdfRow(company, "2026-11-09");
    assert.deepEqual(row.map(cell => cell.value), [expected.company, expected.status, expected.expiration.replace(/\n/g, " ")]);
    assert.ok(row.every(cell => cell.fontSize === 9));
    [.34, .41, .25].forEach((ratio, column) => {
      assert.ok(Math.abs(row[column].width - 259.4 * ratio) < .01, "Approved column proportions.");
    });
    assert.deepEqual(row[0].fill, row[1].fill, "Company and Status retain severity tint.");
    assert.deepEqual(row[0].text, row[1].text);
    assert.deepEqual(Array.from(row[2].fill), [255, 255, 255], "Expiration cell is clean white.");
    assert.deepEqual(row[2].text, expected.expirationText);
  });
  assert.equal(body.find(cell => cell.row === 0 && cell.column === 1).value, "FULLY COMPLIANT");
  assert.ok(!body.find(cell => cell.row === 0 && cell.column === 0).value.includes("FULLY"));
  assert.equal(JSON.stringify(companies), before);
  assert.doesNotMatch(document.output(), /\(Details\)|\(Requirement\)|Assigned Projects|23-007|25-900/);
});

test("expiration cell color follows its own calendar state, not a missing BRC row color", () => {
  const company = clone(fixture()[0]);
  company.state = "Non-Compliant";
  company.requirements[1].status = "Missing";
  const variants = [
    ["2027-02-08", [19, 83, 49]], ["2027-02-07", [99, 76, 0]],
    ["2027-01-09", [99, 76, 0]], ["2027-01-08", [120, 55, 0]],
    ["2026-12-10", [120, 55, 0]], ["2026-12-09", [146, 25, 34]],
    ["2026-11-09", [146, 25, 34]], ["2026-11-20", [146, 25, 34]],
    ["2026-11-08", [125, 12, 27]], [null, [73, 91, 115]],
  ];
  for (const [date, textColor] of variants) {
    company.requirements[2].expirationDate = date;
    cells.length = 0;
    complianceReportPdf(input([company]));
    const row = cells.filter(cell => cell.section === "body");
    for (const cell of row.slice(0, 2)) {
      assert.deepEqual(Array.from(cell.fill), [249, 202, 207]);
      assert.deepEqual(Array.from(cell.text), [125, 12, 27]);
    }
    assert.deepEqual(Array.from(row[2].fill), [255, 255, 255]);
    assert.deepEqual(Array.from(row[2].text), textColor);
  }
  company.materialOnly = true;
  assert.deepEqual(Array.from(compliancePdfRow(company, "2026-11-09").expirationText), [73, 91, 115]);
});

test("row colors and ordered status groups preserve every authoritative attention condition", () => {
  const company = clone(fixture()[0]);
  const statuses = ["Missing", "Expired", "0-30 Days", "31-60 Days", "61-90 Days", "Unavailable", "Current"];
  const fills = [];
  statuses.forEach(status => {
    company.state = status === "Current" ? "Fully Compliant" : "Needs Review";
    company.requirements.forEach(row => { row.status = "Current"; });
    company.requirements[2].status = status;
    const result = compliancePdfRow(company, "2026-11-09");
    fills.push(JSON.stringify(result.palette.fill));
    assert.ok(result.status.includes(status === "Unavailable" ? "NEEDS REVIEW: NJ PWC"
      : status === "Current" ? "FULLY COMPLIANT" : `${status.toUpperCase()}: NJ PWC`));
  });
  assert.equal(fills[0], fills[1], "Missing and Expired use strong red tint.");
  assert.equal(new Set(fills).size, 6);
  for (let severe = 0; severe < statuses.length - 1; severe++) {
    company.state = "Non-Compliant";
    company.requirements[0].status = statuses[severe];
    company.requirements[1].status = statuses[severe + 1];
    company.requirements[2].status = "Current";
    const result = compliancePdfRow(company, "2026-11-09");
    assert.equal(JSON.stringify(result.palette.fill), fills[severe]);
    assert.ok(result.status.startsWith(`${statuses[severe] === "Unavailable" ? "NEEDS REVIEW" : statuses[severe].toUpperCase()}: FEIN`));
    assert.ok(result.status.includes("NJ BRC") && result.status.includes("NJ PWC") && result.status.includes("CURRENT:"));
  }
});

test("Material Only is authoritative, neutral and excluded from outcome counts, not population", () => {
  const companies = fixture();
  const material = companies[7];
  const row = compliancePdfRow(material, "2026-11-09");
  assert.equal(row.status, "MATERIAL ONLY");
  assert.equal(row.expiration, "N/A");
  assert.notDeepEqual(row.palette.fill, compliancePdfRow(companies[0], "2026-11-09").palette.fill);
  const summary = compliancePdfSummary(companies);
  assert.equal(summary.materialOnlyCount, 1);
  const expected = complianceSummary(companies.filter(company => !company.materialOnly));
  assert.deepEqual(Array.from(summary.cards, card => card.count), [8, ...Array.from(expected.slice(1), card => card.count)]);
  for (const flag of [false, null, undefined]) {
    const company = clone(material);
    company.materialOnly = flag;
    assert.notEqual(compliancePdfRow(company, "2026-11-09").status, "MATERIAL ONLY");
  }
});

test("expiration annotations reuse shared calendar arithmetic without reclassifying assessed states", () => {
  const company = clone(fixture()[0]);
  for (const [date, text] of [
    ["2026-11-08", "Expired 1 day"], ["2026-11-09", "0 days remaining"],
    ["2026-12-09", "30 days remaining"], ["2026-12-10", "31 days remaining"],
    ["2027-01-08", "60 days remaining"], ["2027-01-09", "61 days remaining"],
    ["2027-02-07", "90 days remaining"], ["2027-02-08", "91 days remaining"],
    ["2028-03-01", "478 days remaining"],
  ]) {
    company.requirements[2].expirationDate = date;
    const row = compliancePdfRow(company, "2026-11-09");
    assert.ok(row.expiration.includes(text), `${date}: ${row.expiration}`);
    assert.equal(row.status, "FULLY COMPLIANT", "Renderer never recalculates authoritative status.");
    assert.ok(!row.status.includes("expires") && !row.status.includes(date));
  }
  company.requirements[0].expirationDate = "2028-01-01";
  company.requirements[1].expirationDate = "2028-01-01";
  for (const date of [null, "2026-02-30", "not-a-date"]) {
    company.requirements[2].expirationDate = date;
    assert.equal(compliancePdfRow(company, "2026-11-09").expiration, "N/A", "No FEIN/BRC fabricated expiration.");
  }
  company.requirements[2].expirationDate = "2027-01-01";
  company.requirements[2].applicable = false;
  assert.equal(compliancePdfRow(company, "2026-11-09").expiration, "N/A");
});

test("Missing groups name requirements; unknown applicability and Needs Review never become fully compliant", () => {
  const company = clone(fixture()[0]);
  company.state = "Non-Compliant";
  company.requirements[0].status = company.requirements[2].status = "Missing";
  assert.ok(compliancePdfRow(company, "2026-11-09").status.startsWith("MISSING: FEIN, NJ PWC | CURRENT: NJ BRC"));
  company.requirements[0].status = company.requirements[2].status = "Current";
  company.requirements[1].status = "Unavailable";
  company.requirements[1].applicable = false;
  assert.ok(compliancePdfRow(company, "2026-11-09").status.startsWith("NEEDS REVIEW: NJ BRC"));
  company.requirements[1].status = "Current";
  company.state = "Needs Review";
  assert.ok(compliancePdfRow(company, "2026-11-09").status.startsWith("NEEDS REVIEW"));
});

test("58 contractors stay intact within letter margins, with repeated column/running headers and page numbers", () => {
  cells.length = 0;
  const companies = fixture(58);
  const document = complianceReportPdf(input(companies));
  assert.ok(document.getNumberOfPages() >= 2 && document.getNumberOfPages() <= 5);
  for (let index = 0; index < companies.length; index++) {
    const row = cells.filter(cell => cell.section === "body" && cell.row === index);
    assert.equal(row.length, 3);
    assert.equal(new Set(row.map(cell => cell.page)).size, 1, "Contractor row never splits.");
    assert.ok(row.every(cell => cell.y >= 19 && cell.y + cell.height <= 201));
    assert.ok(row.every(cell => cell.x >= 9.9 && cell.x + cell.width <= 269.5));
  }
  for (let page = 1; page <= document.getNumberOfPages(); page++) {
    const content = document.internal.pages[page].join("\n");
    assert.ok(content.includes(`Page ${page} of ${document.getNumberOfPages()}`));
    assert.equal((content.match(/SubTracker \/ Compliance Status \/ 21-002 - School/g) ?? []).length, 1);
    assert.equal((content.match(/\(Company Name\) Tj/g) ?? []).length, 1);
    assert.ok(cells.some(cell => cell.page === page && cell.section === "body"));
    if (page > 1) assert.ok(!content.includes("(Contractors)"), "KPIs appear only on first page.");
  }
});

test("filters and All Projects preserve authoritative population without unrelated assignments", () => {
  for (const status of ["Current", "61-90 Days", "31-60 Days", "0-30 Days", "Expired", "Missing"]) {
    const companies = filterComplianceCompanies(fixture(), "", status);
    cells.length = 0;
    complianceReportPdf({ ...input(companies), status });
    assert.equal(cells.filter(cell => cell.section === "body" && cell.column === 0).length, companies.length);
  }
  const companies = fixture();
  companies.forEach(company => company.requirements.forEach(row => { row.projectId = null; }));
  const document = complianceReportPdf({ ...input(companies), scope: { kind: "all" } });
  assert.ok(document.output().includes("SubTracker / Compliance Status / All Projects"));
  assert.ok(!document.output().includes("21-002"));
});

test("scope mismatches, duplicate companies and invalid generated dates fail closed", () => {
  const companies = fixture();
  for (const invalid of [
    { ...input(companies), scope: { kind: "project", project: { ...project, id: 0 } } },
    { ...input(companies), scope: { kind: "all" } },
    input([...companies, companies[0]]),
    input([{ ...companies[0], requirements: companies[0].requirements.slice(1) }]),
    { ...input(companies), generatedAt: new Date("invalid") },
  ]) assert.throws(() => complianceReportPdf(invalid), /invalid|incomplete/);
  assert.ok(complianceReportPdf(input([])).output().includes("Page 1 of 1"));
});

test("long project header wraps safely without repeating a large project block", () => {
  const document = complianceReportPdf({ ...input(fixture(58)), scope: {
    kind: "project", project: { ...project, project_name: "Long school construction project with multiple facilities ".repeat(3) },
  } });
  for (let page = 1; page <= document.getNumberOfPages(); page++) {
    const content = document.internal.pages[page].join("\n");
    assert.equal((content.match(/SubTracker \/ Compliance Status/g) ?? []).length, 1);
    assert.ok(content.includes("Long school"));
  }
});
