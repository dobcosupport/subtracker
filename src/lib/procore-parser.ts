import * as XLSX from "xlsx";
import { PROCORE_HEADINGS, type ProcoreRow } from "@/types/procore-import";

export function parseProcoreWorkbook(buffer: ArrayBuffer, filename: string): ProcoreRow[] {
  if (!/\.(xlsx|csv)$/i.test(filename)) throw new Error("Select a Procore .xlsx or .csv report.");
  const book = XLSX.read(buffer, { type: "array", cellDates: false });
  if (book.SheetNames.length !== 1) throw new Error("The Procore report must contain exactly one worksheet.");
  const sheet = book.Sheets[book.SheetNames[0]];
  const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
  if (!range || range.e.r > 20001 || range.e.c > 50) throw new Error("Use a report with at most 20,000 source rows and 51 columns.");
  const cells = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, defval: "", raw: false, blankrows: true });
  let headings = cells[0].map((v) => v.trim());
  let headerRows = 1;
  if (!headings.includes(PROCORE_HEADINGS[0]) && cells.length > 1) {
    let group = "";
    headings = cells[1].map((field, index) => {
      if (cells[0][index]?.trim()) group = cells[0][index].trim();
      return `${group} > ${field.trim()}`;
    });
    headerRows = 2;
  }
  if (headings.length !== PROCORE_HEADINGS.length || PROCORE_HEADINGS.some((h) => headings.filter((v) => v === h).length !== 1)) {
    throw new Error(`Expected each Procore heading once: ${PROCORE_HEADINGS.join(", ")}. Flattened or two-row grouped headings are supported.`);
  }
  const result: ProcoreRow[] = [];
  cells.slice(headerRows).forEach((values, index) => {
    if (values.every((v) => !v.trim())) return;
    if (values.slice(headings.length).some((v) => v.trim())) throw new Error(`Row ${index + headerRows + 1}: unexpected extra columns.`);
    const row: ProcoreRow = { row: index + headerRows + 1,
      "Company (Vendor) > Name": "", "Company (Vendor) > Business Phone": "", "Company (Vendor) > Address": "",
      "Company (Vendor) > City": "", "Company (Vendor) > State": "", "Company (Vendor) > Zip": "",
      "Project > Number": "", "User > Full Name": "", "User > Email Address": "", "User > Business Phone": "", "User > Cell Phone": "" };
    PROCORE_HEADINGS.forEach((heading) => {
      const col = headings.indexOf(heading);
      const cell = sheet[XLSX.utils.encode_cell({ r: index + headerRows, c: col })];
      if (cell?.f || cell?.t === "e") throw new Error(`Row ${row.row}, ${heading}: use values-only cells, not formulas/errors.`);
      const value = (values[col] ?? "").trim();
      if (value.length > 2000) throw new Error(`Row ${row.row}, ${heading}: value exceeds 2,000 characters.`);
      row[heading] = value;
    });
    result.push(row);
  });
  if (!result.length || result.length > 20000) throw new Error("The report must contain 1–20,000 nonblank source rows.");
  return result;
}
