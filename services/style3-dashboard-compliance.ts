import { calculateCurrentCompliance, type RequirementAssessment } from "@/services/style3-compliance-metrics";
import { adminFetch } from "@/lib/admin-client";
import { insuranceRelatedItems } from "@/lib/followup-related-item";
import type { OverallComplianceCounts } from "@/services/style3-overall-compliance";

export interface DashboardEligibilityData {
  contractors: { contractor_id: number; company_name: string; applicability: "applicable" | "not_applicable" | "unknown" }[];
  requirements: { id: number; compliance_name: string; requires_expiration: boolean }[];
  known_type_ids: number[];
  statuses: { contractor_id: number; compliance_type_id: number | null; compliance_record_id: number | null;
    expiration_date: string | null; days_remaining: number | null; calculated_status: string }[];
  overall_compliance: OverallComplianceCounts;
}

export function summarizeDashboardCompliance(data: DashboardEligibilityData) {
  const knownTypes = new Set(data.known_type_ids);
  const assessments: RequirementAssessment[] = [];
  const expirations: { contractorId: number; companyName: string; requirement: string; date: string; days: number }[] = [];
  const exceptions: { contractorId: number; companyName: string; requirement: string; status: "Expired" | "Needs Review" }[] = [];
  const statuses = new Map<string, DashboardEligibilityData["statuses"]>();
  for (const row of data.statuses) {
    const key = `${row.contractor_id}:${row.compliance_type_id}`;
    const group = statuses.get(key) ?? [];
    group.push(row);
    statuses.set(key, group);
  }
  for (const contractor of data.contractors) {
    for (const requirement of data.requirements) {
      const applicable = knownTypes.has(requirement.id) ? contractor.applicability : "unknown";
      const matches = statuses.get(`${contractor.contractor_id}:${requirement.id}`) ?? [];
      const row = matches.length === 1 ? matches[0] : undefined;
      const current = row && ["Active", "30 Day", "60 Day", "90 Day"].includes(row.calculated_status);
      const deficient = row?.calculated_status === "Expired" && requirement.requires_expiration;
      assessments.push({
        contractorId: contractor.contractor_id,
        requirementId: `compliance:${requirement.id}`,
        applicability: applicable,
        status: current ? "current" : deficient ? "deficient" : "unknown",
      });
      if (applicable === "applicable" && !current) {
        exceptions.push({ contractorId: contractor.contractor_id, companyName: contractor.company_name,
          requirement: requirement.compliance_name, status: deficient ? "Expired" : "Needs Review" });
      }
      if (applicable === "applicable" && current && row && requirement.requires_expiration && row.expiration_date
        && row.days_remaining !== null && row.days_remaining > 0 && row.days_remaining <= 90) {
        expirations.push({ contractorId: contractor.contractor_id, companyName: contractor.company_name,
          requirement: requirement.compliance_name, date: row.expiration_date, days: row.days_remaining });
      }
    }
    for (const item of insuranceRelatedItems) assessments.push({
      contractorId: contractor.contractor_id, requirementId: `insurance:${item.key}`, applicability: "unknown", status: "unknown",
    });
  }
  expirations.sort((a, b) => a.days - b.days || a.companyName.localeCompare(b.companyName));
  const njPwcTypes = data.requirements.filter(row => knownTypes.has(row.id) && row.compliance_name.trim().toUpperCase() === "NJ PWC");
  const njPwcType = njPwcTypes.length === 1 ? njPwcTypes[0] : null;
  const njPwcAssessments = njPwcType ? assessments.filter(row => row.requirementId === `compliance:${njPwcType.id}` && row.applicability === "applicable") : [];
  return {
    population: data.contractors.length,
    contractors: data.contractors,
    overallCompliance: data.overall_compliance,
    metric: calculateCurrentCompliance(data.contractors.map(row => row.contractor_id), assessments),
    knownRequirements: data.requirements.filter(row => knownTypes.has(row.id)).map(row => row.compliance_name),
    njPwc: njPwcType ? {
      current: njPwcAssessments.filter(row => row.status === "current").length,
      expired: njPwcAssessments.filter(row => row.status === "deficient").length,
      expiring: expirations.filter(row => row.requirement === njPwcType.compliance_name && row.days <= 30).length,
    } : null,
    expirations,
    exceptions,
  };
}

export async function getDashboardEligibility(): Promise<DashboardEligibilityData> {
  const response = await adminFetch("/api/dashboard/eligibility");
  const data = await response.json() as DashboardEligibilityData & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Unable to load Dashboard eligibility.");
  const overall = data.overall_compliance;
  const overallCounts = overall && [overall.compliant, overall.nonCompliant, overall.expiringSoon, overall.needsReview];
  const overallTotal = overallCounts?.reduce((total, count) => total + count, 0);
  if (!Array.isArray(data.contractors) || !Array.isArray(data.requirements)
    || !Array.isArray(data.known_type_ids) || !Array.isArray(data.statuses)
    || !overall || !Number.isSafeInteger(overall.population) || overall.population !== data.contractors.length
    || !overallCounts?.every(count => Number.isSafeInteger(count) && count >= 0) || overallTotal !== overall.population
    || overall.rate !== (overall.population ? overall.compliant / overall.population * 100 : null)) {
    throw new Error("Dashboard eligibility returned an invalid response.");
  }
  return data;
}
