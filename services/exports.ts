import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import type { Contractor } from "@/types/database";

export type ContractorExportFilter = "all" | "active" | "inactive";

export interface ContractorMasterExportRow {
  "Company Name": string;
  Trade: string;
  "Address 1": string;
  "Address 2": string;
  City: string;
  State: string;
  "Zip Code": string;
  "Contact Name": string;
  Email: string;
  Phone: string;
  "NJ PWC #": string;
  "NJ BRC #": string;
  "NY PWC #": string;
  "NY BRC #": string;
  "BRC Name Control": string;
  "Sage ERP ID": string;
  Status: string;
  "Project Assignments": string;
  "Compliance Summary": string;
  "Insurance Summary": string;
  "Created Date": string;
  "Last Updated Date": string;
}

interface AssignmentRow {
  contractor_id: number;
  projects: { project_number: string; project_name: string } | null;
}

interface ComplianceStatusRow {
  contractor_id: number;
  compliance_record_id: number | null;
  compliance_name: string | null;
  calculated_status: string | null;
}

interface InsuranceRow {
  contractor_id: number;
  certificate_on_file: boolean;
  last_verified_date: string | null;
  general_liability_on_file?: boolean;
  general_liability_expiration_date?: string | null;
  workers_comp_on_file?: boolean;
  workers_comp_expiration_date?: string | null;
}

const COMPLIANCE_STATUS_ORDER = ["Expired", "30 Day", "60 Day", "90 Day", "Active", "Missing Information"];

function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  return value.slice(0, 10);
}

function buildComplianceSummary(rows: ComplianceStatusRow[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    if (row.compliance_record_id === null) continue;
    const status = row.calculated_status ?? "Unknown";
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  if (counts.size === 0) return "No compliance records";
  const ordered = [...COMPLIANCE_STATUS_ORDER.filter((status) => counts.has(status)), ...[...counts.keys()].filter((status) => !COMPLIANCE_STATUS_ORDER.includes(status))];
  return ordered.map((status) => `${status}: ${counts.get(status)}`).join("; ");
}

function buildInsuranceSummary(row: InsuranceRow | undefined): string {
  if (!row) return "No insurance record";
  const coi = `COI on file: ${row.certificate_on_file ? "Yes" : "No"}`;
  const gl = `GL: ${row.general_liability_on_file ? "Yes" : "No"}${row.general_liability_expiration_date ? ` (expires ${formatDate(row.general_liability_expiration_date)})` : ""}`;
  const wc = `WC: ${row.workers_comp_on_file ? "Yes" : "No"}${row.workers_comp_expiration_date ? ` (expires ${formatDate(row.workers_comp_expiration_date)})` : ""}`;
  const verified = row.last_verified_date ? `Last verified: ${formatDate(row.last_verified_date)}` : "";
  return [coi, gl, wc, verified].filter(Boolean).join("; ");
}

export async function fetchContractorMasterExport(filter: ContractorExportFilter): Promise<{ rows: ContractorMasterExportRow[]; error: { message: string } | null }> {
  let query = supabase.from("contractors").select("*").order("company_name");
  if (filter === "active") query = query.eq("active", true);
  if (filter === "inactive") query = query.eq("active", false);

  const { data: contractors, error: contractorError } = await query;
  if (contractorError) return { rows: [], error: { message: contractorError.message } };

  const list = (contractors ?? []) as Contractor[];
  if (list.length === 0) return { rows: [], error: null };

  const ids = list.map((contractor) => contractor.id);

  const [{ data: assignments }, { data: complianceRows }, { data: insuranceRows }] = await Promise.all([
    supabase.from("contractor_projects").select("contractor_id, projects(project_number, project_name)").in("contractor_id", ids).eq("active", true),
    supabase.from("contractor_compliance_status").select("contractor_id, compliance_record_id, compliance_name, calculated_status").in("contractor_id", ids),
    supabase.from("contractor_insurance").select("contractor_id, certificate_on_file, last_verified_date, general_liability_on_file, general_liability_expiration_date, workers_comp_on_file, workers_comp_expiration_date").in("contractor_id", ids),
  ]);

  const assignmentsByContractor = new Map<number, string[]>();
  for (const assignment of (assignments ?? []) as unknown as AssignmentRow[]) {
    const label = assignment.projects ? `${assignment.projects.project_number} - ${assignment.projects.project_name}` : null;
    if (!label) continue;
    const existing = assignmentsByContractor.get(assignment.contractor_id) ?? [];
    existing.push(label);
    assignmentsByContractor.set(assignment.contractor_id, existing);
  }

  const complianceByContractor = new Map<number, ComplianceStatusRow[]>();
  for (const row of (complianceRows ?? []) as unknown as ComplianceStatusRow[]) {
    const existing = complianceByContractor.get(row.contractor_id) ?? [];
    existing.push(row);
    complianceByContractor.set(row.contractor_id, existing);
  }

  const insuranceByContractor = new Map<number, InsuranceRow>();
  for (const row of (insuranceRows ?? []) as unknown as InsuranceRow[]) {
    insuranceByContractor.set(row.contractor_id, row);
  }

  const rows = list.map((contractor) => ({
    "Company Name": contractor.company_name,
    Trade: contractor.trade ?? "",
    "Address 1": contractor.address_1 ?? "",
    "Address 2": contractor.address_2 ?? "",
    City: contractor.city ?? "",
    State: contractor.state ?? "",
    "Zip Code": contractor.zip_code ?? "",
    "Contact Name": contractor.contact_name ?? "",
    Email: contractor.email ?? "",
    Phone: contractor.phone ?? "",
    "NJ PWC #": contractor.nj_pwc_number ?? "",
    "NJ BRC #": contractor.nj_brc_number ?? "",
    "NY PWC #": contractor.ny_pwc_number ?? "",
    "NY BRC #": contractor.ny_brc_number ?? "",
    "BRC Name Control": contractor.brc_name_control ?? "",
    "Sage ERP ID": contractor.sage_erp_id ?? "",
    Status: contractor.active ? "Active" : "Inactive",
    "Project Assignments": (assignmentsByContractor.get(contractor.id) ?? []).join("; "),
    "Compliance Summary": buildComplianceSummary(complianceByContractor.get(contractor.id) ?? []),
    "Insurance Summary": buildInsuranceSummary(insuranceByContractor.get(contractor.id)),
    "Created Date": formatDate(contractor.created_at),
    "Last Updated Date": formatDate(contractor.updated_at),
  }));

  return { rows, error: null };
}

export function generateContractorMasterExportXlsx(rows: ContractorMasterExportRow[]): Blob {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Contractor Master Export");
  const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });
  return new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function generateContractorMasterExportCsv(rows: ContractorMasterExportRow[]): Blob {
  const sheet = XLSX.utils.json_to_sheet(rows);
  const csv = XLSX.utils.sheet_to_csv(sheet);
  return new Blob([csv], { type: "text/csv;charset=utf-8" });
}
