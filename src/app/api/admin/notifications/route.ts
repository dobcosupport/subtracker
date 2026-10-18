import { AdminApiError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { parseNotificationAutomation } from "@/lib/notifications";
import type { NotificationsConfiguration } from "@/types/notifications";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "view");
    const [channels, rules] = await Promise.all([
      admin.from("communication_channel_settings").select("channel,automated_enabled,revision"),
      admin.from("notification_reminder_rules").select("id,days_before_expiration,email_enabled,sms_enabled,template_reference,email_template_id,sms_template_id,revision,created_at,updated_at")
        .order("days_before_expiration", { ascending: false }).order("id"),
    ]);
    checkDatabaseError(channels.error); checkDatabaseError(rules.error);
    const email = channels.data?.find((row) => row.channel === "email");
    const sms = channels.data?.find((row) => row.channel === "sms");
    if (!email || !sms || !rules.data) throw new AdminApiError("Notification configuration is missing; apply the Notifications foundation migration.", 503);
    const result: NotificationsConfiguration = {
      automation: {
        email: { automated_enabled: email.automated_enabled, revision: email.revision },
        sms: { automated_enabled: sms.automated_enabled, revision: sms.revision },
      },
      rules: rules.data,
      execution_enabled: false,
    };
    return Response.json(result);
  } catch (error) { return communicationError(error); }
}

export async function PATCH(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const input = parseNotificationAutomation(await request.json());
    const { error } = await admin.rpc("save_notification_automation", { p_actor: profile.auth_user_id, p_input: input });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "NOTIFICATION_AUTOMATION_UPDATED", "notification_configuration", "automation", "Master Automation Controls", {
      changed_fields: ["email.automated_enabled", "sms.automated_enabled"],
    });
    return Response.json({ saved: true });
  } catch (error) { return communicationError(error); }
}
