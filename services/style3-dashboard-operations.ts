import { supabase } from "@/lib/supabase";
import { adminFetch } from "@/lib/admin-client";
import type { CommunicationSummary } from "@/types/communications";
import type { DashboardFollowup } from "@/services/followups";

export interface ActiveDashboardProject {
  id: number;
  project_number: string;
  project_name: string;
  status: string;
  public_works: boolean | null;
}

export async function getActiveContractorCount(): Promise<number> {
  const { count, error } = await supabase.from("contractors")
    .select("id", { count: "exact", head: true }).eq("active", true);
  if (error || count === null || !Number.isSafeInteger(count) || count < 0) throw new Error(error?.message ?? "Unable to load active contractors.");
  return count;
}

export function summarizeFollowupDates(rows: readonly DashboardFollowup[], today: Date) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const end = new Date(start);
  end.setDate(start.getDate() + 6 - start.getDay());
  const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const current = dateKey(start), weekEnd = dateKey(end);
  const classify = (date: string | null) => !date ? "undated" : date < current ? "past" : date <= weekEnd ? "week" : "upcoming";
  return {
    past: rows.filter(row => classify(row.followup_date) === "past").length,
    thisWeek: rows.filter(row => classify(row.followup_date) === "week").length,
    classify,
  } as const;
}

export async function getActiveDashboardProjects(): Promise<ActiveDashboardProject[]> {
  const rows: ActiveDashboardProject[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("projects")
      .select("id,project_number,project_name,status,public_works")
      .eq("status", "Active").order("project_number").order("id").range(offset, offset + 499)
      .returns<ActiveDashboardProject[]>();
    if (error || !data) throw new Error(error?.message ?? "Unable to load active projects.");
    rows.push(...data);
    if (data.length < 500) return rows;
  }
}

export async function getRecentDashboardEmails(): Promise<CommunicationSummary[]> {
  const response = await adminFetch("/api/communications?channel=email&offset=0");
  const result = await response.json() as { messages?: CommunicationSummary[]; error?: string };
  if (!response.ok || !Array.isArray(result.messages)) throw new Error(result.error ?? "Unable to load email communications.");
  return result.messages;
}

export async function getDashboardEmailDetails(ids: readonly string[]): Promise<Map<string, { subject: string | null; recipients: string[] }>> {
  const entries = await Promise.all(ids.map(async id => {
    const response = await adminFetch(`/api/communications/${encodeURIComponent(id)}`);
    const result = await response.json() as { communication?: { subject?: unknown; communication_recipients?: unknown }; error?: string };
    if (!response.ok) throw new Error(result.error ?? "Unable to load email details.");
    const message = result.communication;
    const validRecipient = (recipient: unknown): recipient is { recipient_name: string } =>
      typeof recipient === "object" && recipient !== null && "recipient_name" in recipient && typeof recipient.recipient_name === "string";
    if (!message || !(typeof message.subject === "string" || message.subject === null) || !Array.isArray(message.communication_recipients)
      || !message.communication_recipients.every(validRecipient)) {
      throw new Error("Email details returned an invalid response.");
    }
    return [id, { subject: message.subject, recipients: message.communication_recipients.map(recipient => recipient.recipient_name) }] as const;
  }));
  return new Map(entries);
}
