import * as XLSX from "xlsx";
import { MYCOI_HEADINGS, type PolicyParseResult, type SourceRow } from "@/types/mycoi-import";

export function parseMycoiPolicies(raw: string): PolicyParseResult {
  const result: PolicyParseResult = { raw, policies: [], errors: [] };
  if (!raw.trim()) return result;
  const chunks = raw.split(/,\s*(?=policyNumber:)/);
  chunks.forEach((chunk, index) => {
    const match = /^policyNumber: ([\s\S]*?); expirationDate: ([\s\S]*?); isExpired: (true|false); policyLines: ([\s\S]+)$/.exec(chunk.trim());
    if (!match) {
      result.errors.push(`Policy ${index + 1}: expected policyNumber; expirationDate; isExpired; policyLines in report order.`);
      return;
    }
    const [, number, date, expired, lines] = match;
    const dateMatch = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    const parts = dateMatch ? [Number(dateMatch[3]), Number(dateMatch[1]), Number(dateMatch[2])] : null;
    const parsed = parts ? new Date(Date.UTC(parts[0], parts[1] - 1, parts[2])) : null;
    const lineValues = lines.split(",").map((line) => line.trim());
    const numberWithoutEntities = number.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[a-f\d]+);/gi, "");
    if (!number.trim() || /^(null|undefined)$/i.test(number.trim()) || /[;\r\n]|policyNumber:/.test(numberWithoutEntities)) {
      result.errors.push(`Policy ${index + 1}: missing or ambiguous policy number.`);
    } else if (!parts || !parsed || parsed.getUTCFullYear() !== parts[0] || parsed.getUTCMonth() + 1 !== parts[1] || parsed.getUTCDate() !== parts[2] || parts[0] < 1900 || parts[0] > 9999) {
      result.errors.push(`Policy ${index + 1}: expiration must be a real MM/DD/YYYY date.`);
    } else if (lineValues.some((line) => !line || /[;:[\]{}\r\n"]/.test(line) || /^(null|undefined)$/i.test(line))) {
      result.errors.push(`Policy ${index + 1}: missing or ambiguous policy lines; arrays/JSON and unrecognized fragments require review.`);
    } else {
      result.policies.push({
        policyNumber: number, expirationDate: `${dateMatch![3]}-${dateMatch![1]}-${dateMatch![2]}`,
        isExpired: expired === "true", policyLines: lineValues,
      });
    }
  });
  return result;
}

export function parseMycoiWorkbook(buffer: ArrayBuffer, filename: string): SourceRow[] {
  if (!/\.(xlsx|csv)$/i.test(filename)) throw new Error("Select a .xlsx or .csv myCOI report.");
  const workbook = XLSX.read(buffer, { type: "array", raw: true, cellDates: false });
  if (workbook.SheetNames.length !== 1) throw new Error("The myCOI report must contain exactly one worksheet.");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (sheet["!ref"] && XLSX.utils.decode_range(sheet["!ref"]).e.r > 5000) {
    throw new Error("A myCOI report may contain at most 5,000 source rows.");
  }
  const cells = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "", raw: true, blankrows: true });
  if (!cells.length || cells[0].length !== MYCOI_HEADINGS.length || MYCOI_HEADINGS.some((heading) => cells[0].filter((value) => value === heading).length !== 1)) {
    throw new Error(`Expected exactly these headings, once each: ${MYCOI_HEADINGS.join(", ")}.`);
  }
  if (cells.length > 5001) throw new Error("A myCOI report may contain at most 5,000 source rows.");
  const rows: SourceRow[] = [];
  cells.slice(1).forEach((values, offset) => {
    if (values.every((value) => value === "" || value == null)) return;
    if (values.length > MYCOI_HEADINGS.length && values.slice(MYCOI_HEADINGS.length).some((value) => value !== "" && value != null)) {
      throw new Error(`Row ${offset + 2}: unexpected data beyond the six source columns.`);
    }
    const row: SourceRow = { row: offset + 2, "Division Name": "", "Vendor Name": "", "Vendor Email": "", "Vendor Phone": "", "Compliance Status": "", "Policy Expiration Dates": "" };
    MYCOI_HEADINGS.forEach((heading) => {
      const index = cells[0].indexOf(heading);
      const cell = sheet[XLSX.utils.encode_cell({ r: offset + 1, c: index })];
      if (cell?.f || cell?.t === "e") throw new Error(`Row ${offset + 2}, ${heading}: formula/error cells require a values-only report.`);
      const value = values[index] ?? "";
      if (typeof value !== "string" && value !== "") {
        throw new Error(`Row ${offset + 2}, ${heading}: expected text, not ${typeof value}. Export this field as text to preserve its source value.`);
      }
      row[heading] = String(value);
    });
    rows.push(row);
  });
  if (!rows.length) throw new Error("The report contains no source rows.");
  return rows;
}
