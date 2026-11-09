import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import type { AssessmentProject } from "./project-compliance-assessment";
import { finalReportColor, finalReportColumns, finalReportNames, finalReportNotes, followupScopeLimitation,
  type FinalReport, type FinalReportRow } from "./final-reports";

export function finalReportPdf(input: {
  report: FinalReport; rows: FinalReportRow[];
  scope: { kind: "project"; project: AssessmentProject } | { kind: "all" | "unassigned" };
  search: string; status: string; generatedAt?: Date;
}): jsPDF {
  const { report, rows, scope } = input;
  const reportName = finalReportNames[report], columns = finalReportColumns[report];
  const generated = input.generatedAt ?? new Date();
  const blocked = report === "follow-up" && scope.kind !== "all";
  const context = scope.kind === "project" ? `${scope.project.project_number} - ${scope.project.project_name}`
    : scope.kind === "unassigned" ? "Unassigned Contractors" : "All Projects";
  if (!Number.isFinite(generated.getTime()) || new Set(rows.map(row => row.id)).size !== rows.length
    || (scope.kind === "project" && (!Number.isSafeInteger(scope.project.id) || scope.project.id <= 0))
    || (blocked && rows.length > 0)
    || rows.some(row => !Number.isSafeInteger(row.contractorId) || row.contractorId <= 0
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
  write(`Generated ${generated.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`, headerBottom + 4);
  document.setFontSize(8);
  const filters: string[] = document.splitTextToSize(`Status: ${input.status}${input.search.trim() ? ` | Search: ${input.search.trim()}` : ""}`, width);
  write(filters, headerBottom + 8);
  const summaryY = headerBottom + 9 + filters.length * 3.5;
  write(blocked ? "Project-specific Follow-Up unavailable"
    : `${rows.length} ${report === "project-compliance" ? "contractors" : report === "insurance" ? "insurance items" : "follow-ups"}`, summaryY + 4, 9, true);
  document.setFontSize(7.5);
  const note: string[] = document.splitTextToSize(blocked ? followupScopeLimitation : finalReportNotes[report], width);
  write(note, summaryY + 9, 7.5);
  autoTable(document, {
    startY: summaryY + 12 + note.length * 3,
    margin: { left: margin, right: margin, top: headerBottom + 4, bottom: 15 },
    theme: "grid", rowPageBreak: "avoid", showHead: "everyPage", tableWidth: width,
    head: [columns.map(column => column.label)],
    body: rows.map(row => columns.map(column => {
      if (["expirationDate", "followupDate", "lastFollowup"].includes(column.key)) {
        const date = row[column.key];
        if (typeof date !== "string" || !date) return "N/A";
        const [year, month, day] = date.split("-");
        return `${month}/${day}/${year}`;
      }
      if (column.key === "assignedProjects" && scope.kind === "project" && report === "project-compliance") return "Selected project";
      if (column.key === "assignedProjects") return row.assignedProjects || "Unassigned";
      return String(row[column.key] ?? "N/A");
    })),
    styles: { font: "helvetica", fontSize: 9, cellPadding: 2, overflow: "linebreak",
      lineColor: [210, 220, 231], lineWidth: .15, fillColor: [235, 239, 244], textColor: [71, 85, 105] },
    headStyles: { fillColor: [7, 29, 77], textColor: [255, 255, 255], fontStyle: "bold", fontSize: 9.5 },
    columnStyles: Object.fromEntries((report === "project-compliance" ? [.23, .13, .14, .25, .25]
      : report === "insurance" ? [.24, .18, .15, .13, .11, .19] : [.19, .12, .12, .12, .07, .16, .22])
      .map((ratio, index) => [index, { cellWidth: width * ratio, ...(index === 0 ? { fontStyle: "bold" as const } : {}) }])),
    didParseCell: cell => {
      if (cell.section !== "body") return;
      const palette = finalReportColor(rows[cell.row.index].severity ?? rows[cell.row.index].status);
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
    write(`SubTracker | ${reportName} | ${blocked ? "Project attribution unavailable" : "Authorized report population"}`, pageHeight - 8, 7);
    document.text(`Page ${page} of ${pages}`, margin + width, pageHeight - 8, { align: "right" });
  }
  return document;
}
