import * as XLSX from "xlsx";
import { COMPANY_CONTACT_COLUMNS, COMPANY_CONTACT_MAX_ROWS, COMPANY_CONTACT_SHEET, type CompanyContactSource } from "@/types/company-contacts-import";

export function companyContactsTemplate(): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet([[...COMPANY_CONTACT_COLUMNS]]);
  sheet["!cols"] = [{ wch: 36 }, { wch: 24 }, { wch: 44 }];
  sheet["!rows"] = [{ hpt: 24 }];
  sheet["!autofilter"] = { ref: "A1:C1" };
  // Text formatting preserves leading zeroes and prevents Excel guessing phone/date types.
  for (const address of ["A1", "B1", "C1"]) sheet[address].z = "@";
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, COMPANY_CONTACT_SHEET);
  return XLSX.write(book, { type: "array", bookType: "xlsx" });
}

export function parseCompanyContactsWorkbook(buffer: ArrayBuffer, filename: string): { rows: CompanyContactSource[]; notices: string[] } {
  if (!/\.xlsx$/i.test(filename)) throw new Error("Choose a Company Contacts .xlsx workbook.");
  if (new Uint8Array(buffer)[0] !== 0x50 || new Uint8Array(buffer)[1] !== 0x4b) throw new Error("The file is not an XLSX workbook.");
  const book = XLSX.read(buffer, { type: "array", cellDates: false });
  const sheetName = book.SheetNames.includes(COMPANY_CONTACT_SHEET) ? COMPANY_CONTACT_SHEET : book.SheetNames[0];
  const sheet = book.Sheets[sheetName];
  if (!sheet || !sheet["!ref"]) throw new Error("The workbook has no readable worksheet.");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  if (range.e.r > COMPANY_CONTACT_MAX_ROWS || range.e.c > 49 || range.s.r !== 0 || range.s.c !== 0) {
    throw new Error(`Use a worksheet beginning at A1 with at most ${COMPANY_CONTACT_MAX_ROWS} data rows and 50 columns.`);
  }
  const cells = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true });
  const headings = cells[0].map((v) => v.trim().toLowerCase());
  for (const heading of COMPANY_CONTACT_COLUMNS) {
    if (headings.filter((v) => v === heading.toLowerCase()).length !== 1) throw new Error(`Expected exactly one ${heading} column. Required headers: ${COMPANY_CONTACT_COLUMNS.join(" | ")}.`);
  }
  const notices: string[] = [];
  if (sheetName !== COMPANY_CONTACT_SHEET) notices.push(`Used first worksheet "${sheetName}" after validating all required headers.`);
  if (book.SheetNames.length > 1) notices.push(`Only "${sheetName}" was read; other worksheets were ignored.`);
  const extras = headings.filter((v) => v && !COMPANY_CONTACT_COLUMNS.some((h) => h.toLowerCase() === v));
  if (extras.length || headings.length > 3) notices.push("Additional columns were ignored; only Name, Cell and Email are imported.");
  const rows: CompanyContactSource[] = [];
  cells.slice(1).forEach((values, index) => {
    if (values.every((v) => !v.trim())) return;
    const original = { Name: "", Cell: "", Email: "" };
    for (const heading of COMPANY_CONTACT_COLUMNS) {
      const col = headings.indexOf(heading.toLowerCase());
      const cell = sheet[XLSX.utils.encode_cell({ r: index + 1, c: col })];
      if (cell?.f || cell?.t === "e") throw new Error(`Row ${index + 2}, ${heading}: use values, not formulas or error cells. Nothing was staged.`);
      original[heading] = values[col] ?? "";
      if (original[heading].length > 2000) throw new Error(`Row ${index + 2}, ${heading}: exceeds 2,000 characters. Nothing was staged.`);
    }
    if (Object.values(original).every((v) => !v.trim())) return;
    rows.push({ source_row: index + 2, original });
  });
  if (!rows.length) throw new Error("The workbook contains no nonblank contact rows.");
  return { rows, notices };
}
