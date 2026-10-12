import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as XLSX from "xlsx";
import { unzipSync } from "fflate";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
function load(relative, supabase = {}) {
  const filename = path.join(root, relative);
  const loaded = { exports: {} };
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, {
    module: loaded, exports: loaded.exports, Blob,
    require: (name) => name === "@/lib/supabase" ? { supabase }
      : name === "@/lib/contractor-matching" ? load("src\\lib\\contractor-matching.ts")
      : name === "@/services/compliance" ? load("services\\compliance.ts")
      : require(name),
  }, { filename });
  return loaded.exports;
}
const reference = () => ({
  contractorsByExternalId: new Map(), contractorsByName: new Map(),
  ambiguousContractorNames: new Map(), contractorsByNjPwcNumber: new Map(),
  projectsByNumber: new Map(), complianceTypesByName: new Map(),
  complianceRecordKeys: new Set(), activeAssignmentKeys: new Set(),
  inactiveAssignmentKeys: new Map(), contractorsWithInsurance: new Set(),
  activeTieredSubKeys: new Set(), inactiveTieredSubKeys: new Map(),
});
test("import preserves distinct identifiers and blank/absent FEIN semantics", () => {
  const importer = load("services\\imports.ts");
  const row = { "Company Name": "Synthetic Contractor", Active: "Yes", "NJ BRC #": "0001234567", "BRC Name Control": "SYNT" };
  const preview = (raw) => importer.buildPreview("test.xlsx", { Contractors: [raw] }, reference()).rowsBySheet.Contractors[0];
  const populated = preview({ ...row, "Taxpayer ID (FEIN)": " 01-2345678 " });
  assert.equal(populated.action, "Create");
  assert.equal(populated.data.federal_tax_id, "01-2345678");
  assert.equal(populated.data.nj_brc_number, "0001234567");
  assert.equal(populated.data.brc_name_control, "SYNT");
  assert.equal(Object.hasOwn(preview({ ...row, "Taxpayer ID (FEIN)": "" }).data, "federal_tax_id"), false);
  assert.equal(Object.hasOwn(preview(row).data, "federal_tax_id"), false);
});
test("downloadable template includes optional FEIN header as whole-column Text and round-trips imports", async () => {
  const buffer = fs.readFileSync(path.join(root, "public", "SubTracker_Import_Template.xlsx"));
  const workbook = XLSX.read(buffer, { type: "buffer", cellStyles: true, cellNF: true });
  const headers = XLSX.utils.sheet_to_json(workbook.Sheets.Contractors, { header: 1 })[0];
  const njBrcIndex = headers.indexOf("NJ BRC #");
  assert.deepEqual(headers.slice(njBrcIndex, njBrcIndex + 4), [
    "NJ BRC #", "BRC Name Control", "Taxpayer ID (FEIN)", "Sage ERP ID",
  ]);
  const feinColumn = njBrcIndex + 2;
  const feinCell = XLSX.utils.encode_cell({ r: 0, c: feinColumn });
  assert.equal(workbook.Sheets.Contractors[feinCell].z, "@");

  const archive = unzipSync(new Uint8Array(buffer));
  const workbookXml = Buffer.from(archive["xl/workbook.xml"]).toString();
  const relsXml = Buffer.from(archive["xl/_rels/workbook.xml.rels"]).toString();
  const sheetTag = workbookXml.match(/<sheet\b(?=[^>]*\bname="Contractors")[^>]*\/>/)[0];
  const relationshipId = sheetTag.match(/\br:id="([^"]+)"/)[1];
  const target = relsXml.match(new RegExp(`<Relationship\\b(?=[^>]*\\bId="${relationshipId}")[^>]*\\bTarget="([^"]+)"[^>]*/>`))[1];
  const worksheetXml = Buffer.from(archive[path.posix.normalize(path.posix.join("xl", target))]).toString();
  const column = feinColumn + 1;
  assert.match(worksheetXml, new RegExp(`<col min="${column}" max="${column}"[^>]*style="1"[^>]*/>`));
  const stylesXml = Buffer.from(archive["xl/styles.xml"]).toString();
  const cellStyles = stylesXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)[1];
  const textStyle = [...cellStyles.matchAll(/<xf\b[^>]*>/g)][1][0];
  assert.match(textStyle, /\bnumFmtId="49"/);

  const populatedSheet = workbook.Sheets.Contractors;
  const record = {
    "Company Name*": "Synthetic Contractor", "Active*": "Yes", "NJ BRC #": "0001234567",
    "BRC Name Control": "SYNT", "Taxpayer ID (FEIN)": "001234567", "Sage ERP ID": "SAGE-7",
  };
  for (const [rowIndex, fein] of [[1, "001234567"], [2, "12-3456789"]]) {
    for (const [header, value] of Object.entries({ ...record, "Taxpayer ID (FEIN)": fein })) {
      const col = headers.indexOf(header);
      populatedSheet[`${XLSX.utils.encode_col(col)}${rowIndex + 1}`] = {
        t: "s", v: value, ...(header === "Taxpayer ID (FEIN)" ? { z: "@" } : {}),
      };
    }
  }
  populatedSheet["!ref"] = `A1:${XLSX.utils.encode_col(headers.length - 1)}3`;
  const roundTrip = XLSX.read(XLSX.write(workbook, { type: "buffer", cellStyles: true }), {
    type: "buffer", cellStyles: true, cellNF: true,
  });
  const reopenedSheet = roundTrip.Sheets.Contractors;
  assert.equal(reopenedSheet[`${XLSX.utils.encode_col(feinColumn)}2`].v, "001234567");
  assert.equal(reopenedSheet[`${XLSX.utils.encode_col(feinColumn)}2`].t, "s");
  assert.equal(reopenedSheet[`${XLSX.utils.encode_col(feinColumn)}3`].v, "12-3456789");

  const importer = load("services\\imports.ts");
  const parsed = await importer.parseWorkbookFile({
    arrayBuffer: async () => {
      const saved = XLSX.write(roundTrip, { type: "buffer" });
      return saved.buffer.slice(saved.byteOffset, saved.byteOffset + saved.byteLength);
    },
  });
  const row = importer.buildPreview("roundtrip.xlsx", parsed, reference()).rowsBySheet.Contractors[0];
  assert.equal(row.data.federal_tax_id, "001234567");
  assert.equal(importer.buildPreview("roundtrip.xlsx", parsed, reference()).rowsBySheet.Contractors[1].data.federal_tax_id, "12-3456789");
  assert.equal(row.data.nj_brc_number, "0001234567");
  assert.equal(row.data.brc_name_control, "SYNT");
  assert.equal(row.data.sage_erp_id, "SAGE-7");
});

test("FEIN imports populated values but omitted or blank cells preserve existing values on update", async () => {
  const existing = { id: 7, company_name: "Synthetic Contractor", external_id: null, nj_pwc_number: "PWC-7",
    brc_name_control_is_manual: true, federal_tax_id: "55-5555555", nj_brc_number: "0001234567",
    brc_name_control: "SYNT", sage_erp_id: "SAGE-7" };
  const updates = [];
  const supabase = { from(table) {
    const query = {
      select() { return this; },
      eq() { return this; },
      update(payload) { updates.push(payload); return this; },
      then(resolve, reject) {
        return Promise.resolve({ data: table === "contractors" ? [existing] : [], error: null }).then(resolve, reject);
      },
    };
    return query;
  } };
  const importer = load("services\\imports.ts", supabase);
  const referenceData = reference();
  referenceData.contractorsByName.set("synthetic contractor", existing);
  const base = { "Company Name": existing.company_name, Active: "Yes", "NJ BRC #": existing.nj_brc_number,
    "BRC Name Control": existing.brc_name_control, "Sage ERP ID": existing.sage_erp_id };
  const previewFor = (row) => importer.buildPreview("test.xlsx", { Contractors: [row] }, referenceData);

  for (const row of [base, { ...base, "Taxpayer ID (FEIN)": "" }]) {
    const result = await importer.runImport(previewFor(row));
    assert.equal(result.updated, 1);
    assert.equal(Object.hasOwn(updates.at(-1), "federal_tax_id"), false);
    assert.equal(updates.at(-1).nj_brc_number, existing.nj_brc_number);
    assert.equal(updates.at(-1).brc_name_control, existing.brc_name_control);
    assert.equal(updates.at(-1).sage_erp_id, existing.sage_erp_id);
  }
  for (const fein of ["001234567", "12-3456789"]) {
    const result = await importer.runImport(previewFor({ ...base, "Taxpayer ID (FEIN)": fein }));
    assert.equal(result.updated, 1);
    assert.equal(updates.at(-1).federal_tax_id, fein);
    assert.equal(updates.at(-1).nj_brc_number, existing.nj_brc_number);
    assert.equal(updates.at(-1).brc_name_control, existing.brc_name_control);
    assert.equal(updates.at(-1).sage_erp_id, existing.sage_erp_id);
  }
  assert.equal(Object.hasOwn(previewFor(base).rowsBySheet.Contractors[0].data, "federal_tax_id"), false,
    "older workbook without the optional header omits the FEIN update");
});
test("master and custom exports preserve FEIN text separately", async () => {
  const contractor = { id: 1, company_name: "Synthetic", active: true, federal_tax_id: "01-2345678", nj_brc_number: "0001234567", brc_name_control: "SYNT" };
  const supabase = { from(table) {
    const query = { select() { return this; }, order() { return this; }, in() { return this; }, eq() { return this; },
      then(resolve) { return Promise.resolve({ data: table === "contractors" ? [contractor] : [], error: null }).then(resolve); } };
    return query;
  } };
  const master = await load("services\\exports.ts", supabase).fetchContractorMasterExport("all");
  assert.equal(master.error, null);
  assert.equal(master.rows[0]["Taxpayer ID (FEIN)"], "01-2345678");
  assert.equal(master.rows[0]["NJ BRC #"], "0001234567");
  const exporter = load("src\\lib\\custom-export.ts");
  assert.equal(exporter.EXPORT_FIELDS.find((field) => field.id === "federal_tax_id").defaultSelected, undefined);
  const data = { contractors: [contractor], compliance: [], insurance: [], assignments: [], tieredSubs: [], followups: [] };
  const rows = exporter.buildCustomExportRows(data, ["federal_tax_id"]);
  assert.equal(rows[0]["Taxpayer ID (FEIN)"], "01-2345678");
});
test("contractor creation and both forms wire FEIN without changing matching/calculations", () => {
  const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
  assert.match(read("src\\app\\api\\contractors\\route.ts"), /"federal_tax_id"/);
  for (const relative of ["src\\app\\contractors\\page.tsx", "src\\app\\contractors\\[id]\\page.tsx"]) {
    const source = read(relative);
    assert.match(source, /federal_tax_id: contractor\.federal_tax_id \?\? ""/);
    assert.match(source, /federal_tax_id: form\.federal_tax_id\.trim\(\) \|\| null/);
    assert.match(source, /label="Taxpayer ID \(FEIN\)"|aria-label="Taxpayer ID \(FEIN\)"/);
  }
  for (const relative of ["src\\lib\\contractor-matching.ts", "services\\compliance.ts", "src\\lib\\server-nj-brc.ts"]) {
    assert.doesNotMatch(read(relative), /federal_tax_id/);
  }
});

test("isolated migration preserves old records and existing audit captures FEIN changes", async () => {
  const { PGlite } = require(process.env.PGLITE_MODULE || "@electric-sql/pglite");
  const db = await PGlite.create();
  try {
    await db.exec(`
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql AS
      $$ SELECT '00000000-0000-0000-0000-000000000001'::uuid $$;
      CREATE TABLE public.user_profiles(auth_user_id UUID, name TEXT, email TEXT);
      CREATE TABLE public.administration_audit_log(user_id UUID, user_name TEXT,
        user_email TEXT, action TEXT, object_type TEXT, object_id TEXT, object_label TEXT, details JSONB);
      CREATE TABLE public.contractors(id INTEGER PRIMARY KEY, company_name TEXT,
        nj_brc_number TEXT, brc_name_control TEXT);
      INSERT INTO public.contractors VALUES (1, 'Synthetic', '0001234567', 'SYNT');
    `);
    const auditSql = fs.readFileSync(path.join(root, "supabase", "20260929_user_management.sql"), "utf8");
    const auditFunction = auditSql.match(/CREATE OR REPLACE FUNCTION public\.audit_application_change\(\)[\s\S]*?\$\$;/)[0];
    await db.exec(auditFunction);
    await db.exec("CREATE TRIGGER audit_contractors_changes AFTER INSERT OR UPDATE OR DELETE ON public.contractors FOR EACH ROW EXECUTE FUNCTION public.audit_application_change();");
    await db.exec(fs.readFileSync(path.join(root, "supabase", "20261009_contractor_federal_tax_id.sql"), "utf8"));
    assert.equal((await db.query("SELECT federal_tax_id FROM public.contractors")).rows[0].federal_tax_id, null);
    assert.equal((await db.query("SELECT count(*)::integer AS count FROM public.administration_audit_log")).rows[0].count, 0);
    await db.exec("UPDATE public.contractors SET federal_tax_id='01-2345678' WHERE id=1;");
    const record = (await db.query("SELECT * FROM public.contractors")).rows[0];
    assert.equal(record.federal_tax_id, "01-2345678");
    assert.equal(record.nj_brc_number, "0001234567");
    assert.equal(record.brc_name_control, "SYNT");
    const audit = (await db.query("SELECT details FROM public.administration_audit_log")).rows[0];
    assert.deepEqual(audit.details.changed_fields, ["federal_tax_id"]);
    await db.exec("UPDATE public.contractors SET federal_tax_id=NULL WHERE id=1;");
    assert.equal((await db.query("SELECT federal_tax_id FROM public.contractors")).rows[0].federal_tax_id, null);
  } finally { await db.close(); }
});
