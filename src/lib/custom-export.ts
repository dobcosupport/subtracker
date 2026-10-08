import * as XLSX from "xlsx";
import { supabase } from "@/lib/supabase";
import { calculateComplianceStatus } from "@/services/compliance";
import type { Contractor, ContractorFollowup, InsuranceTracking } from "@/types/database";
import type { CustomExportConfiguration, CustomExportRow, ExportField, ExportFormat, ExportGroup, ExportFilters, ExportSort } from "@/types/custom-export";

export const EXPORT_GROUPS: { id: ExportGroup; label: string }[] = [
  { id: "company", label: "Company" },
  { id: "nj", label: "NJ Compliance" },
  { id: "ny", label: "NY Compliance" },
  { id: "insurance", label: "Insurance" },
  { id: "projects", label: "Project and Assignment" },
  { id: "followup", label: "Latest Follow-up" },
  { id: "quality", label: "Data Quality" },
];

export const EXPORT_FIELDS: ExportField[] = [
  { id: "contractor_name", label: "Contractor Name", group: "company", defaultSelected: true },
  { id: "sage_erp_id", label: "Sage ERP ID", group: "company", defaultSelected: true },
  { id: "address_1", label: "Address Line 1", group: "company" },
  { id: "address_2", label: "Address Line 2", group: "company" },
  { id: "city", label: "City", group: "company", defaultSelected: true },
  { id: "state", label: "State", group: "company", defaultSelected: true },
  { id: "zip_code", label: "ZIP Code", group: "company" },
  { id: "county", label: "County", group: "company" },
  { id: "phone", label: "Phone", group: "company" },
  { id: "email", label: "Email", group: "company" },
  { id: "material_vendor_only", label: "Material Vendor", group: "company" },
  { id: "contractor_status", label: "Contractor Status", group: "company" },
  { id: "nj_pwc_number", label: "NJ PWC Number", group: "nj", defaultSelected: true },
  { id: "nj_pwc_effective", label: "NJ PWC Effective Date", group: "nj" },
  { id: "nj_pwc_expiration", label: "NJ PWC Expiration Date", group: "nj", defaultSelected: true },
  { id: "nj_pwc_status", label: "NJ PWC Status", group: "nj", defaultSelected: true },
  { id: "nj_brc_number", label: "NJ BRC Business Entity ID", group: "nj" },
  { id: "nj_brc_name_control", label: "NJ BRC Name Control", group: "nj" },
  { id: "nj_brc_status", label: "NJ BRC Status", group: "nj" },
  { id: "ny_pwc_number", label: "NY PWC Number", group: "ny" },
  { id: "ny_pwc_effective", label: "NY PWC Effective Date", group: "ny" },
  { id: "ny_pwc_expiration", label: "NY PWC Expiration Date", group: "ny" },
  { id: "ny_pwc_status", label: "NY PWC Status", group: "ny" },
  { id: "ny_brc_number", label: "NY BRC Number", group: "ny" },
  { id: "ny_brc_status", label: "NY BRC Status", group: "ny" },
  { id: "gl_expiration", label: "General Liability Expiration Date", group: "insurance" },
  { id: "wc_expiration", label: "Workers Compensation Expiration Date", group: "insurance" },
  { id: "project_names", label: "Assigned Project Names", group: "projects" },
  { id: "project_numbers", label: "Assigned Project Numbers", group: "projects" },
  { id: "assignment_status", label: "Assignment Status", group: "projects" },
  { id: "tiered_sub_names", label: "Active Tiered Subcontractors", group: "projects" },
  { id: "tiered_sub_status", label: "Has Active Tiered Subcontractors", group: "projects" },
  { id: "followup_date", label: "Latest Follow-up Date", group: "followup" },
  { id: "followup_method", label: "Latest Follow-up Type", group: "followup" },
  { id: "followup_notes", label: "Latest Follow-up Note", group: "followup" },
  { id: "followup_status", label: "Follow-up Status", group: "followup" },
  { id: "data_warning", label: "Data Warning", group: "quality", defaultSelected: true },
];

type ExportContractor = Pick<Contractor, "id" | "company_name" | "sage_erp_id" | "address_1" | "address_2" | "city" | "state" | "zip_code" | "county" | "phone" | "email" | "material_vendor_only" | "active" | "brc_name_control">;
type Relation<T> = T | T[] | null;
interface ActiveCompliance {
  id: number;
  contractor_id: number;
  registration_number: string | null;
  effective_date: string | null;
  expiration_date: string | null;
  compliance_types: Relation<{ compliance_name: string; requires_expiration: boolean }>;
}
interface ExportAssignment {
  id: number;
  contractor_id: number;
  projects: Relation<{ project_name: string; project_number: string; status: string }>;
}
interface ExportTieredSub {
  id: number;
  contractor_id: number;
  tiered_sub_contractor: Relation<{ company_name: string }>;
}
type ExportInsurance = Pick<InsuranceTracking, "contractor_id" | "general_liability_expiration_date" | "workers_comp_expiration_date">;
type ExportFollowup = Pick<ContractorFollowup, "id" | "contractor_id" | "followup_date" | "followup_method" | "notes" | "status" | "created_at">;

export interface CustomExportData {
  contractors: ExportContractor[];
  compliance: ActiveCompliance[];
  insurance: ExportInsurance[];
  assignments: ExportAssignment[];
  tieredSubs: ExportTieredSub[];
  followups: ExportFollowup[];
}

const CONTRACTOR_COLUMNS = "id, company_name, sage_erp_id, address_1, address_2, city, state, zip_code, county, phone, email, material_vendor_only, active, brc_name_control";
const PAGE_SIZE = 500;
const ID_BATCH_SIZE = 100;

async function readPages<T>(query: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, signal: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    signal.throwIfAborted();
    const { data, error } = await query(start, start + PAGE_SIZE - 1);
    signal.throwIfAborted();
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE_SIZE) return rows;
  }
}

async function readBatches<T>(ids: number[], load: (batch: number[]) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; start < ids.length; start += ID_BATCH_SIZE) {
    rows.push(...await load(ids.slice(start, start + ID_BATCH_SIZE)));
  }
  return rows;
}

export async function countAllExportContractors(signal: AbortSignal): Promise<number> {
  const { count, error } = await supabase.from("contractors").select("id", { count: "exact", head: true }).abortSignal(signal);
  signal.throwIfAborted();
  if (error) throw new Error(error.message);
  if (count === null) throw new Error("Unable to determine the contractor count.");
  return count;
}

export async function fetchCustomExportData(configuration: CustomExportConfiguration, filteredIds: number[], signal: AbortSignal): Promise<CustomExportData> {
  const fields = selectedExportFields(configuration.fields);
  const ids = [...new Set(filteredIds)];
  const loadContractors = (batch?: number[]) => readPages<ExportContractor>((start, end) => {
    let query = supabase.from("contractors").select(CONTRACTOR_COLUMNS).order("id").range(start, end).abortSignal(signal);
    if (batch) query = query.in("id", batch);
    return query;
  }, signal);
  const contractors = configuration.scope === "all" ? await loadContractors() : await readBatches(ids, loadContractors);
  if (configuration.scope === "filtered" && contractors.length !== ids.length) {
    throw new Error("Dashboard results have changed or are no longer accessible. Refresh the Dashboard before exporting.");
  }
  const contractorIds = contractors.map((contractor) => contractor.id);
  const needs = (group: ExportGroup) => fields.some((field) => field.group === group);
  const selected = new Set(configuration.fields);
  const [compliance, insurance, assignments, tieredSubs, followups] = await Promise.all([
    readBatches(contractorIds, (batch) => readPages<ActiveCompliance>((start, end) => supabase
      .from("compliance_records")
      .select("id, contractor_id, registration_number, effective_date, expiration_date, compliance_types!inner(compliance_name, requires_expiration)")
      .in("contractor_id", batch).eq("active", true).eq("is_current", true).eq("compliance_types.active", true)
      .order("id").range(start, end).abortSignal(signal), signal)),
    needs("insurance") ? readBatches(contractorIds, (batch) => readPages<ExportInsurance>((start, end) => supabase
      .from("contractor_insurance").select("contractor_id, general_liability_expiration_date, workers_comp_expiration_date")
      .in("contractor_id", batch).order("contractor_id").range(start, end).abortSignal(signal), signal)) : [],
    ["project_names", "project_numbers", "assignment_status"].some((id) => selected.has(id)) ? readBatches(contractorIds, (batch) => readPages<ExportAssignment>((start, end) => supabase
      .from("contractor_projects").select("id, contractor_id, projects(project_name, project_number, status)")
      .in("contractor_id", batch).eq("active", true).order("id").range(start, end).abortSignal(signal), signal)) : [],
    ["tiered_sub_names", "tiered_sub_status"].some((id) => selected.has(id)) ? readBatches(contractorIds, (batch) => readPages<ExportTieredSub>((start, end) => supabase
      .from("contractor_tiered_subs").select("id, contractor_id, tiered_sub_contractor:contractors!fk_contractor_tiered_subs_tiered_sub_contractor(company_name)")
      .in("contractor_id", batch).eq("active", true).order("id").range(start, end).abortSignal(signal), signal)) : [],
    needs("followup") ? readBatches(contractorIds, (batch) => readPages<ExportFollowup>((start, end) => supabase
      .from("contractor_followups").select("id, contractor_id, followup_date, followup_method, notes, status, created_at")
      .in("contractor_id", batch).order("followup_date", { ascending: false }).order("created_at", { ascending: false })
      .order("id", { ascending: false }).range(start, end).abortSignal(signal), signal)) : [],
  ]);
  signal.throwIfAborted();
  return { contractors, compliance, insurance, assignments, tieredSubs, followups };
}

function relation<T>(value: Relation<T>): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function groupByContractor<T extends { contractor_id: number }>(rows: T[]): Map<number, T[]> {
  const grouped = new Map<number, T[]>();
  for (const row of rows) {
    const list = grouped.get(row.contractor_id) ?? [];
    list.push(row);
    grouped.set(row.contractor_id, list);
  }
  return grouped;
}

function join(values: (string | null | undefined)[]): string {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].join("; ");
}

function date(value: string | null | undefined): string {
  return value?.slice(0, 10) ?? "";
}

export function selectedExportFields(ids: string[]): ExportField[] {
  if (!Array.isArray(ids)) throw new Error("Export fields must be an ordered list.");
  if (ids.length === 0) throw new Error("Select at least one field to export.");
  if (new Set(ids).size !== ids.length) throw new Error("Export fields must not contain duplicates.");
  return ids.map((id) => {
    const field = EXPORT_FIELDS.find((entry) => entry.id === id);
    if (!field) throw new Error(`Export field "${id}" is no longer available. Review the selected fields before exporting.`);
    return field;
  });
}

export function configureExportData(data: CustomExportData, filters?: ExportFilters | null): CustomExportData {
  if (!filters) return data;
  return { ...data, contractors: data.contractors.filter((contractor) =>
    (filters.contractor_status === undefined || contractor.active === (filters.contractor_status === "Active"))
    && (filters.material_vendor_only === undefined || Boolean(contractor.material_vendor_only) === filters.material_vendor_only)
    && (filters.state === undefined || (contractor.state ?? "").trim().toLowerCase() === filters.state.trim().toLowerCase())
    && (filters.city === undefined || (contractor.city ?? "").toLowerCase().includes(filters.city.trim().toLowerCase()))
    && (filters.contractor_name === undefined || contractor.company_name.toLowerCase().includes(filters.contractor_name.trim().toLowerCase()))
  ) };
}

export function buildCustomExportRows(data: CustomExportData, fieldIds: string[]): CustomExportRow[] {
  return prepareCustomExport(data, fieldIds).rows;
}

export function prepareCustomExport(data: CustomExportData, fieldIds: string[], sort?: ExportSort | null): { rows: CustomExportRow[]; warningCount: number } {
  const fields = selectedExportFields(fieldIds);
  const compliance = groupByContractor(data.compliance);
  const assignments = groupByContractor(data.assignments);
  const tieredSubs = groupByContractor(data.tieredSubs);
  const followups = groupByContractor(data.followups);
  const insurance = new Map(data.insurance.map((row) => [row.contractor_id, row]));
  let warningCount = 0;
  const sortValue = (contractor: ExportContractor) => sort?.field === "contractor_name" || !sort ? contractor.company_name : contractor[sort.field] ?? "";
  const rows = [...data.contractors].sort((a, b) =>
    sortValue(a).localeCompare(sortValue(b)) * (sort?.direction === "desc" ? -1 : 1) || a.id - b.id
  ).map((contractor) => {
    const policies = insurance.get(contractor.id);
    const projects = (assignments.get(contractor.id) ?? []).map((row) => relation(row.projects)).filter((project) => project !== null);
    const subs = (tieredSubs.get(contractor.id) ?? []).map((row) => relation(row.tiered_sub_contractor));
    const latest = [...(followups.get(contractor.id) ?? [])].sort((a, b) =>
      b.followup_date.localeCompare(a.followup_date) || b.created_at.localeCompare(a.created_at) || b.id - a.id
    )[0];
    const values: CustomExportRow = {
      contractor_name: contractor.company_name,
      sage_erp_id: contractor.sage_erp_id ?? "",
      address_1: contractor.address_1 ?? "", address_2: contractor.address_2 ?? "",
      city: contractor.city ?? "", state: contractor.state ?? "", zip_code: contractor.zip_code ?? "", county: contractor.county ?? "",
      phone: contractor.phone ?? "", email: contractor.email ?? "",
      material_vendor_only: contractor.material_vendor_only ? "Yes" : "No",
      contractor_status: contractor.active ? "Active" : "Inactive",
      nj_brc_name_control: contractor.brc_name_control ?? "",
      gl_expiration: date(policies?.general_liability_expiration_date),
      wc_expiration: date(policies?.workers_comp_expiration_date),
      project_names: join(projects.map((project) => project.project_name)),
      project_numbers: join(projects.map((project) => project.project_number)),
      assignment_status: projects.length > 0 ? "Active" : "",
      tiered_sub_names: join(subs.map((sub) => sub?.company_name)),
      tiered_sub_status: (tieredSubs.get(contractor.id)?.length ?? 0) > 0 ? "Yes" : "No",
      followup_date: date(latest?.followup_date), followup_method: latest?.followup_method ?? "",
      followup_notes: latest?.notes ?? "", followup_status: latest?.status ?? "",
    };
    const warnings: string[] = [];
    const currentRecords = compliance.get(contractor.id) ?? [];
    const complianceNames = [...new Set(currentRecords.map((record) => relation(record.compliance_types)?.compliance_name).filter((name): name is string => Boolean(name)))].sort();
    for (const name of complianceNames) {
      if (currentRecords.filter((record) => relation(record.compliance_types)?.compliance_name === name).length > 1) {
        warnings.push(`Multiple active/current ${name} records found; ${name} fields left blank`);
      }
    }
    if (warnings.length > 0) warningCount += 1;
    values.data_warning = warnings.join("; ");
    for (const [prefix, name] of [["nj_pwc", "NJ PWC"], ["nj_brc", "NJ BRC"], ["ny_pwc", "NY PWC"], ["ny_brc", "NY BRC"]]) {
      const current = (compliance.get(contractor.id) ?? []).filter((record) => relation(record.compliance_types)?.compliance_name === name);
      if (current.length > 1) {
        for (const suffix of ["number", "effective", "expiration", "status"]) values[`${prefix}_${suffix}`] = "";
        if (prefix === "nj_brc") values.nj_brc_name_control = "";
        continue;
      }
      const record = current[0];
      values[`${prefix}_number`] = record?.registration_number ?? "";
      values[`${prefix}_effective`] = date(record?.effective_date);
      values[`${prefix}_expiration`] = date(record?.expiration_date);
      values[`${prefix}_status`] = record ? calculateComplianceStatus({
        compliance_name: name,
        registration_number: record.registration_number,
        expiration_date: record.expiration_date,
        requires_expiration: relation(record.compliance_types)?.requires_expiration ?? true,
      }).calculated_status : "Missing Information";
    }
    return Object.fromEntries(fields.map((field) => [field.label, values[field.id] ?? ""]));
  });
  return { rows, warningCount };
}

export function exportCompletionMessage(warningCount: number, includesWarnings: boolean): string {
  if (warningCount === 0) return "Export completed.";
  return `Export completed with data warnings for ${warningCount} contractor${warningCount === 1 ? "" : "s"}. ${includesWarnings ? "Review the Data Warning column." : "Data Warning was not selected; data-quality issues are not included in the file."}`;
}

// CSV values can be interpreted as spreadsheet formulas even when quoted.
function spreadsheetText(value: string): string {
  return /^[\s]*[=+\-@]/.test(value) || /^[\t\r\n]/.test(value) ? `'${value}` : value;
}

export function generateCustomExport(rows: CustomExportRow[], fieldIds: string[], format: ExportFormat): Blob {
  const fields = selectedExportFields(fieldIds);
  const headers = fields.map((field) => field.label);
  const worksheet = XLSX.utils.aoa_to_sheet([
    headers,
    ...rows.map((row) => headers.map((header) => format === "csv" ? spreadsheetText(row[header] ?? "") : row[header] ?? "")),
  ]);
  worksheet["!cols"] = headers.map((header) => ({
    wch: Math.min(50, Math.max(12, header.length + 2, ...rows.slice(0, 200).map((row) => Math.min(50, (row[header]?.length ?? 0) + 2)))),
  }));
  if (format === "csv") {
    return new Blob(["\uFEFF", XLSX.utils.sheet_to_csv(worksheet, { RS: "\r\n", forceQuotes: true })], { type: "text/csv;charset=utf-8" });
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Contractors");
  return new Blob([XLSX.write(workbook, { type: "array", bookType: "xlsx" })], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

export function customExportFilename(format: ExportFormat, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `SubTracker_Custom_Export_${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}.${format}`;
}
