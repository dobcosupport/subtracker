import "server-only";
import { AdminApiError, type AdminContext } from "@/lib/server-admin";
import { emailProviderPlan } from "@/lib/email-provider";
import { MicrosoftEmailError, microsoftIdentityStatus, sendMicrosoftEmail, type MicrosoftDiagnostic } from "@/lib/server-email-provider";
import { settingsColumns } from "@/lib/server-communications";
import type { ChannelSettings } from "@/types/communications";

type Admin = AdminContext["admin"];
export type EmailDeliveryOutcome = "accepted" | MicrosoftDiagnostic;
type EmailSendReservation = {
  id: string;
  subject: string;
  body: string;
  sender_address: string;
  reply_to_address: string | null;
  recipients: { email: string; recipient_role: "to" | "cc" | "bcc" }[];
};

export async function savedEmailSettings(admin: Admin): Promise<ChannelSettings> {
  const { data, error } = await admin.from("communication_channel_settings").select(settingsColumns).eq("channel", "email").single();
  if (error || !data) throw new AdminApiError("Unable to read saved Email configuration.", 503);
  return data as ChannelSettings;
}

export function assertEmailDeliveryReady(settings: ChannelSettings) {
  if (settings.provider !== "microsoft_365" || emailProviderPlan(settings, false).configuration_status !== "Ready for Testing") {
    throw new AdminApiError("Enable and complete the Microsoft Email configuration before sending.", 409);
  }
  if (microsoftIdentityStatus(settings) !== "Ready") {
    throw new AdminApiError("Server Email authentication is unavailable or does not match the saved Microsoft IDs.", 409);
  }
}

function reservation(value: unknown): EmailSendReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminApiError("Email send reservation returned invalid data. Review Communication Logs.", 503);
  }
  const result = value as Record<string, unknown>;
  if (typeof result.id !== "string" || typeof result.subject !== "string" || typeof result.body !== "string"
    || typeof result.sender_address !== "string" || (result.reply_to_address !== null && typeof result.reply_to_address !== "string")
    || !Array.isArray(result.recipients) || !result.recipients.length) {
    throw new AdminApiError("Email send reservation returned invalid data. Review Communication Logs.", 503);
  }
  const recipients: EmailSendReservation["recipients"] = [];
  for (const recipient of result.recipients) {
    if (!recipient || typeof recipient !== "object" || !("email" in recipient) || typeof recipient.email !== "string"
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient.email)) {
      throw new AdminApiError("Email send reservation returned invalid data. Review Communication Logs.", 503);
    }
    const role = "recipient_role" in recipient ? recipient.recipient_role : "to";
    if (role !== "to" && role !== "cc" && role !== "bcc") throw new AdminApiError("Invalid reserved recipient role. Review Communication Logs.", 503);
    recipients.push({ email: recipient.email, recipient_role: role });
  }
  return {
    id: result.id, subject: result.subject, body: result.body, sender_address: result.sender_address,
    reply_to_address: result.reply_to_address, recipients,
  };
}

export async function deliverReservedEmail(
  settings: ChannelSettings, value: unknown, messageId: string,
  finish: (outcome: EmailDeliveryOutcome) => Promise<void>,
): Promise<EmailDeliveryOutcome> {
  const reserved = reservation(value);
  if (reserved.id !== messageId || reserved.sender_address !== settings.from_address
    || reserved.reply_to_address !== settings.reply_to_address) {
    throw new AdminApiError(`Reserved Email sender or Communication ID changed. Review Logs for ${messageId}; do not retry.`, 409);
  }
  let outcome: EmailDeliveryOutcome = "accepted";
  try {
    await sendMicrosoftEmail(settings, {
      subject: reserved.subject, body: reserved.body,
      recipients: reserved.recipients.filter(r => r.recipient_role === "to").map(r => r.email),
      ccRecipients: reserved.recipients.filter(r => r.recipient_role === "cc").map(r => r.email),
      bccRecipients: reserved.recipients.filter(r => r.recipient_role === "bcc").map(r => r.email),
    });
  } catch (error) {
    outcome = error instanceof MicrosoftEmailError ? error.category : "outcome_unknown";
  }
  await finish(outcome);
  return outcome;
}
