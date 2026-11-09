import { supabase } from "@/lib/supabase";
import { classifyExpiration, type ExpirationState } from "./expiration-classification";
import { njRequirementApplicability } from "./style3-overall-compliance";
import { evaluateNjPwcAssignment } from "./nj-pwc-eligibility-rule";
import type { Contractor, Project } from "@/types/database";

export type AssessmentProject = Pick<Project, "id" | "project_number" | "project_name" | "status" | "public_works">;
export type AssessmentContractor = Pick<Contractor, "id" | "company_name" | "active" | "state" | "federal_tax_id" | "nj_brc_number" | "material_vendor_only">;
export type AssessmentRecord = {
  contractor_id: number; compliance_name: string; registration_number: string | null;
  expiration_date: string | null; registry_status: string | null;
};
export type ProjectPwcEligibility = { contractor_id: number; project_id: number; applicable: boolean };
export type RequirementAssessment = {
  contractorId: number;
  projectId: number | null;
  requirement: "FEIN" | "NJ BRC" | "NJ PWC";
  applicable: boolean;
  status: ExpirationState | "Missing" | "Not Required" | "Unavailable";
  expirationDate: string | null;
  daysRemaining: number | null;
  detail: string;
};

function validId(id: number): boolean { return Number.isSafeInteger(id) && id > 0; }

export function assessProjectContractor(
  contractor: AssessmentContractor,
  project: AssessmentProject,
  eligibility: ProjectPwcEligibility,
  currentRecords: readonly AssessmentRecord[],
  today?: string,
): RequirementAssessment[] {
  if (!validId(project.id) || !validId(contractor.id) || eligibility.project_id !== project.id
    || eligibility.contractor_id !== contractor.id || typeof eligibility.applicable !== "boolean") {
    throw new Error("Selected-project compliance context is invalid or incomplete.");
  }
  if (typeof project.public_works !== "boolean") throw new Error("The selected project's Public Works classification is unknown.");
  if (currentRecords.some(record => record.contractor_id !== contractor.id)) throw new Error("Compliance records are outside the selected contractor scope.");
  return assessRequirements(contractor, project.id, eligibility.applicable,
    !eligibility.applicable ? contractor.material_vendor_only ? "Material Only contractor."
      : !contractor.active ? "Contractor is inactive." : project.status !== "Active" ? "Selected project is not Active."
        : !project.public_works ? "Selected project is not Public Works." : "No qualifying active assignment to the selected project."
      : "Active assignment to the selected Public Works project.", currentRecords, today);
}

function assessRequirements(contractor: AssessmentContractor, projectId: number | null, pwcApplicable: boolean,
  pwcDetail: string, currentRecords: readonly AssessmentRecord[], today?: string): RequirementAssessment[] {
  const nj = njRequirementApplicability(contractor.state ?? null);
  const result = (requirement: RequirementAssessment["requirement"], applicable: boolean,
    status: RequirementAssessment["status"], detail: string, expirationDate: string | null = null,
    daysRemaining: number | null = null): RequirementAssessment => ({
    contractorId: contractor.id, projectId, requirement, applicable, status, expirationDate, daysRemaining, detail,
  });
  const hasFein = Boolean(contractor.federal_tax_id?.trim());
  const assessments = [result("FEIN", true, hasFein ? "Current" : "Missing", hasFein ? "On File" : "Taxpayer ID is missing.")];
  if (nj === null) assessments.push(result("NJ BRC", false, "Unavailable", "Contractor state is unknown; NJ applicability requires review."));
  else if (!nj) assessments.push(result("NJ BRC", false, "Not Required", "Contractor is outside NJ applicability."));
  else {
    const brc = currentRecords.filter(record => record.compliance_name === "NJ BRC");
    if (brc.length > 1 || (!brc.length && contractor.nj_brc_number?.trim())) {
      assessments.push(result("NJ BRC", true, "Unavailable", "NJ BRC current-record authority requires review."));
    } else {
      const onFile = Boolean(brc[0]?.registration_number?.trim());
      assessments.push(result("NJ BRC", true, onFile ? "Current" : "Missing", onFile ? "On File (non-expiring)" : "NJ BRC is missing."));
    }
  }
  if (!pwcApplicable) {
    assessments.push(result("NJ PWC", false, "Not Required", pwcDetail));
  } else {
    const pwc = currentRecords.filter(record => record.compliance_name === "NJ PWC");
    if (pwc.length > 1) {
      assessments.push(result("NJ PWC", true, "Unavailable", "Multiple current NJ PWC records require review."));
      return assessments;
    }
    const record = pwc[0];
    if (!record?.registration_number?.trim() || !record.expiration_date) {
      assessments.push(result("NJ PWC", true, "Missing", "Current NJ PWC registration or expiration is missing."));
    } else {
      const expiration = classifyExpiration(record.expiration_date, today);
      const registryExpired = record.registry_status === "Expired - Not Found in Registry";
      assessments.push(result("NJ PWC", true, registryExpired ? "Expired" : expiration.status,
        registryExpired ? "Registry-confirmed expiration on the current record."
          : expiration.status === "Expired" ? "Registration expired." : `Registration expires in ${expiration.daysRemaining} days.`,
        record.expiration_date, expiration.daysRemaining));
    }
  }
  return assessments;
}

async function readAll<T>(read: (start: number, end: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>, signal: AbortSignal): Promise<T[]> {
  const rows: T[] = [];
  for (let start = 0; ; start += 500) {
    signal.throwIfAborted();
    const { data, error } = await read(start, start + 499);
    signal.throwIfAborted();
    if (error || !data) throw new Error(error?.message ?? "Selected-project compliance data is unavailable.");
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

export async function getReportProjectContext(signal: AbortSignal): Promise<{
  projects: AssessmentProject[];
  assignments: { id: number; contractor_id: number; project_id: number; active: boolean }[];
}> {
  const [projects, assignments] = await Promise.all([
    readAll((a, b) => supabase.from("projects").select("id,project_number,project_name,status,public_works").order("id").range(a, b)
      .abortSignal(signal).returns<AssessmentProject[]>(), signal),
    readAll((a, b) => supabase.from("contractor_projects").select("id,contractor_id,project_id,active").eq("active", true).order("id").range(a, b)
      .abortSignal(signal).returns<{ id: number; contractor_id: number; project_id: number; active: boolean }[]>(), signal),
  ]);
  if (projects.some(project => !validId(project.id)) || new Set(projects.map(project => project.id)).size !== projects.length
    || assignments.some(assignment => !validId(assignment.contractor_id) || !validId(assignment.project_id) || assignment.active !== true
      || !projects.some(project => project.id === assignment.project_id))) {
    throw new Error("Project or assignment context is invalid or no longer accessible. Reload Reports.");
  }
  return { projects, assignments };
}

export async function getSelectedProjectAssessment(projectId: number, signal: AbortSignal, today?: string) {
  if (!validId(projectId)) throw new Error("A valid selected project ID is required.");
  return getComplianceReportAssessment(projectId, signal, today);
}

// Reads only the signed-in user's visible rows; never calls an elevated eligibility endpoint.
export async function getComplianceReportAssessment(scope: number | "all" | "unassigned", signal: AbortSignal, today?: string): Promise<{
  project: AssessmentProject | null; contractors: AssessmentContractor[]; assessments: RequirementAssessment[];
}> {
  if ((typeof scope === "number" && !validId(scope))
    || (typeof scope !== "number" && scope !== "all" && scope !== "unassigned")) {
    throw new Error("A valid selected project ID or explicit report scope is required.");
  }
  let project: AssessmentProject | null = null;
  if (typeof scope === "number") {
    const result = await supabase.from("projects").select("id,project_number,project_name,status,public_works")
      .eq("id", scope).abortSignal(signal).maybeSingle<AssessmentProject>();
    signal.throwIfAborted();
    if (result.error || !result.data || result.data.id !== scope) throw new Error(result.error?.message ?? "Selected project is missing or inaccessible.");
    project = result.data;
    if (typeof project.public_works !== "boolean") throw new Error("The selected project's Public Works classification is unknown.");
  }
  const context = project ? null : await getReportProjectContext(signal);
  const assignments = project ? await readAll((a, b) => supabase.from("contractor_projects").select("id,contractor_id,project_id,active")
    .eq("project_id", project.id).eq("active", true).order("id").range(a, b).abortSignal(signal)
    .returns<{ id: number; contractor_id: number; project_id: number; active: boolean }[]>(), signal) : context?.assignments ?? [];
  if (assignments.some(row => !validId(row.contractor_id) || row.active !== true || (project && row.project_id !== project.id))) {
    throw new Error("Selected-project assignment context is invalid or inaccessible.");
  }
  const allCompanies = project ? null : await readAll((a, b) => supabase.from("contractors")
    .select("id,company_name,active,state,federal_tax_id,nj_brc_number,material_vendor_only")
    .eq("active", true).is("merged_into_contractor_id", null).order("id").range(a, b).abortSignal(signal).returns<AssessmentContractor[]>(), signal);
  const ids = project ? [...new Set(assignments.map(assignment => assignment.contractor_id))]
    : (allCompanies ?? []).filter(company => scope !== "unassigned" || !assignments.some(row => row.contractor_id === company.id)).map(company => company.id);
  if (ids.some(id => !validId(id))) throw new Error("Selected-project contractor IDs are invalid.");
  const contractors: AssessmentContractor[] = [];
  const assessments: RequirementAssessment[] = [];
  for (let offset = 0; offset < ids.length; offset += 100) {
    const batch = ids.slice(offset, offset + 100);
    const [companyRows, records] = await Promise.all([
      allCompanies ? Promise.resolve(allCompanies.filter(company => batch.includes(company.id)))
        : readAll((a, b) => supabase.from("contractors").select("id,company_name,active,state,federal_tax_id,nj_brc_number,material_vendor_only")
          .in("id", batch).order("id").range(a, b).abortSignal(signal).returns<AssessmentContractor[]>(), signal),
      readAll((a, b) => supabase.from("compliance_records")
        .select("contractor_id,registration_number,expiration_date,registry_status,compliance_types!inner(compliance_name)")
        .in("contractor_id", batch).eq("active", true).eq("is_current", true).eq("compliance_types.active", true)
        .in("compliance_types.compliance_name", ["NJ BRC", "NJ PWC"])
        .order("id").range(a, b).abortSignal(signal).returns<(Omit<AssessmentRecord, "compliance_name"> & {
          compliance_types: { compliance_name: string } | { compliance_name: string }[];
        })[]>(), signal),
    ]);
    signal.throwIfAborted();
    if (companyRows.length !== batch.length || new Set(companyRows.map(company => company.id)).size !== batch.length
      || companyRows.some(company => !batch.includes(company.id))) {
      throw new Error("Selected-project contractors are missing, inaccessible or changed. Reload Reports.");
    }
    for (const contractor of companyRows) {
      const currentRecords = records.filter(record => record.contractor_id === contractor.id).map(record => {
        const type = Array.isArray(record.compliance_types) ? record.compliance_types[0] : record.compliance_types;
        if (!type) throw new Error("Current compliance requirement type is unavailable.");
        return { ...record, compliance_name: type.compliance_name };
      });
      const candidates = project ? [project] : (context?.projects ?? []).filter(p =>
        assignments.some(row => row.contractor_id === contractor.id && row.project_id === p.id));
      const rules = candidates.map(candidate => evaluateNjPwcAssignment({
        contractor_active: contractor.active, company_name: contractor.company_name, material_only: contractor.material_vendor_only ?? null,
        assignment_active: assignments.some(row => row.contractor_id === contractor.id && row.project_id === candidate.id && row.active),
        project_status: candidate.status, public_works: candidate.public_works,
      }));
      const authority = rules.find(rule => rule.applicable) ?? rules[0];
      assessments.push(...assessRequirements(contractor, project?.id ?? null, authority?.applicable ?? false,
        authority?.detail ?? "No visible active project assignment qualifies for NJ PWC.", currentRecords, today));
    }
    contractors.push(...companyRows);
  }
  return { project, contractors, assessments };
}

export type ComplianceCompany = { id: number; name: string; materialOnly: boolean; requirements: RequirementAssessment[]; state: "Fully Compliant" | "Expiring Soon" | "Non-Compliant" | "Needs Review" };
export function complianceCompanies(data: Awaited<ReturnType<typeof getComplianceReportAssessment>>): ComplianceCompany[] {
  return data.contractors.map(contractor => {
    const requirements = data.assessments.filter(row => row.contractorId === contractor.id);
    const state: ComplianceCompany["state"] = requirements.some(row => row.status === "Unavailable") ? "Needs Review"
      : requirements.some(row => row.applicable && ["Missing", "Expired"].includes(row.status)) ? "Non-Compliant"
        : requirements.some(row => row.applicable && row.status.endsWith("Days")) ? "Expiring Soon" : "Fully Compliant";
    return { id: contractor.id, name: contractor.company_name, materialOnly: contractor.material_vendor_only === true, requirements, state };
  }).sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
}
export function filterComplianceCompanies(companies: ComplianceCompany[], search: string, status: string): ComplianceCompany[] {
  const term = search.trim().toLowerCase();
  return companies.filter(company => (!term || company.name.toLowerCase().includes(term))
    && (status === "All statuses" || company.requirements.some(row => row.applicable && row.status === status)));
}
export function complianceSummary(companies: ComplianceCompany[]) {
  return [
    { label: "Contractors", count: companies.length },
    { label: "Fully Compliant", count: companies.filter(company => company.state === "Fully Compliant").length },
    { label: "Expiring \u226490 Days", count: companies.filter(company => company.requirements.some(row => row.applicable && row.status.endsWith("Days"))).length },
    { label: "Expired", count: companies.filter(company => company.requirements.some(row => row.applicable && row.status === "Expired")).length },
    { label: "Missing Requirements", count: companies.filter(company => company.requirements.some(row => row.applicable && row.status === "Missing")).length },
  ];
}
