import { supabase } from "@/lib/supabase";
import { getAssignments } from "@/services/assignments";
import { getMycoiPolicies, getMycoiExpirations, type MycoiCoveragePolicy } from "@/services/insurance";
import type { ComplianceStatus, ComplianceStatusRecord } from "@/types/database";

export interface DashboardRecord {
  record_key: string;
  contractor_id: number;
  company_name: string;
  compliance_name: string;
  registration_number: string | null;
  expiration_date: string | null;
  days_remaining: number | null;
  calculated_status: ComplianceStatus;
}

export interface DashboardData {
  activeContractorCount: number;
  materialVendorCount: number;
  inactiveContractorCount: number;
  inactiveProjectCount: number;
  records: DashboardRecord[];
  projectNumbersByContractor: Map<number, string[]>;
}

export type CompanyComplianceStatus = "Compliant" | "Expiring" | "Non-Compliant";

export function getCompanyComplianceStatus(records: DashboardRecord[]): CompanyComplianceStatus {
  const statuses = new Set(records.map((record) => record.calculated_status));
  const hasActiveCompliance = records.some((record) => record.record_key.startsWith("compliance:"));

  if (!hasActiveCompliance || statuses.has("Missing Information") || statuses.has("Expired")) {
    return "Non-Compliant";
  }
  if (["30 Day", "60 Day", "90 Day"].some((status) => statuses.has(status as ComplianceStatus))) {
    return "Expiring";
  }
  return "Compliant";
}

type DashboardComplianceViewRow = Omit<ComplianceStatusRecord, "compliance_record_id" | "compliance_type_id" | "compliance_name"> & {
  compliance_record_id: number | null;
  compliance_type_id: number | null;
  compliance_name: string | null;
};

export async function getDashboardCompliance(): Promise<{
  data: DashboardComplianceViewRow[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_compliance_status")
    .select("contractor_id, company_name, contractor_active, compliance_record_id, compliance_type_id, compliance_name, registration_number, expiration_date, days_remaining, calculated_status")
    .eq("contractor_active", true);

  return {
    data: (data as DashboardComplianceViewRow[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

function daysUntil(expirationDate: string): number {
  const [year, month, day] = expirationDate.split("-").map(Number);
  const expirationDay = Date.UTC(year, month - 1, day);
  const today = new Date();
  const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.floor((expirationDay - todayDay) / 86_400_000);
}

function buildDashboardRecords(complianceRows: DashboardComplianceViewRow[], mycoiPolicies: MycoiCoveragePolicy[] = []): DashboardRecord[] {
  const activeContractors = new Map(complianceRows.map((record) => [record.contractor_id, record.company_name]));
  const mycoiExpirations = getMycoiExpirations(mycoiPolicies);

  const records: DashboardRecord[] = complianceRows
    .filter((record) => record.compliance_record_id !== null)
    .map((record) => ({
    record_key: `compliance:${record.compliance_record_id}`,
    contractor_id: record.contractor_id,
    company_name: record.company_name,
    compliance_name: record.compliance_name ?? "—",
    registration_number: record.registration_number,
    expiration_date: record.compliance_name === "NJ BRC" ? null : record.expiration_date,
    days_remaining: record.compliance_name === "NJ BRC" ? null : record.days_remaining,
    calculated_status: record.compliance_name === "NJ BRC"
      ? record.registration_number?.trim() ? "Active" : "Missing Information" : record.calculated_status,
    }));

  activeContractors.forEach((companyName, contractorId) => {
    for (const type of ["NJ PWC", "NJ BRC"]) {
      if (!records.some((record) => record.contractor_id === contractorId && record.compliance_name === type)) {
        records.push({
          record_key: `compliance-missing:${contractorId}:${type}`, contractor_id: contractorId,
          company_name: companyName, compliance_name: type, registration_number: null,
          expiration_date: null, days_remaining: null, calculated_status: "Missing Information",
        });
      }
    }
    const coverage = mycoiExpirations.get(contractorId);
    const addInsuranceRecord = (type: string, status: ComplianceStatus, expirationDate: string | null, daysRemaining: number | null) => {
      records.push({
        record_key: `insurance:${contractorId}:${type}:${status}`,
        contractor_id: contractorId,
        company_name: companyName,
        compliance_name: type,
        registration_number: null,
        expiration_date: expirationDate,
        days_remaining: daysRemaining,
        calculated_status: status,
      });
    };

    const hasActiveCompliance = complianceRows.some(
      (record) => record.contractor_id === contractorId && record.compliance_record_id !== null
    );
    if (!hasActiveCompliance) {
      addInsuranceRecord("Active Compliance Records", "Missing Information", null, null);
    }

    const insurancePolicies = [
      { type: "General Liability", expirationDate: coverage?.general_liability_expiration_date ?? null },
      { type: "Worker's Comp", expirationDate: coverage?.workers_comp_expiration_date ?? null },
    ];

    insurancePolicies.forEach(({ type, expirationDate }) => {
      if (!expirationDate) {
        addInsuranceRecord(type, "Missing Information", expirationDate, null);
        return;
      }

      const daysRemaining = daysUntil(expirationDate);
      if (daysRemaining <= 0) addInsuranceRecord(type, "Expired", expirationDate, daysRemaining);
      else if (daysRemaining <= 30) addInsuranceRecord(type, "30 Day", expirationDate, daysRemaining);
      else if (daysRemaining <= 60) addInsuranceRecord(type, "60 Day", expirationDate, daysRemaining);
      else if (daysRemaining <= 90) addInsuranceRecord(type, "90 Day", expirationDate, daysRemaining);
      else addInsuranceRecord(type, "Active", expirationDate, daysRemaining);
    });
  });

  return records;
}

export async function getCompanyComplianceStatuses(contractorIds: number[]): Promise<{
  data: Map<number, CompanyComplianceStatus> | null;
  error: { message: string } | null;
}> {
  const ids = [...new Set(contractorIds)];
  const statuses = new Map<number, CompanyComplianceStatus>();
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    const complianceRows: DashboardComplianceViewRow[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .from("contractor_compliance_status")
        .select("contractor_id, company_name, contractor_active, compliance_record_id, compliance_type_id, compliance_name, registration_number, expiration_date, days_remaining, calculated_status")
        .in("contractor_id", batch)
        .eq("contractor_active", true)
        .order("contractor_id")
        .order("compliance_record_id")
        .range(offset, offset + 999);
      if (error) return { data: null, error: { message: error.message } };
      const rows = (data ?? []) as DashboardComplianceViewRow[];
      complianceRows.push(...rows);
      if (rows.length < 1000) break;
    }
    const mycoiResult = await getMycoiPolicies(batch);
    const loadError = mycoiResult.error;
    if (loadError) return { data: null, error: { message: loadError.message } };
    const recordsByContractor = new Map<number, DashboardRecord[]>();
    buildDashboardRecords(complianceRows, mycoiResult.data ?? []).forEach((record) => {
      const records = recordsByContractor.get(record.contractor_id) ?? [];
      records.push(record);
      recordsByContractor.set(record.contractor_id, records);
    });
    recordsByContractor.forEach((records, id) => statuses.set(id, getCompanyComplianceStatus(records)));
  }
  return { data: statuses, error: null };
}

export async function getDashboardData(): Promise<{
  data: DashboardData | null;
  error: { message: string } | null;
}> {
  const [complianceResult, assignmentResult, inactiveResult, inactiveProjectResult, vendorResult, mycoiResult] = await Promise.all([
    getDashboardCompliance(),
    getAssignments(),
    supabase
      .from("contractors")
      .select("id", { count: "exact", head: true })
      .eq("active", false),
    supabase
      .from("projects")
      .select("id", { count: "exact", head: true })
      .neq("status", "Active"),
    supabase
      .from("contractors")
      .select("id", { count: "exact", head: true })
      .eq("active", true)
      .eq("material_vendor_only", true),
    getMycoiPolicies(),
  ]);

  const loadError = complianceResult.error || assignmentResult.error || inactiveResult.error || inactiveProjectResult.error || vendorResult.error || mycoiResult.error;
  if (loadError) return { data: null, error: { message: loadError.message } };

  const complianceRows = complianceResult.data ?? [];
  const activeContractors = new Map(complianceRows.map((record) => [record.contractor_id, record.company_name]));
  const records = buildDashboardRecords(complianceRows, mycoiResult.data ?? []);
  const projectNumbersByContractor = new Map<number, string[]>();
  (assignmentResult.data ?? []).forEach((assignment) => {
    if (assignment.projects?.status !== "Active") return;
    const projectNumber = assignment.projects?.project_number;
    if (!projectNumber) return;
    const projectNumbers = projectNumbersByContractor.get(assignment.contractor_id) ?? [];
    if (!projectNumbers.includes(projectNumber)) projectNumbers.push(projectNumber);
    projectNumbersByContractor.set(assignment.contractor_id, projectNumbers);
  });
  return {
    data: { activeContractorCount: activeContractors.size, materialVendorCount: vendorResult.count ?? 0, inactiveContractorCount: inactiveResult.count ?? 0, inactiveProjectCount: inactiveProjectResult.count ?? 0, records, projectNumbersByContractor },
    error: null,
  };
}