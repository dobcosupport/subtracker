import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { classifyExpiration } from "./expiration-classification";
import { complianceSummary, type AssessmentProject, type ComplianceCompany, type RequirementAssessment } from "./project-compliance-assessment";

type Color = [number, number, number];
type Palette = { fill: Color; text: Color };
const navy: Color = [7, 29, 77];
const muted: Color = [73, 91, 115];
const line: Color = [210, 220, 231];
const colors = {
  Current: { fill: [225, 243, 232], text: [19, 83, 49] },
  "61-90 Days": { fill: [255, 246, 202], text: [99, 76, 0] },
  "31-60 Days": { fill: [255, 232, 201], text: [120, 55, 0] },
  "0-30 Days": { fill: [255, 222, 222], text: [146, 25, 34] },
  Expired: { fill: [249, 202, 207], text: [125, 12, 27] },
  Missing: { fill: [249, 202, 207], text: [125, 12, 27] },
  Unavailable: { fill: [235, 237, 240], text: [64, 74, 88] },
  "Material Only": { fill: [225, 233, 242], text: [48, 69, 94] },
} satisfies Record<string, Palette>;
const priority: RequirementAssessment["status"][] = [
  "Missing", "Expired", "0-30 Days", "31-60 Days", "61-90 Days", "Unavailable", "Current", "Not Required",
];

export type CompliancePdfInput = {
  companies: ComplianceCompany[];
  scope: { kind: "project"; project: AssessmentProject } | { kind: "all" | "unassigned" };
  status: string;
  search: string;
  generatedAt?: Date;
};

export function compliancePdfSummary(companies: ComplianceCompany[]) {
  const outcomes = complianceSummary(companies.filter(company => company.materialOnly !== true));
  return {
    cards: [{ ...outcomes[0], count: companies.length }, ...outcomes.slice(1)],
    materialOnlyCount: companies.filter(company => company.materialOnly === true).length,
  };
}

function validExpiration(value: string | null): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Project assessed states into print cells; only the date annotation uses calendar-day arithmetic.
export function compliancePdfRow(company: ComplianceCompany, effectiveDate: string) {
  if (company.materialOnly === true) {
    return { company: company.name, status: "MATERIAL ONLY", expiration: "N/A", expirationText: muted, palette: colors["Material Only"] };
  }
  const attention = company.requirements.filter(row => row.status !== "Current" && row.status !== "Not Required");
  const fullyCompliant = company.state === "Fully Compliant" && attention.length === 0;
  const groups = priority.flatMap(status => {
    const names = company.requirements.filter(row => row.status === status).map(row => row.requirement);
    return names.length ? [`${status === "Unavailable" ? "NEEDS REVIEW" : status.toUpperCase()}: ${names.join(", ")}`] : [];
  });
  if (company.state === "Needs Review" && !attention.some(row => row.status === "Unavailable")) {
    groups.splice(attention.length ? Math.max(1, groups.length - 1) : 0, 0, "NEEDS REVIEW");
  }
  const mostSevere = priority.find(status => attention.some(row => row.status === status));
  const palette = mostSevere && mostSevere !== "Not Required" ? colors[mostSevere]
    : company.state === "Needs Review" ? colors.Unavailable : colors.Current;
  const expirations = company.requirements
    .flatMap(row => {
      if (row.requirement !== "NJ PWC" || !row.applicable || !validExpiration(row.expirationDate)) return [];
      const date = row.expirationDate;
      const { daysRemaining, status } = classifyExpiration(date, effectiveDate);
      const [year, month, day] = date.split("-");
      const unit = Math.abs(daysRemaining) === 1 ? "day" : "days";
      return [{ date, status, label: `${row.requirement} ${month}/${day}/${year} \u00b7 ${daysRemaining < 0
        ? `Expired ${Math.abs(daysRemaining)} ${unit}` : `${daysRemaining} ${unit} remaining`}` }];
    }).sort((a, b) => a.date.localeCompare(b.date));
  return {
    company: company.name,
    status: fullyCompliant ? "FULLY COMPLIANT" : groups.join(" | "),
    expiration: expirations.map(row => row.label).join("\n") || "N/A",
    expirationText: expirations.length ? colors[expirations[0].status].text : muted,
    palette,
  };
}

export function complianceReportPdf(input: CompliancePdfInput): jsPDF {
  const { companies, scope } = input;
  const projectId = scope.kind === "project" ? scope.project.id : null;
  if ((scope.kind === "project" && (!Number.isSafeInteger(projectId) || (projectId ?? 0) <= 0))
    || new Set(companies.map(company => company.id)).size !== companies.length
    || companies.some(company => !Number.isSafeInteger(company.id) || company.id <= 0
      || company.requirements.length !== 3
      || new Set(company.requirements.map(row => row.requirement)).size !== 3
      || company.requirements.some(row => row.contractorId !== company.id || row.projectId !== projectId))) {
    throw new Error("Compliance PDF scope is invalid or incomplete. Reload Reports; no broader scope was substituted.");
  }
  const generated = input.generatedAt ?? new Date();
  if (!Number.isFinite(generated.getTime())) throw new Error("Compliance PDF generated date is invalid.");
  const effectiveDate = generated.toISOString().slice(0, 10);
  const rows = companies.map(company => compliancePdfRow(company, effectiveDate));
  const document = new jsPDF({ orientation: "landscape", format: "letter" });
  document.setProperties({ title: "SubTracker - Compliance Status", subject: "FEIN, NJ BRC and NJ PWC assessment", creator: "SubTracker" });
  const margin = 10;
  const pageWidth = document.internal.pageSize.getWidth(), pageHeight = document.internal.pageSize.getHeight();
  const width = pageWidth - margin * 2;
  const write = (value: string | string[], x: number, y: number, size = 9, color = navy, bold = false) => {
    document.setFont("helvetica", bold ? "bold" : "normal");
    document.setFontSize(size);
    document.setTextColor(...color);
    document.text(value, x, y);
  };
  const context = scope.kind === "project" ? `${scope.project.project_number} - ${scope.project.project_name}`
    : scope.kind === "unassigned" ? "Unassigned Contractors" : "All Projects";
  document.setFont("helvetica", "bold");
  document.setFontSize(10);
  const runningLines: string[] = document.splitTextToSize(`SubTracker / Compliance Status / ${context}`, width);
  const headerBottom = 11 + runningLines.length * 4;
  write(`Generated ${generated.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    margin, headerBottom + 4, 8, muted);
  document.setFontSize(8);
  const filters: string[] = document.splitTextToSize(`Status: ${input.status}${input.search.trim() ? ` | Search: ${input.search.trim()}` : ""}`, width);
  write(filters, margin, headerBottom + 8, 8, muted);
  let y = headerBottom + 11 + filters.length * 3.5;
  const { cards: summary, materialOnlyCount } = compliancePdfSummary(companies);
  const cardWidth = (width - 8) / 5;
  const accents = [navy, colors.Current.text, colors["31-60 Days"].text, colors.Expired.text, colors.Missing.text];
  summary.forEach((card, index) => {
    const x = margin + index * (cardWidth + 2);
    document.setFillColor(248, 250, 253);
    document.setDrawColor(...line);
    document.roundedRect(x, y, cardWidth, 18, 1, 1, "FD");
    write(String(card.count), x + 2, y + 6, 13, accents[index], true);
    document.setFontSize(8);
    write(document.splitTextToSize(card.label.replace("\u2264", "<="), cardWidth - 4), x + 2, y + 10, 8);
    if (index > 0) write(`${companies.length ? (card.count / companies.length * 100).toFixed(1) : "0.0"}%`, x + 2, y + 16, 7, muted);
  });
  y += 22;
  document.setFontSize(7.5);
  const notes: string[] = document.splitTextToSize(
    `Material Only: ${materialOnlyCount}, included in total; excluded from outcome KPIs. Percentages use all contractors; issue categories may overlap.\nFEIN, NJ BRC and NJ PWC only. NJ BRC is non-expiring. N/A = no applicable expiration. Unavailable requires review.`, width);
  write(notes, margin, y, 7.5, muted);
  y += notes.length * 3.2 + 3;
  autoTable(document, {
    startY: y, theme: "grid", rowPageBreak: "avoid", showHead: "everyPage",
    margin: { left: margin, right: margin, top: headerBottom + 4, bottom: 15 },
    tableWidth: width,
    styles: { font: "helvetica", fontSize: 9, cellPadding: { top: 2, bottom: 2, left: 2, right: 2 },
      textColor: navy, lineColor: line, lineWidth: .15, overflow: "linebreak" },
    headStyles: { fillColor: navy, textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9.5 },
    columnStyles: { 0: { cellWidth: width * .34, fontStyle: "bold" }, 1: { cellWidth: width * .41 }, 2: { cellWidth: width * .25 } },
    head: [["Company Name", "Status", "Expiration Date"]],
    body: rows.map(row => [row.company, row.status, row.expiration]),
    didParseCell: cell => {
      if (cell.section !== "body") return;
      const palette = rows[cell.row.index].palette;
      cell.cell.styles.fillColor = cell.column.index === 2 ? [255, 255, 255] : palette.fill;
      cell.cell.styles.textColor = cell.column.index === 2 ? rows[cell.row.index].expirationText : palette.text;
    },
  });
  const pages = document.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    document.setPage(page);
    write(runningLines, margin, 11, 10, navy, true);
    document.setDrawColor(...line);
    document.line(margin, headerBottom, margin + width, headerBottom);
    document.line(margin, pageHeight - 12, margin + width, pageHeight - 12);
    write("SubTracker | FEIN / NJ BRC / NJ PWC | Authorized report population", margin, pageHeight - 8, 7, muted);
    document.text(`Page ${page} of ${pages}`, margin + width, pageHeight - 8, { align: "right" });
  }
  return document;
}
