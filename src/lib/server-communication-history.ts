import "server-only";
import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { checkDatabaseError, summaryColumns } from "@/lib/server-communications";
import { COMMUNICATION_STATUSES, type CommunicationSummary } from "@/types/communications";

export function contractorFilter(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
    throw new AdminApiError("A valid contractor ID is required.", 400);
  }
  return Number(value);
}

export async function getCommunicationSummaries(request: Request, params: URLSearchParams, pageSize = 50) {
  const { admin } = await requireModulePermission(request, "communications_summary", "view");
  const offset = params.get("offset") ?? "0";
  if (!/^\d{1,7}$/.test(offset)) throw new AdminApiError("Invalid history offset.", 400);
  const contractor = params.has("contractor_id") ? contractorFilter(params.get("contractor_id")) : null;
  // The extra inner embed filters parent messages, without trimming their full contractor labels.
  const scopedColumns = `${summaryColumns},contractor_filter:communication_contractors!inner(contractor_id)` as const;
  let query = admin.from("communication_messages").select(summaryColumns).order("created_at", { ascending: false }).order("id");
  const filters: Record<string, readonly string[]> = { channel: ["email", "sms"], source: ["manual", "automated"], status: COMMUNICATION_STATUSES };
  for (const [key, allowed] of Object.entries(filters)) {
    const value = params.get(key);
    if (value) {
      if (!allowed.includes(value)) throw new AdminApiError(`Invalid ${key} filter.`, 400);
      query = query.eq(key, value);
    }
  }
  const { data, error } = contractor === null
    ? await query.range(Number(offset), Number(offset) + pageSize - 1)
    : await query.select(scopedColumns).eq("contractor_filter.contractor_id", contractor)
      .range(Number(offset), Number(offset) + pageSize - 1);
  checkDatabaseError(error);
  const messages: CommunicationSummary[] = (data ?? []).map((row) => ({
    id: row.id, channel: row.channel, direction: row.direction, source: row.source, status: row.status, created_at: row.created_at,
    description: `${row.source === "manual" ? "Manual" : "Automated"} ${row.channel} communication`,
    recipient_count: row.communication_recipients[0]?.count ?? 0,
    contractors: row.communication_contractors.map((link) => ({
      contractor_id: link.contractor_id, contractors: Array.isArray(link.contractors) ? link.contractors[0] ?? null : link.contractors,
    })),
    projects: row.communication_projects.map((link) => ({
      project_id: link.project_id, projects: Array.isArray(link.projects) ? link.projects[0] ?? null : link.projects,
    })),
  }));
  return { messages, next_offset: messages.length === pageSize ? Number(offset) + pageSize : null };
}
