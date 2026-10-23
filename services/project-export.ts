import * as XLSX from "xlsx";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import { supabase } from "@/lib/supabase";
import { calculateComplianceStatus } from "@/services/compliance";
import { getMycoiInsurance } from "@/services/mycoi";
import type { ProjectAssignmentHistoryEntry } from "@/services/projects";
import type { ActivityLog, ComplianceRecord, Project } from "@/types/database";

type Cell = string | number | boolean | null;
export type ProjectExportRow = Record<string, Cell>;
export interface ProjectExportSection { name: string; columns: string[]; rows: ProjectExportRow[] }
interface ExportCompliance extends ComplianceRecord {
  registry_status: string | null;
  sync_source: string | null;
  sync_status: string | null;
  matched_company_name: string | null;
  source_url: string | null;
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

export async function loadProjectExport(projectId: number): Promise<ProjectExportSection[]> {
  const { data: project, error } = await supabase.from("projects").select("*").eq("id", projectId).single<Project>();
  if (error || !project) throw new Error(`Project export: ${error?.message ?? "Project not found."}`);
  const assignments = await allPages((start, end) => supabase.from("contractor_projects")
    .select("id, contractor_id, project_id, assigned_date, removed_date, active, ownership_sources, manual_owned, mycoi_owned, contractors(company_name, trade, active)")
    .eq("project_id", projectId).order("id").range(start, end).returns<ProjectAssignmentHistoryEntry[]>());
  const activity = await allPages((start, end) => supabase.from("activity_log").select("*")
    .eq("project_id", projectId).order("id").range(start, end).returns<ActivityLog[]>());
  const assignmentRows = assignments.map(row => ({
    "Assignment ID": row.id, "Contractor ID": row.contractor_id,
    Contractor: row.contractors?.company_name ?? "", Trade: row.contractors?.trade ?? "",
    "Contractor Active": row.contractors?.active ?? false, "Assignment Active": row.active,
    "Assigned Date": row.assigned_date, "Removed Date": row.removed_date,
    Sources: [...row.ownership_sources].sort().map(source =>
      ({ MANUAL: "MAN", MYCOI: "COI", PROCORE: "PRO" }[source] ?? source)).join(" / "),
    "Ownership Sources": row.ownership_sources.join(" + "),
  }));
  const currentIds = new Set(assignments.filter(row => row.active).map(row => row.contractor_id));
  const names = new Map(assignments.map(row => [row.contractor_id, row.contractors?.company_name ?? ""]));
  const compliance: ProjectExportRow[] = [];
  const currentCompliance: ProjectExportRow[] = [];
  const insurance: ProjectExportRow[] = [];
  const ids = [...names.keys()];
  for (let index = 0; index < ids.length; index += 100) {
    const records = await allPages((start, end) => supabase.from("compliance_records")
      .select("*, compliance_types(compliance_name, requires_expiration)")
      .in("contractor_id", ids.slice(index, index + 100)).order("id").range(start, end).returns<ExportCompliance[]>());
    for (const row of records) {
      const status = calculateComplianceStatus({
        compliance_name: row.compliance_types?.compliance_name ?? "",
        requires_expiration: row.compliance_types?.requires_expiration ?? true,
        registration_number: row.registration_number, expiration_date: row.expiration_date,
        registry_status: row.registry_status,
      });
      const exported = {
        "Record ID": row.id, "Contractor ID": row.contractor_id, Contractor: names.get(row.contractor_id) ?? "",
        Type: row.compliance_types?.compliance_name ?? "Unknown", Registration: row.registration_number,
        "Effective Date": row.effective_date, "Expiration Date": row.expiration_date,
        Active: row.active, Current: row.is_current, Status: status.calculated_status,
        "Registry Status": row.registry_status, "Matched Company": row.matched_company_name,
        "Verification Source": row.verification_source, "Sync Source": row.sync_source,
        "Sync Status": row.sync_status, "Source URL": row.source_url, "Verified Date": row.verified_date,
        "Verified By": row.verified_by, Notes: row.notes, Created: row.created_at, Updated: row.updated_at,
      };
      compliance.push(exported);
      if (currentIds.has(row.contractor_id) && row.active && row.is_current) currentCompliance.push(exported);
    }
  }
  for (const contractorId of ids) {
    const result = await getMycoiInsurance(contractorId);
    if (result.error || !result.data) throw new Error(result.error?.message ?? "Project export: myCOI data unavailable.");
    const data = result.data;
    for (const division of data.divisions.filter(row => row.division?.project_id === projectId)) {
      const vendor = data.vendors.find(row => row.id === division.vendor_mapping_id);
      const policies = data.policies.filter(row => row.divisions.some(link => link.contractor_division_id === division.id));
      for (const policy of policies.length ? policies : [null]) insurance.push({
        "Contractor ID": contractorId, Contractor: names.get(contractorId) ?? "",
        "Division ID": division.id, Division: division.division?.raw_division_name ?? "",
        Status: division.compliance_status, "Vendor Active": vendor?.active ?? false,
        "Division Active": division.active, "Division Current": division.is_current,
        "Policy ID": policy?.id ?? null, "Policy Line": policy?.policy_line ?? "",
        "Policy Number": policy?.policy_number ?? "", "Expiration Date": policy?.expiration_date ?? null,
        "Policy Active": policy?.active ?? false, "Policy Current": policy?.is_current ?? false,
        "Expired (myCOI)": policy?.expired ?? null, Source: "MYCOI",
        "Import History ID": policy?.import_history_id ?? division.import_history_id,
        "Import Reference": policy?.import_reference ?? division.import_reference,
        "Last Imported": policy?.last_imported_at ?? division.last_imported_at,
        "Currently Assigned": currentIds.has(contractorId),
      });
    }
  }
  const section = (name: string, rows: ProjectExportRow[], columns: string[]): ProjectExportSection =>
    ({ name, rows, columns: rows.length ? Object.keys(rows[0]) : columns });
  return [
    section("Project", [{ "Project ID": project.id, Number: project.project_number, Name: project.project_name,
      Status: project.status, Created: project.created_at, Updated: project.updated_at,
      "Inactivated By": project.inactivated_by, "Inactivated At": project.inactivated_at,
      "Reactivated By": project.reactivated_by, "Reactivated At": project.reactivated_at,
      "Exported At": new Date().toISOString() }], []),
    section("Current Contractors", assignmentRows.filter(row => row["Assignment Active"]), ["Contractor", "Sources"]),
    section("Current Compliance", currentCompliance, ["Contractor", "Type", "Registration", "Status"]),
    section("Contractor History", assignmentRows, ["Contractor", "Sources", "Assigned Date", "Removed Date"]),
    section("Compliance History", compliance, ["Contractor", "Type", "Registration", "Status"]),
    section("myCOI Insurance", insurance, ["Contractor", "Division", "Policy Line", "Status", "Import Reference"]),
    section("Project Activity", activity.map(row => ({
      "Activity ID": row.id, "Contractor ID": row.contractor_id, Date: row.activity_date,
      Type: row.activity_type, Notes: row.notes, "Created By": row.created_by, Created: row.created_at,
    })), ["Activity ID", "Date", "Type", "Notes", "Created By"]),
  ];
}

export function projectExportXlsx(sections: ProjectExportSection[]): Blob {
  const book = XLSX.utils.book_new();
  for (const section of sections) {
    const sheet = XLSX.utils.json_to_sheet(section.rows, { header: section.columns });
    sheet["!cols"] = section.columns.map(() => ({ wch: 24 }));
    XLSX.utils.book_append_sheet(book, sheet, section.name);
  }
  return new Blob([XLSX.write(book, { type: "array", bookType: "xlsx" })],
    { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function projectExportPdf(sections: ProjectExportSection[]): Blob {
  const document = new jsPDF({ orientation: "landscape" });
  sections.forEach((section, index) => {
    if (index) document.addPage();
    document.setFontSize(14);
    document.text(`Project / Audit Report - ${section.name}`, 14, 15);
    // Key/value rows keep all provenance fields readable without squeezing wide sheets into a PDF.
    const body = section.rows.flatMap((row, rowIndex) => section.columns.map(column =>
      [String(rowIndex + 1), column, row[column] === null || row[column] === undefined ? "" : String(row[column])]));
    autoTable(document, { head: [["Record", "Field", "Value"]], body: body.length ? body : [["", "", "No records"]],
      startY: 22, styles: { fontSize: 8, overflow: "linebreak" },
      columnStyles: { 0: { cellWidth: 15 }, 1: { cellWidth: 55 } }, margin: { top: 22 },
      didDrawPage: () => { document.setFontSize(8); document.text(section.name, 14, 10); } });
  });
  return document.output("blob");
}
