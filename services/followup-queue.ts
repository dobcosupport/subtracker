import type { DashboardFollowup } from "@/services/followups";

export type FollowupQueueFilter = "open" | "overdue" | "today" | "upcoming";

export function localCalendarDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function matchesFollowupFilter(row: DashboardFollowup, filter: FollowupQueueFilter, today: string): boolean {
  if (row.status !== "Open" && row.status !== "Waiting Response") return false;
  if (filter === "open") return true;
  if (!row.followup_date || !today) return false;
  if (filter === "overdue") return row.followup_date < today;
  if (filter === "today") return row.followup_date === today;
  return row.followup_date > today;
}
