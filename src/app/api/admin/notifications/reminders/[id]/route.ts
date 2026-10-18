import { requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { parseReminderRemoval, parseReminderRule } from "@/lib/notifications";

type Context = { params: Promise<{ id: string }> };
export async function PATCH(request: Request, context: Context) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const id = communicationId((await context.params).id);
    const input = parseReminderRule(await request.json(), true);
    const { error } = await admin.rpc("save_notification_reminder", { p_actor: profile.auth_user_id, p_id: id, p_input: input, p_remove: false });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "NOTIFICATION_REMINDER_UPDATED", "notification_reminder", id, `${input.days_before_expiration} Days Before Expiration`, {
      changed_fields: Object.keys(input).filter((key) => key !== "revision"),
    });
    return Response.json({ saved: true });
  } catch (error) { return communicationError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const id = communicationId((await context.params).id);
    const revision = parseReminderRemoval(await request.json());
    const { error } = await admin.rpc("save_notification_reminder", { p_actor: profile.auth_user_id, p_id: id, p_input: { revision }, p_remove: true });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "NOTIFICATION_REMINDER_REMOVED", "notification_reminder", id, "Removed reminder configuration");
    return Response.json({ removed: true });
  } catch (error) { return communicationError(error); }
}
