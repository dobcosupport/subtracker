import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError, deliveryColumns } from "@/lib/server-communications";
import { emailRecipientRoles, storedEmailRole } from "@/lib/server-email-workspace";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin } = await requireModulePermission(request, "communications_delivery", "view");
    const id = communicationId((await context.params).id);
    const { data, error } = await admin.from("communication_messages").select(deliveryColumns).eq("id", id).maybeSingle();
    checkDatabaseError(error);
    if (!data) throw new AdminApiError("Communication not found.", 404);
    const roles = await emailRecipientRoles(admin, [id]);
    const { data: scheduled, error: scheduleError } = await admin.from("communication_email_schedule_state")
      .select("claimed_at,dispatch_started_at,finished_at,attempt_count,next_attempt_at,blocked_reason,outcome")
      .eq("message_id", id).maybeSingle();
    if (scheduleError?.code !== "42P01" && scheduleError?.code !== "PGRST205") checkDatabaseError(scheduleError);
    return Response.json({ delivery: { ...data, communication_recipients: data.communication_recipients.map(r => ({
      ...r, recipient_role: storedEmailRole(roles, r.id),
    })), scheduled_delivery: scheduled }, recipient_roles_available: roles.available });
  } catch (error) { return communicationError(error); }
}
