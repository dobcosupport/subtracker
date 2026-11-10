import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { scheduledEmailStatus } from "@/lib/server-scheduled-email-status";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin, profile } = await requireModulePermission(request, "communications_delivery", "manage");
    const id = communicationId((await context.params).id);
    const input: unknown = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminApiError("Invalid communication plan.", 400);
    const value = input as Record<string, unknown>;
    if (Object.keys(value).some(key => !["action", "revision", "scheduled_at"].includes(key)) ||
        !["schedule", "cancel"].includes(String(value.action)) ||
        typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 1 || value.revision > 2147483647 ||
        (value.action === "schedule" ? typeof value.scheduled_at !== "string" ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value.scheduled_at) ||
          !Number.isFinite(Date.parse(value.scheduled_at)) ||
          new Date(`${value.scheduled_at.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== value.scheduled_at.slice(0, 10) : value.scheduled_at != null)) {
      throw new AdminApiError("Choose schedule/cancel, a valid revision and an explicit time-zone send date.", 400);
    }
    const scheduling = await scheduledEmailStatus(admin);
    const { error } = await admin.rpc("plan_communication", {
      p_actor: profile.auth_user_id, p_message: id, p_revision: value.revision,
      p_action: value.action, p_scheduled_at: value.scheduled_at ?? null,
    });
    checkDatabaseError(error);
    return Response.json({ id, status: value.action === "schedule" ? "Scheduled" : "Cancelled",
      execution_enabled: scheduling.execution_enabled, scheduling },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
