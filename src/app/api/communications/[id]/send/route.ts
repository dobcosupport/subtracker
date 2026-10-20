import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { emailProviderPlan } from "@/lib/email-provider";
import { MicrosoftEmailError, microsoftIdentityStatus, sendMicrosoftEmail } from "@/lib/server-email-provider";
import { checkDatabaseError, communicationError, settingsColumns } from "@/lib/server-communications";
import type { ChannelSettings } from "@/types/communications";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };
type Admin = Awaited<ReturnType<typeof requireModulePermission>>["admin"];
type EmailSendReservation = {
  id: string;
  subject: string;
  body: string;
  sender_address: string;
  reply_to_address: string | null;
  recipients: { email: string }[];
};

async function savedEmailSettings(admin: Admin): Promise<ChannelSettings> {
  const { data, error } = await admin.from("communication_channel_settings").select(settingsColumns).eq("channel", "email").single();
  if (error || !data) throw new AdminApiError("Unable to read saved Email configuration.", 503);
  return data as ChannelSettings;
}

function reservation(value: unknown): EmailSendReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminApiError("Email send reservation returned invalid data. Review Communication Logs.", 503);
  }
  const result = value as Record<string, unknown>;
  if (typeof result.id !== "string" || typeof result.subject !== "string" || typeof result.body !== "string"
    || typeof result.sender_address !== "string" || (result.reply_to_address !== null && typeof result.reply_to_address !== "string")
    || !Array.isArray(result.recipients) || result.recipients.length < 1 || result.recipients.length > 100) {
    throw new AdminApiError("Email send reservation returned invalid data. Review Communication Logs.", 503);
  }
  const recipients: EmailSendReservation["recipients"] = [];
  for (const recipient of result.recipients) {
  if (!recipient || typeof recipient !== "object" || !("email" in recipient) || typeof recipient.email !== "string"
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)) {
    throw new AdminApiError("Email send reservation returned invalid data. Review Communication Logs.", 503);
  }
    recipients.push({ email: recipient.email });
  }
  return {
    id: result.id, subject: result.subject, body: result.body, sender_address: result.sender_address,
    reply_to_address: result.reply_to_address, recipients,
  };
}

async function confirmedSend(request: Request): Promise<boolean> {
  const reader = request.body?.getReader();
  if (!reader) return false;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 256) {
        await reader.cancel();
        throw new AdminApiError("Send confirmation request is too large.", 413);
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let input: unknown;
  try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new AdminApiError("Explicit confirmation is required to send this Email.", 400); }
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const values = input as Record<string, unknown>;
  return values.confirmed === true && Object.keys(values).length === 1;
}

export async function POST(request: Request, context: Context) {
  let messageId: string | null = null;
  try {
    const { admin, profile } = await requireModulePermission(request, "communications_delivery", "manage");
    if (!await confirmedSend(request)) throw new AdminApiError("Confirm the deliberate Email send before continuing.", 400);
    messageId = communicationId((await context.params).id);
    const settings = await savedEmailSettings(admin);
    if (settings.provider !== "microsoft_365" || emailProviderPlan(settings, false).configuration_status !== "Ready for Testing") {
      throw new AdminApiError("Enable and complete the Microsoft Email configuration before sending.", 409);
    }
    if (microsoftIdentityStatus(settings) !== "Ready") {
      throw new AdminApiError("Server Vercel OIDC identity is unavailable or does not match the saved Microsoft IDs.", 409);
    }
    const { data, error } = await admin.rpc("reserve_communication_email_send", {
      p_actor: profile.auth_user_id, p_message_id: messageId, p_settings_revision: settings.revision,
    });
    checkDatabaseError(error);
    const reserved = reservation(data);
    if (reserved.id !== messageId || reserved.sender_address !== settings.from_address
      || reserved.reply_to_address !== settings.reply_to_address) {
      throw new AdminApiError(`Reserved Email sender or Communication ID changed. Review Logs for ${messageId}; do not retry.`, 409);
    }
    let outcome: "accepted" | "graph_rejected" | "outcome_unknown" | "authentication_failed" | "identity_configuration" = "accepted";
    try {
      await sendMicrosoftEmail(settings, {
        subject: reserved.subject, body: reserved.body, recipients: reserved.recipients.map((recipient) => recipient.email),
      });
    } catch (error) {
      outcome = error instanceof MicrosoftEmailError ? error.category : "outcome_unknown";
    }
    const { error: finishError } = await admin.rpc("finish_communication_email_send", {
      p_actor: profile.auth_user_id, p_message_id: messageId, p_outcome: outcome,
    });
    if (finishError) {
      throw new AdminApiError(`Email outcome could not be recorded for Communication ${messageId}. Check Logs before any further action.`, 503);
    }
    if (outcome !== "accepted") {
      throw new AdminApiError(outcome === "outcome_unknown"
        ? `Email outcome is unknown for Communication ${messageId}. Review Logs and mailbox; do not retry automatically.`
        : `Email send failed for Communication ${messageId} (${outcome}). Review Logs before any further action.`, 502);
    }
    return Response.json({ communication_id: messageId, status: "Sent", graph_acceptance: "Accepted", delivered: false }, { headers });
  } catch (error) {
    const response = communicationError(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
