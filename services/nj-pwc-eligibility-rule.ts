// Ordered source of truth for the browser adapter and the proposed SQL predicate.
export const NJ_PWC_EXCLUSIONS = [
  { field: "contractor_active", sql: "p_contractor_active IS DISTINCT FROM TRUE", reason: "contractor_inactive", detail: "Contractor is inactive." },
  { field: "company_name", sql: "nullif(btrim(p_company_name), '') IS NULL", reason: "invalid_company", detail: "Contractor company name is missing." },
  { field: "material_only", sql: "p_material_only IS DISTINCT FROM FALSE", reason: "material_only", detail: "Material Only classification excludes NJ PWC." },
  { field: "assignment_active", sql: "p_assignment_active IS DISTINCT FROM TRUE", reason: "assignment_inactive", detail: "No active assignment to this project." },
  { field: "project_status", sql: "p_project_status IS DISTINCT FROM 'Active'", reason: "project_inactive", detail: "Project is not Active." },
  { field: "public_works", sql: "p_public_works IS DISTINCT FROM TRUE", reason: "not_public_works", detail: "Project is not Public Works." },
] as const;

export type NjPwcRuleInput = {
  contractor_active: boolean | null; company_name: string | null; material_only: boolean | null;
  assignment_active: boolean | null; project_status: string | null; public_works: boolean | null;
};
export function evaluateNjPwcAssignment(input: NjPwcRuleInput) {
  const exclusion = NJ_PWC_EXCLUSIONS.find(rule => rule.field === "company_name"
    ? !input.company_name?.replace(/^ +| +$/g, "")
    : rule.field === "material_only" ? input.material_only !== false
      : rule.field === "project_status" ? input.project_status !== "Active" : input[rule.field] !== true);
  return { applicable: !exclusion, reason: exclusion?.reason ?? "eligible",
    detail: exclusion?.detail ?? "Active assignment to an Active Public Works project." };
}
export function njPwcReasonSql(): string {
  return `CASE\n${NJ_PWC_EXCLUSIONS.map(rule => `        WHEN ${rule.sql} THEN '${rule.reason}'`).join("\n")}\n        ELSE 'eligible'\n    END`;
}
