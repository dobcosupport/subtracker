import type { ComplianceStatus, ComplianceStatusRecord } from "@/types/database";

export type ComplianceDirectoryFilter = "all" | ComplianceStatus | "31-90" | "90+";

// Reuse the view's status so registry-expired and non-expiring records keep their authoritative classification.
export function matchesComplianceFilter(record: ComplianceStatusRecord, filter: ComplianceDirectoryFilter): boolean {
  if (filter === "all") return true;
  if (filter === "31-90") return record.calculated_status === "60 Day" || record.calculated_status === "90 Day";
  if (filter === "90+") return record.calculated_status === "Active" && record.days_remaining !== null && record.days_remaining > 90;
  return record.calculated_status === filter;
}

export const complianceFilterLabels: Record<ComplianceDirectoryFilter, string> = {
  all: "All compliance records",
  Active: "Current",
  "90 Day": "90 Day",
  "60 Day": "60 Day",
  "30 Day": "30 Day",
  Expired: "Expired",
  "Missing Information": "Missing Information",
  "31-90": "Expiring 31-90 Days",
  "90+": "Expiration outlook: 90+ days",
};
