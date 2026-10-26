import { supabase } from "@/lib/supabase";
import { getComplianceHistoryForContractors } from "@/services/compliance";
import type { ComplianceHistoryRecord } from "@/types/database";

interface PublicWorksAssignment {
  id: number;
  contractor_id: number;
  project_id: number;
  active: boolean;
  contractors: { company_name: string; active: boolean; material_vendor_only: boolean } | null;
  projects: { project_number: string; project_name: string; status: string; public_works: boolean | null } | null;
}

export interface PwcMissingCompany {
  contractor_id: number;
  company_name: string;
  status: "Missing" | "Expired" | "Invalid";
  expiration_date: string | null;
  projects: { id: number; project_number: string; project_name: string }[];
}

export function buildPwcMissing(
  assignments: PublicWorksAssignment[], history: ComplianceHistoryRecord[],
): PwcMissingCompany[] {
  const results = new Map<number, PwcMissingCompany>();
  for (const assignment of assignments) {
    const contractor = assignment.contractors;
    const project = assignment.projects;
    if (!assignment.active || !contractor?.active || contractor.material_vendor_only ||
      project?.status !== "Active" || project.public_works !== true) continue;
    const records = history.filter(record => record.contractor_id === assignment.contractor_id && record.compliance_name === "NJ PWC");
    const current = records.filter(record => record.active && record.is_current);
    if (current.some(record => ["Active", "90 Day", "60 Day", "30 Day"].includes(record.calculated_status))) continue;
    const record = current[0] ?? records[0];
    const company: PwcMissingCompany = results.get(assignment.contractor_id) ?? {
      contractor_id: assignment.contractor_id, company_name: contractor.company_name,
      status: !record ? "Missing" : record.calculated_status === "Expired" ? "Expired" : "Invalid",
      expiration_date: record?.expiration_date ?? null, projects: [],
    };
    if (!company.projects.some(item => item.id === assignment.project_id)) company.projects.push({
      id: assignment.project_id, project_number: project.project_number, project_name: project.project_name,
    });
    results.set(assignment.contractor_id, company);
  }
  return [...results.values()].sort((left, right) => left.company_name.localeCompare(right.company_name));
}

export async function getPwcMissing(): Promise<{
  data: PwcMissingCompany[] | null; error: { message: string } | null;
}> {
  const assignments: PublicWorksAssignment[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await supabase.from("contractor_projects")
      .select("id,contractor_id,project_id,active,contractors(company_name,active,material_vendor_only),projects(project_number,project_name,status,public_works)")
      .eq("active", true).order("id").range(start, start + 499).returns<PublicWorksAssignment[]>();
    if (error) return { data: null, error: { message: `Unable to load PWC Missing assignments: ${error.message}` } };
    if (!data) return { data: null, error: { message: "Unable to load PWC Missing assignments." } };
    assignments.push(...data);
    if (data.length < 500) break;
  }
  const ids = [...new Set(assignments.filter(row => row.contractors?.active && !row.contractors.material_vendor_only &&
    row.projects?.status === "Active" && row.projects.public_works === true).map(row => row.contractor_id))];
  const { data: history, error } = await getComplianceHistoryForContractors(ids);
  if (error) return { data: null, error: { message: `Unable to load PWC Missing compliance: ${error.message}` } };
  if (!history) return { data: null, error: { message: "Unable to load PWC Missing compliance." } };
  return { data: buildPwcMissing(assignments, history), error: null };
}
