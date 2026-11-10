import { AdminApiError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { configurationStatus, parseChannelSettings } from "@/lib/communications";
import { checkDatabaseError, communicationError, settingsColumns } from "@/lib/server-communications";
import type { ChannelSettingsInput, CommunicationChannel } from "@/types/communications";
import { emailWorkspaceControls } from "@/lib/server-email-workspace";

type Context = { params: Promise<{ channel: string }> };
function channelName(value: string): CommunicationChannel {
  if (value !== "email" && value !== "sms") throw new AdminApiError("Unknown communications channel.", 400);
  return value;
}
export async function GET(request: Request, context: Context) {
  try {
    const actor = await requireModulePermission(request, "settings", "view");
    const { admin } = actor;
    const channel = channelName((await context.params).channel);
    const { data, error } = await admin.from("communication_channel_settings").select(settingsColumns).eq("channel", channel).single();
    checkDatabaseError(error);
    if (!data) throw new AdminApiError("Channel settings are missing; apply the Step 5 migration.", 503);
    const controls = channel === "email" ? await emailWorkspaceControls(actor) : null;
    return Response.json({ settings: { ...data,
      ...(controls?.available ? { contractor_email_enabled: controls.contractor_email_enabled, internal_email_enabled: controls.internal_email_enabled } : {}),
      configuration_status: configurationStatus(data as ChannelSettingsInput, channel) },
      ...(controls ? { email_controls: controls } : {}) });
  } catch (error) { return communicationError(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const channel = channelName((await context.params).channel);
    const input = parseChannelSettings(channel, await request.json());
    const { error } = await admin.rpc("save_communication_settings", { p_actor: profile.auth_user_id, p_channel: channel, p_input: input });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "COMMUNICATION_SETTINGS_UPDATED", "communication_settings", channel, `${channel} configuration`, { changed_fields: Object.keys(input).filter((key) => key !== "revision") });
    return Response.json({ saved: true, revision: input.revision + 1 });
  } catch (error) { return communicationError(error); }
}
