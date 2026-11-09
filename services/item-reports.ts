import { classifyExpiration } from "./expiration-classification";
import type { DashboardRecord } from "./dashboard";

export type ItemReport = "missing-information" | "expired-items" | "upcoming-expirations";
export type ItemReportColumnKey = "companyName" | "item" | "status" | "expirationDate" | "daysRemaining" | "assignedProjects";
export const itemReportColumns: Record<ItemReport, { key: ItemReportColumnKey; label: string }[]> = {
  "missing-information": [
    { key: "companyName", label: "Company Name" }, { key: "item", label: "Missing Item" },
    { key: "status", label: "Status" }, { key: "assignedProjects", label: "Assigned Projects" },
  ],
  "expired-items": [
    { key: "companyName", label: "Company Name" }, { key: "item", label: "Expired Item" },
    { key: "expirationDate", label: "Expiration Date" }, { key: "daysRemaining", label: "Days Remaining" },
    { key: "assignedProjects", label: "Assigned Projects" },
  ],
  "upcoming-expirations": [
    { key: "companyName", label: "Company Name" }, { key: "item", label: "Expiring Item" },
    { key: "expirationDate", label: "Expiration Date" }, { key: "daysRemaining", label: "Days Remaining" },
    { key: "status", label: "Status" }, { key: "assignedProjects", label: "Assigned Projects" },
  ],
};
export const itemReportNames: Record<ItemReport, string> = {
  "missing-information": "Missing Information", "expired-items": "Expired Items", "upcoming-expirations": "Upcoming Expirations",
};
export const upcomingStatuses = ["0-30 Days", "31-60 Days", "61-90 Days"];
type Color = [number, number, number];
const colors: Record<string, { fill: Color; text: Color; tone: string }> = {
  "Missing Information": { fill: [249, 202, 207], text: [125, 12, 27], tone: "missing" },
  Expired: { fill: [249, 202, 207], text: [125, 12, 27], tone: "expired" },
  "0-30 Days": { fill: [255, 222, 222], text: [146, 25, 34], tone: "red" },
  "31-60 Days": { fill: [255, 232, 201], text: [120, 55, 0], tone: "orange" },
  "61-90 Days": { fill: [255, 246, 202], text: [99, 76, 0], tone: "yellow" },
};

export function itemReportColor(status: string) {
  const color = colors[status];
  if (!color) throw new Error(`Unsupported item-report status: ${status}`);
  return color;
}

// Reports use inclusive calendar buckets without changing Dashboard's legacy date semantics.
export function itemReportExpiration(record: DashboardRecord, today: string): { status: string; daysRemaining: number | null } {
  if (record.compliance_name === "NJ BRC" || !record.expiration_date || record.calculated_status === "Missing Information") {
    return { status: record.calculated_status, daysRemaining: record.days_remaining };
  }
  const expiration = classifyExpiration(record.expiration_date, today);
  // A future-dated source Expired result can be registry-confirmed; do not erase that authority.
  return { status: record.calculated_status === "Expired" && expiration.daysRemaining > 0 ? "Expired" : expiration.status,
    daysRemaining: expiration.daysRemaining };
}
