import { CommunicationInputError } from "@/lib/communications";
import type { InvitationDeliveryPlan, InvitationEmailSettingsInput } from "@/types/invitation-email";

export const invitationTemplateFields = ["organization_name", "invitee_name", "invitation_url", "application_name"] as const;
const textFields = ["organization_name", "application_name", "subject", "application_base_url", "invitation_path", "template_reference", "template_content", "sender_reference", "reply_to_reference"] as const;

export function parseInvitationEmailSettings(value: unknown): InvitationEmailSettingsInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommunicationInputError("Expected invitation email settings.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !["enabled", "delivery_mode", "revision", ...textFields].includes(key))) throw new CommunicationInputError("Unsupported invitation settings field.");
  if (typeof input.enabled !== "boolean") throw new CommunicationInputError("Invitation Email Enabled must be true or false.");
  if (input.delivery_mode !== "supabase_auth" && input.delivery_mode !== "application_email_provider") throw new CommunicationInputError("Choose a supported invitation delivery mode.");
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 2147483647) throw new CommunicationInputError("Invalid invitation settings revision.");
  const readText = (field: typeof textFields[number]): string | null => {
    const item = input[field];
    if (item == null || item === "") return null;
    const limit = field === "template_content" ? 10000 : field === "application_base_url" ? 2048 : 500;
    if (typeof item !== "string" || item.length > limit) throw new CommunicationInputError(`${field} must be text of at most ${limit} characters.`);
    return field === "template_content" ? item : item.trim() || null;
  };
  const settings: InvitationEmailSettingsInput = {
    enabled: input.enabled, delivery_mode: input.delivery_mode, revision: input.revision,
    organization_name: readText("organization_name"), application_name: readText("application_name"),
    subject: readText("subject"), application_base_url: readText("application_base_url"), invitation_path: readText("invitation_path"),
    template_reference: readText("template_reference"), template_content: readText("template_content"),
    sender_reference: readText("sender_reference"), reply_to_reference: readText("reply_to_reference"),
  };
  if (settings.application_base_url) {
    let url: URL;
    try { url = new URL(settings.application_base_url); }
    catch { throw new CommunicationInputError("Enter an absolute HTTP or HTTPS Application Base URL."); }
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new CommunicationInputError("Application Base URL must be an HTTP or HTTPS origin without credentials, path, query, or fragment.");
  }
  if (settings.invitation_path && (!/^\/(?!\/)[^\s\\?#]*$/.test(settings.invitation_path) || /[\r\n]/.test(settings.invitation_path))) throw new CommunicationInputError("Invitation Path must be a local absolute path without a host, query, or fragment.");
  if (settings.subject && /[\r\n]/.test(settings.subject)) throw new CommunicationInputError("Invitation Subject must be a single line.");
  return settings;
}

// Planning only: no dispatcher, token generation, template rendering, or delivery in Step 5.
export function invitationDeliveryPlan(settings: InvitationEmailSettingsInput): InvitationDeliveryPlan {
  return {
    configured_adapter: settings.delivery_mode,
    connector_status: settings.delivery_mode === "supabase_auth" ? "Externally Managed" : "Not Implemented",
    active_delivery_mode: "supabase_auth",
    configuration_only: true,
  };
}
