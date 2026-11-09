import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { AssessmentProject } from "./project-compliance-assessment";
import { itemReportColor, itemReportColumns, itemReportNames, upcomingStatuses, type ItemReport } from "./item-reports";

export type ItemReportRow = {
  id: string;
  contractorId: number;
  companyName: string;
  item: string;
  status: string;
  assignedProjects: string;
  expirationDate: string | null;
  daysRemaining: number | null;
};

export function itemReportPdf(input: {
  report: ItemReport;
  rows: ItemReportRow[];
  scope: { kind: "project"; project: AssessmentProject } | { kind: "all" | "unassigned" };
  search: string;
  status: string;
  generatedAt?: Date;
}): jsPDF {
  const { rows, scope, report } = input;
  const reportName = itemReportNames[report], columns = itemReportColumns[report];
  const generated = input.generatedAt ?? new Date();
  const context = scope.kind === "project" ? `${scope.project.project_number} - ${scope.project.project_name}`
    : scope.kind === "unassigned" ? "Unassigned Contractors" : "All Projects";
  if (!Number.isFinite(generated.getTime())
    || (scope.kind === "project" && (!Number.isSafeInteger(scope.project.id) || scope.project.id <= 0))
    || new Set(rows.map(row => row.id)).size !== rows.length
    || rows.some(row => !Number.isSafeInteger(row.contractorId) || row.contractorId <= 0
      || (report === "missing-information" ? row.status !== "Missing Information"
        : report === "expired-items" ? row.status !== "Expired" : !upcomingStatuses.includes(row.status))
      || (scope.kind === "project" && row.assignedProjects !== context))) {
    throw new Error(`${reportName} PDF scope or rows are invalid. Reload Reports; no broader scope was substituted.`);
  }
  const document = new jsPDF({ orientation: "landscape", format: "letter" });
  document.setProperties({ title: `SubTracker - ${reportName}`, creator: "SubTracker" });
  const margin = 10, width = document.internal.pageSize.getWidth() - margin * 2;
  const pageHeight = document.internal.pageSize.getHeight();
  const write = (value: string | string[], y: number, size = 8, bold = false) => {
    document.setFont("helvetica", bold ? "bold" : "normal");
    document.setFontSize(size);
    document.setTextColor(7, 29, 77);
    document.text(value, margin, y);
  };
  document.setFont("helvetica", "bold");
  document.setFontSize(10);
  const header: string[] = document.splitTextToSize(`SubTracker / ${reportName} / ${context}`, width);
  const headerBottom = 11 + header.length * 4;
  write(`Generated ${generated.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`,
    headerBottom + 4);
  document.setFontSize(8);
  const filters: string[] = document.splitTextToSize(
    `Status: ${input.status}${input.search.trim() ? ` | Search: ${input.search.trim()}` : ""}`, width);
  write(filters, headerBottom + 8);
  const summaryY = headerBottom + 9 + filters.length * 3.5;
  write(`${rows.length} ${report === "missing-information" ? "missing" : report === "expired-items" ? "expired" : "expiring"} items | ${new Set(rows.map(row => row.contractorId)).size} contractors`, summaryY + 4, 9, true);
  document.setFontSize(7.5);
  const note: string[] = document.splitTextToSize(
    report === "missing-information"
      ? "Missing data from current report sources. Insurance entries indicate absent MyCOI coverage data, not a selected-project insurance requirement."
      : "Dates and days remaining use the shared calendar-day classifier. Insurance entries are MyCOI coverage observations, not project requirements.", width);
  write(note, summaryY + 9, 7.5);
  autoTable(document, {
    startY: summaryY + 12 + note.length * 3,
    margin: { left: margin, right: margin, top: headerBottom + 4, bottom: 15 },
    theme: "grid", rowPageBreak: "avoid", showHead: "everyPage", tableWidth: width,
    head: [columns.map(column => column.label)],
    body: rows.map(row => columns.map(column => {
      if (column.key === "expirationDate") {
        if (!row.expirationDate) return "N/A";
        const [year, month, day] = row.expirationDate.split("-");
        return `${month}/${day}/${year}`;
      }
      if (column.key === "assignedProjects") return row.assignedProjects || "Unassigned";
      return String(row[column.key] ?? "N/A");
    })),
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2, overflow: "linebreak",
      lineColor: [210, 220, 231], lineWidth: .15, fillColor: [249, 202, 207], textColor: [125, 12, 27] },
    headStyles: { fillColor: [7, 29, 77], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9.5 },
    columnStyles: Object.fromEntries((report === "missing-information" ? [.30, .23, .20, .27]
      : report === "expired-items" ? [.27, .21, .14, .12, .26] : [.24, .18, .13, .11, .15, .19])
      .map((ratio, index) => [index, { cellWidth: width * ratio, ...(index === 0 ? { fontStyle: "bold" as const } : {}) }])),
    didParseCell: cell => {
      if (cell.section !== "body") return;
      const palette = itemReportColor(rows[cell.row.index].status);
      cell.cell.styles.fillColor = palette.fill;
      cell.cell.styles.textColor = palette.text;
    },
  });
  const pages = document.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    document.setPage(page);
    write(header, 11, 10, true);
    document.setDrawColor(210, 220, 231);
    document.line(margin, headerBottom, margin + width, headerBottom);
    document.line(margin, pageHeight - 12, margin + width, pageHeight - 12);
    write(`SubTracker | ${reportName} | Authorized report population`, pageHeight - 8, 7);
    document.text(`Page ${page} of ${pages}`, margin + width, pageHeight - 8, { align: "right" });
  }
  return document;
}
