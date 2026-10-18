import { requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { parseReminderRule } from "@/lib/notifications";

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const input = parseReminderRule(await request.json(), false);
    const { data, error } = await admin.rpc("save_notification_reminder", { p_actor: profile.auth_user_id, p_id: null, p_input: input, p_remove: false });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "NOTIFICATION_REMINDER_CREATED", "notification_reminder", data, `${input.days_before_expiration} Days Before Expiration`, {
      changed_fields: Object.keys(input),
    });
    return Response.json({ id: data }, { status: 201 });
  } catch (error) { return communicationError(error); }
}
