import { itemReportColor, itemReportExpiration } from "./item-reports";
import type { DashboardRecord } from "./dashboard";
import type { ComplianceCompany } from "./project-compliance-assessment";

export type FinalReport = "project-compliance" | "insurance" | "follow-up";
export type FinalReportRow = {
  id: string; contractorId: number; companyName: string; status: string; assignedProjects: string;
  item: string; expirationDate: string | null; daysRemaining: number | null;
  complianceIssues: string; insuranceIssues: string;
  followupDate: string | null; lastFollowup: string | null; method: string; subject: string; notes: string;
  severity?: string;
};
export const finalReportColumns: Record<FinalReport, { key: Exclude<keyof FinalReportRow, "id" | "contractorId" | "severity">; label: string }[]> = {
  "project-compliance": [
    { key: "companyName", label: "Contractor" }, { key: "status", label: "Status" },
    { key: "assignedProjects", label: "Assigned Projects" }, { key: "complianceIssues", label: "Compliance Issues" },
    { key: "insuranceIssues", label: "Insurance Issues" },
  ],
  insurance: [
    { key: "companyName", label: "Company Name" }, { key: "item", label: "Insurance Item" },
    { key: "status", label: "Status" }, { key: "expirationDate", label: "Expiration Date" },
    { key: "daysRemaining", label: "Days Remaining" }, { key: "assignedProjects", label: "Assigned Projects" },
  ],
  "follow-up": [
    { key: "companyName", label: "Company Name" }, { key: "status", label: "Status" },
    { key: "followupDate", label: "Follow-Up Date" }, { key: "lastFollowup", label: "Last Follow-Up" },
    { key: "method", label: "Method" }, { key: "subject", label: "Subject" }, { key: "notes", label: "Notes" },
  ],
};
export const finalReportNames: Record<FinalReport, string> = {
  "project-compliance": "Project Compliance", insurance: "Insurance", "follow-up": "Follow-Up",
};
export const followupScopeLimitation = "Project-specific Follow-Up unavailable: contractor_followups has no project_id or follow-up-to-project relationship. Contractor assignments and related compliance/insurance items do not establish which project an individual Follow-Up belongs to. Select All Projects to review contractor-level Follow-Ups.";
export const finalReportNotes: Record<FinalReport, string> = {
  "project-compliance": "Selected-project compliance uses the existing FEIN / NJ BRC / NJ PWC assessment. Insurance issues are MyCOI coverage observations, not project-specific requirements. All Projects retains the broader report assessment.",
  insurance: "Coverage dates are MyCOI-backed. Active Compliance Records is an existing report-source observation, not an insurance requirement. Project selection scopes contractors, not insurance applicability. Dates use inclusive calendar-day boundaries.",
  "follow-up": "Contractor-level Follow-Ups retain their existing dates, status and workflow. Individual Follow-Ups have no authoritative project association.",
};
const urgency = ["Missing", "Missing Information", "Expired", "0-30 Days", "31-60 Days", "61-90 Days", "Unavailable", "Needs Review"];

export function selectedProjectSummary(company: ComplianceCompany, records: DashboardRecord[], today: string) {
  const insurance = records.filter(record => record.contractor_id === company.id
    && record.record_key.startsWith("insurance:") && record.compliance_name !== "Active Compliance Records")
    .map(record => ({ name: record.compliance_name, ...itemReportExpiration(record, today) }));
  const requirements = company.requirements.filter(row => row.applicable || row.status === "Unavailable");
  const statuses = [...requirements.map(row => row.status), ...insurance.map(row => row.status)];
  const severity = urgency.find(status => statuses.includes(status)) ?? "Current";
  const insuranceIssues = insurance.filter(row => urgency.includes(row.status)).map(row => `${row.name}: ${row.status}`).join("; ");
  const complianceIssues = requirements.filter(row => urgency.includes(row.status))
    .map(row => `${row.requirement}: ${row.status}`).join("; ");
  const status = company.materialOnly ? "Material Only"
    : statuses.some(state => ["Missing", "Missing Information", "Expired"].includes(state)) ? "Non-Compliant"
      : statuses.some(state => ["Unavailable", "Needs Review"].includes(state)) ? "Needs Review"
        : statuses.some(state => state.endsWith("Days")) ? "Expiring" : "Compliant";
  return { status, complianceIssues, insuranceIssues, severity: company.materialOnly ? "Material Only" : severity };
}

export function finalReportColor(status: string) {
  const normalized = ({ Missing: "Missing Information", "Non-Compliant": "Missing Information",
    "30 Day": "0-30 Days", "60 Day": "31-60 Days", "90 Day": "61-90 Days", Expiring: "61-90 Days" } as Record<string, string>)[status] ?? status;
  if (["Missing Information", "Expired", "0-30 Days", "31-60 Days", "61-90 Days"].includes(normalized)) return itemReportColor(normalized);
  if (["Current", "Active", "Compliant", "Resolved"].includes(normalized))
    return { fill: [225, 242, 228] as [number, number, number], text: [25, 82, 45] as [number, number, number], tone: "current" };
  if (normalized === "Open") return { fill: [233, 243, 255] as [number, number, number], text: [7, 63, 117] as [number, number, number], tone: "material" };
  if (normalized === "Waiting Response") return itemReportColor("61-90 Days");
  if (["Material Only", "Closed", "Unavailable", "Needs Review"].includes(normalized))
    return { fill: [235, 239, 244] as [number, number, number], text: [71, 85, 105] as [number, number, number], tone: "material" };
  throw new Error(`Unsupported report status: ${status}`);
}
