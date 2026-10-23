import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { supabase } from "@/lib/supabase";
import { calculateComplianceStatus } from "@/services/compliance";
import type { ProjectAssignmentHistoryEntry } from "@/services/projects";
import type { ComplianceRecord, Project } from "@/types/database";

export type ProjectExportRow = Record<string, string>;
export interface ProjectExportSection { name: string; columns: string[]; rows: ProjectExportRow[] }
interface ExportCompliance extends Pick<ComplianceRecord, "id" | "contractor_id" | "registration_number" | "expiration_date" | "created_at"> {
  registry_status: string | null;
  compliance_types: { compliance_name: string; requires_expiration: boolean } | null;
}

async function allPages<T>(load: (start: number, end: number) => PromiseLike<{
  data: T[] | null; error: { message: string } | null;
}>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await load(start, start + 499);
    if (error) throw new Error(`Project export: ${error.message}`);
    if (!data) throw new Error("Project export returned no valid data.");
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

function dateTime(value: string | null): string {
  if (!value) return "\u2014";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

export async function loadProjectExport(projectId: number): Promise<ProjectExportSection[]> {
  const { data: project, error } = await supabase.from("projects").select("*").eq("id", projectId).single<Project>();
  if (error || !project) throw new Error(`Project export: ${error?.message ?? "Project not found."}`);
  const assignments = await allPages((start, end) => supabase.from("contractor_projects")
    .select("id, contractor_id, project_id, assigned_date, removed_date, active, ownership_sources, manual_owned, mycoi_owned, contractors(company_name, trade, active)")
    .eq("project_id", projectId).order("assigned_date", { ascending: false }).order("id").range(start, end)
    .returns<ProjectAssignmentHistoryEntry[]>());
  const assignmentRows = assignments.map(row => ({
    "Contractor Name": row.contractors?.company_name || "\u2014", Trade: row.contractors?.trade || "\u2014",
    "Assigned Date": row.assigned_date, "Removed Date": row.removed_date || "\u2014",
    "Assignment Status": row.active ? `Active (${row.ownership_sources.join(" + ")})` : "Removed",
  }));
  const names = new Map(assignments.map(row => [row.contractor_id, row.contractors?.company_name || "\u2014"]));
  const compliance: ProjectExportRow[] = [];
  const ids = [...names.keys()];
  const records: ExportCompliance[] = [];
  for (let index = 0; index < ids.length; index += 100) {
    records.push(...await allPages((start, end) => supabase.from("compliance_records")
      .select("id, contractor_id, compliance_type_id, registration_number, expiration_date, created_at, registry_status, compliance_types(compliance_name, requires_expiration)")
      .in("contractor_id", ids.slice(index, index + 100)).order("created_at", { ascending: false }).order("id")
      .range(start, end).returns<ExportCompliance[]>()));
  }
  records.sort((left, right) => (right.created_at ?? "").localeCompare(left.created_at ?? "") || left.id - right.id);
  for (const row of records) {
    const status = calculateComplianceStatus({
      compliance_name: row.compliance_types?.compliance_name ?? "",
      requires_expiration: row.compliance_types?.requires_expiration ?? true,
      registration_number: row.registration_number, expiration_date: row.expiration_date,
      registry_status: row.registry_status,
    });
    compliance.push({
      "Compliance Type": row.compliance_types?.compliance_name ?? "Unknown",
      Contractor: names.get(row.contractor_id) || "\u2014",
      "Expiration Date": row.expiration_date || "\u2014", "Current Status": status.calculated_status,
    });
  }
  return [
    { name: "Project Details", columns: ["Project Number", "Project Name", "Status", "Created Date",
      "Inactive By", "Inactive Date", "Reactivated By", "Reactivated Date"],
    rows: [{ "Project Number": project.project_number, "Project Name": project.project_name,
      Status: project.status, "Created Date": new Date(project.created_at).toLocaleDateString(),
      "Inactive By": project.inactivated_by || "\u2014", "Inactive Date": dateTime(project.inactivated_at),
      "Reactivated By": project.reactivated_by || "\u2014", "Reactivated Date": dateTime(project.reactivated_at) }] },
    { name: "Compliance History", columns: ["Compliance Type", "Contractor", "Expiration Date", "Current Status"],
      rows: compliance },
    { name: "Contractor History", columns: ["Contractor Name", "Trade", "Assigned Date", "Removed Date", "Assignment Status"],
      rows: assignmentRows },
  ];
}

export function projectExportXlsx(sections: ProjectExportSection[]): Blob {
  const book = XLSX.utils.book_new();
  for (const section of sections) {
    const sheet = XLSX.utils.json_to_sheet(section.rows, { header: section.columns });
    sheet["!cols"] = section.columns.map(column => ({
      wch: ["Contractor", "Contractor Name", "Project Name", "Assignment Status"].includes(column) ? 42 : 22,
    }));
    sheet["!autofilter"] = { ref: sheet["!ref"] ?? "A1" };
    XLSX.utils.book_append_sheet(book, sheet, section.name);
  }
  return new Blob([XLSX.write(book, { type: "array", bookType: "xlsx" })],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const statusColors: Record<string, { background: [number, number, number]; text: [number, number, number] }> = {
  Active: { background: [209, 250, 229], text: [4, 120, 87] },
  "90 Day": { background: [254, 243, 199], text: [146, 64, 14] },
  "60 Day": { background: [255, 237, 213], text: [194, 65, 12] },
  "30 Day": { background: [254, 226, 226], text: [185, 28, 28] },
  Expired: { background: [127, 29, 29], text: [255, 255, 255] },
  "Missing Information": { background: [224, 242, 254], text: [3, 105, 161] },
};

export function projectExportPdf(sections: ProjectExportSection[]): Blob {
  const document = new jsPDF({ orientation: "portrait" });
  const margin = 14, pageWidth = document.internal.pageSize.getWidth();
  const pageBottom = document.internal.pageSize.getHeight() - margin;
  const width = pageWidth - margin * 2;
  let y = 20;
  const text = (value: string) => value.replace(/\u2014/g, "-");
  const heading = (title: string) => {
    document.setFont("helvetica", "bold"); document.setFontSize(13); document.setTextColor(15, 23, 42);
    document.text(title, margin, y); y += 6;
  };
  for (const section of sections) {
    if (section.name === "Project Details") {
      heading("PROJECT DETAILS");
      const row = section.rows[0] ?? {};
      for (let index = 0; index < section.columns.length; index += 2) {
        document.setFont("helvetica", "normal"); document.setFontSize(10);
        const values = section.columns.slice(index, index + 2).map(column =>
          document.splitTextToSize(text(row[column] ?? ""), width / 2 - 8) as string[]);
        section.columns.slice(index, index + 2).forEach((column, side) => {
          const x = margin + side * width / 2;
          document.setFont("helvetica", "bold"); document.setFontSize(8); document.setTextColor(100, 116, 139);
          document.text(column.toUpperCase(), x, y);
          document.setFont("helvetica", "normal"); document.setFontSize(10); document.setTextColor(30, 41, 59);
          document.text(values[side], x, y + 5);
        });
        y += Math.max(...values.map(lines => lines.length)) * 4.5 + 9;
      }
      y += 4;
      continue;
    }
    const columnWidths = section.name === "Contractor History" ? [52, 25, 26, 26, width - 129] : [40, 69, 32, width - 141];
    document.setFontSize(9);
    const height = (cells: string[], bold = false) => {
      document.setFont("helvetica", bold ? "bold" : "normal");
      return Math.max(...cells.map((cell, index) =>
        document.splitTextToSize(text(cell), columnWidths[index] - 5).length)) * 4 + 5;
    };
    const headerHeight = height(section.columns, true);
    const firstRow = section.rows[0];
    const firstHeight = firstRow ? height(section.columns.map(column => firstRow[column] ?? "")) : 10;
    // Reserve a heading, repeated table header and first complete row together.
    if (y + 8 + headerHeight + firstHeight > pageBottom) { document.addPage(); y = 20; }
    heading(section.name.toUpperCase());
    if (!section.rows.length) {
      document.setFont("helvetica", "normal"); document.setFontSize(9);
      document.text(`No ${section.name.toLowerCase()} found.`, margin, y + 3); y += 14;
      continue;
    }
    autoTable(document, {
      head: [section.columns], body: section.rows.map(row => section.columns.map(column => text(row[column] ?? ""))),
      startY: y, theme: "grid", showHead: "everyPage", rowPageBreak: "avoid",
      margin: { left: margin, right: margin, top: 18, bottom: margin },
      styles: { font: "helvetica", fontSize: 9, cellPadding: 2.5, lineColor: [226, 232, 240],
        lineWidth: 0.2, textColor: [51, 65, 85], overflow: "linebreak", valign: "middle" },
      headStyles: { fillColor: [248, 250, 252], textColor: [51, 65, 85], fontStyle: "bold" },
      columnStyles: Object.fromEntries(columnWidths.map((cellWidth, index) => [index, { cellWidth }])),
      didParseCell: data => {
        if (section.name === "Compliance History" && data.section === "body" && data.column.index === 3) {
          const colors = statusColors[data.cell.text.join(" ")];
          if (colors) { data.cell.styles.fillColor = colors.background; data.cell.styles.textColor = colors.text; }
        }
      },
      didDrawPage: data => { if (data.cursor) y = data.cursor.y + 12; },
    });
  }
  return document.output("blob");
}
