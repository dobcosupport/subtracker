import "server-only";
import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { checkDatabaseError, summaryColumns } from "@/lib/server-communications";
import { COMMUNICATION_STATUSES, type CommunicationSummary } from "@/types/communications";

function frozenLabels(value: unknown): Record<string, unknown>[] | null {
  if (value == null) return null;
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new AdminApiError("Communication snapshot is invalid.", 503);
  }
  return value;
}

export function contractorFilter(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
    throw new AdminApiError("A valid contractor ID is required.", 400);
  }
  return Number(value);
}

export async function getCommunicationSummaries(request: Request, params: URLSearchParams, pageSize = 50, operationalOnly = false) {
  const { admin } = await requireModulePermission(request, "communications_summary", "view");
  const offset = params.get("offset") ?? "0";
  if (!/^\d{1,7}$/.test(offset)) throw new AdminApiError("Invalid history offset.", 400);
  const contractor = params.has("contractor_id") ? contractorFilter(params.get("contractor_id")) : null;
  const view = params.get("view");
  if (view && !["Overview", "Scheduled", "Sent"].includes(view)) throw new AdminApiError("Invalid Email view.", 400);
  // The extra inner embed filters parent messages, without trimming their full contractor labels.
  const scopedColumns = `${summaryColumns},contractor_filter:communication_contractors!inner(contractor_id)` as const;
  let query = admin.from("communication_messages").select(summaryColumns).order("created_at", { ascending: false }).order("id");
  if (operationalOnly) query = query.neq("status", "Draft");
  if (view) {
    query = query.eq("channel", "email");
    if (view === "Scheduled") query = query.eq("status", "Scheduled");
    if (view === "Sent") query = query.in("status", ["Sent", "Delivered"]);
  }
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
  const messages: CommunicationSummary[] = (data ?? []).map((row) => {
    const contractors = frozenLabels(row.frozen_contractors), projects = frozenLabels(row.frozen_projects);
    if (contractors?.some(c => typeof c.contractor_id !== "number" || typeof c.company_name !== "string") ||
        projects?.some(p => typeof p.project_id !== "number" || typeof p.project_number !== "string" || typeof p.project_name !== "string")) {
      throw new AdminApiError("Communication labels are invalid.", 503);
    }
    return {
    id: row.id, channel: row.channel, direction: row.direction, source: row.source, status: row.status, revision: row.revision, created_at: row.created_at,
    communication_type: row.communication_type, scheduled_at: row.scheduled_at, sent_at: row.sent_at,
    historical_context_available: contractors !== null && projects !== null,
    description: `${row.source === "manual" ? "Manual" : "Automated"} ${row.channel} communication`,
    recipient_count: row.communication_recipients[0]?.count ?? 0,
    contractors: contractors ? contractors.map(link => ({
      contractor_id: Number(link.contractor_id), contractors: { company_name: String(link.company_name) },
    })) : row.communication_contractors.map((link) => ({
      contractor_id: link.contractor_id, contractors: Array.isArray(link.contractors) ? link.contractors[0] ?? null : link.contractors,
    })),
    projects: projects ? projects.map(link => ({
      project_id: Number(link.project_id), projects: { project_number: String(link.project_number), project_name: String(link.project_name) },
    })) : row.communication_projects.map((link) => ({
      project_id: link.project_id, projects: Array.isArray(link.projects) ? link.projects[0] ?? null : link.projects,
    })),
  }; });
  return { messages, next_offset: messages.length === pageSize ? Number(offset) + pageSize : null };
}
