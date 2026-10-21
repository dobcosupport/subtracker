/* eslint-disable @typescript-eslint/no-require-imports -- This standalone generator uses CommonJS. */
const path = require("path");
const XLSX = require("xlsx");
const { unzipSync, zipSync } = require("fflate");

const workbook = XLSX.utils.book_new();

const sheets = {
  Instructions: [
    ["SubTracker Import Template"],
    ["Fill out each worksheet using the exact column headers provided."],
    ["Supported worksheets: Projects, Contractors, Project Assignments, Compliance Records, Tiered Subs, Follow-Ups."],
    ["Manual Insurance and Certificate Of Insurance tracking are retired. Use the reviewed myCOI workflow for insurance."],
    ["Project Assignments controls MANUAL ownership only; it cannot remove MYCOI ownership."],
    ["Yes/No columns accept Yes or No."],
    ["Date columns accept Excel dates (MM/DD/YYYY)."],
    ["Taxpayer ID (FEIN) is optional and stored as text; enter 001234567 or 12-3456789. Do not append zeros."],
  ],
  Projects: [["Project Number", "Project Name", "Status"]],
  Contractors: [
    [
      "Company Name*",
      "Trade",
      "Contact Name",
      "Email",
      "Phone",
      "Address 1",
      "Address 2",
      "City",
      "State",
      "Zip Code",
      "NJ PWC #",
      "NJ BRC #",
      "BRC Name Control",
      "Taxpayer ID (FEIN)",
      "Sage ERP ID",
      "Notes",
      "External ID",
      "Legacy ID",
      "Active*",
    ],
  ],
  "Project Assignments": [["Company Name", "Project Number", "Assigned Date", "Active"]],
  "Compliance Records": [
    [
      "Company Name",
      "Compliance Type",
      "Registration Number",
      "Effective Date",
      "Expiration Date",
      "Verified Date",
      "Verified By",
      "Verification Source",
      "Notes",
      "Active",
      "Current",
    ],
  ],
  "Tiered Subs": [["Parent Company Name", "Tiered Sub Company Name", "Assigned Date", "Active"]],
  "Follow-Ups": [
    ["Company Name", "Follow-Up Date", "Method", "Status", "Related Compliance Type", "Subject", "Notes"],
  ],
  _Lists: [
    ["Project Status", "Compliance Type", "Follow-Up Method", "Follow-Up Status"],
    ["Active", "NJ PWC", "Phone", "Open"],
    ["Pending", "NJ BRC", "Email", "Waiting Response"],
    ["Completed", "NY PWC", "Meeting", "Resolved"],
    ["On Hold", "NY BRC", "Text", "Closed"],
    ["Cancelled", "W9", "Other", ""],
    ["", "Safety Certification", "", ""],
  ],
};

for (const [name, rows] of Object.entries(sheets)) {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (name === "Contractors") {
    const taxpayerIdColumn = rows[0].indexOf("Taxpayer ID (FEIN)");
    const taxpayerIdCell = XLSX.utils.encode_cell({ r: 0, c: taxpayerIdColumn });
    sheet[taxpayerIdCell].z = "@";
  }
  XLSX.utils.book_append_sheet(workbook, sheet, name);
}

const outputPath = path.join(__dirname, "..", "public", "SubTracker_Import_Template.xlsx");
XLSX.writeFile(workbook, outputPath, { cellStyles: true });

const archive = unzipSync(new Uint8Array(require("fs").readFileSync(outputPath)));
const workbookXml = Buffer.from(archive["xl/workbook.xml"]).toString("utf8");
const relationshipsXml = Buffer.from(archive["xl/_rels/workbook.xml.rels"]).toString("utf8");
const contractorSheetTag = workbookXml.match(/<sheet\b(?=[^>]*\bname="Contractors")[^>]*\/>/)?.[0];
const relationshipId = contractorSheetTag?.match(/\br:id="([^"]+)"/)?.[1];
const target = relationshipId
  ? relationshipsXml.match(new RegExp(`<Relationship\\b(?=[^>]*\\bId="${relationshipId}")[^>]*\\bTarget="([^"]+)"[^>]*/>`))?.[1]
  : null;
if (!target) throw new Error("Unable to locate the Contractors worksheet in the generated template.");

const worksheetPath = path.posix.normalize(path.posix.join("xl", target));
const worksheetXml = Buffer.from(archive[worksheetPath]).toString("utf8");
const styleSheetXml = Buffer.from(archive["xl/styles.xml"]).toString("utf8");
const cellXfsXml = styleSheetXml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1];
const textStyleIndex = cellXfsXml ? [...cellXfsXml.matchAll(/<xf\b[^>]*>/g)]
  .findIndex((match) => /\bnumFmtId="49"/.test(match[0]) && /\bapplyNumberFormat="1"/.test(match[0]))
  : -1;
if (textStyleIndex < 0) throw new Error("Unable to locate the Excel Text number format in the generated template.");

const taxpayerIdColumnNumber = sheets.Contractors[0].indexOf("Taxpayer ID (FEIN)") + 1;
const textColumn = `<col min="${taxpayerIdColumnNumber}" max="${taxpayerIdColumnNumber}" width="22" style="${textStyleIndex}" customWidth="1"/>`;
const styledWorksheetXml = worksheetXml.includes("<cols>")
  ? worksheetXml.replace("</cols>", `${textColumn}</cols>`)
  : worksheetXml.replace("<sheetData>", `<cols>${textColumn}</cols><sheetData>`);
if (styledWorksheetXml === worksheetXml) throw new Error("Unable to apply the whole-column Text format.");
archive[worksheetPath] = new TextEncoder().encode(styledWorksheetXml);
require("fs").writeFileSync(outputPath, zipSync(archive));
console.log(`Template written to ${outputPath}`);
