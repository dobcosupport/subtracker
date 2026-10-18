import { AdminApiError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { invitationDeliveryPlan, parseInvitationEmailSettings } from "@/lib/invitation-email";

const columns = "enabled,delivery_mode,organization_name,application_name,subject,application_base_url,invitation_path,template_reference,template_content,sender_reference,reply_to_reference,revision";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "view");
    const { data, error } = await admin.from("user_invitation_email_settings").select(columns).eq("channel", "email").single();
    checkDatabaseError(error);
    if (!data) throw new AdminApiError("Invitation email settings are missing; apply the Step 5 invitation configuration migration.", 503);
    const settings = parseInvitationEmailSettings(data);
    return Response.json({ settings, delivery_plan: invitationDeliveryPlan(settings) });
  } catch (error) { return communicationError(error); }
}

export async function PATCH(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const input = parseInvitationEmailSettings(await request.json());
    const { error } = await admin.rpc("save_user_invitation_email_settings", { p_actor: profile.auth_user_id, p_input: input });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "INVITATION_EMAIL_SETTINGS_UPDATED", "invitation_email_settings", "email", "User Management Email configuration", {
      changed_fields: Object.keys(input).filter((key) => key !== "revision"),
    });
    return Response.json({ saved: true, revision: input.revision + 1 });
  } catch (error) { return communicationError(error); }
}
