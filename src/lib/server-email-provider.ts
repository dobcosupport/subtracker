import "server-only";
import { CredentialStoreError, getProviderCredential } from "@/lib/server-provider-credentials";
import { emailProviderPlan } from "@/lib/email-provider";
import type { ChannelSettingsInput } from "@/types/communications";
import { createVercelOidcCredential } from "@/lib/server-entra-identity";

type EmailAdapterConfiguration =
  | { provider: "microsoft_365"; authentication: "vercel_oidc"; tenantId: string; clientId: string; senderMailbox: string }
  | { provider: "azure_communication_services"; authentication: "connection_string"; connectionString: string; senderMailbox: string };

// Preparing configuration does not acquire a token or contact a provider.
export async function prepareEmailAdapter(settings: ChannelSettingsInput): Promise<EmailAdapterConfiguration> {
  const plan = emailProviderPlan(settings, true);
  if (!plan.adapter || plan.connection_status !== "Ready for Testing" || !settings.from_address) {
    throw new CredentialStoreError(409, "Complete and enable the Email provider configuration first.");
  }
  if (plan.adapter === "microsoft_365" && settings.microsoft_tenant_id && settings.microsoft_client_id) {
    if (microsoftIdentityStatus(settings) !== "Ready") throw new MicrosoftEmailError("identity_configuration");
    return { provider: "microsoft_365", authentication: "vercel_oidc", tenantId: settings.microsoft_tenant_id,
      clientId: settings.microsoft_client_id, senderMailbox: settings.from_address };
  }
  const credential = await getProviderCredential(plan.adapter, "email");
  return { provider: "azure_communication_services", authentication: "connection_string", connectionString: credential, senderMailbox: settings.from_address };
}

export type MicrosoftDiagnostic = "identity_configuration" | "authentication_failed" | "graph_rejected" | "outcome_unknown";
export class MicrosoftEmailError extends Error {
  constructor(public readonly category: MicrosoftDiagnostic) { super(category); }
}

export function microsoftIdentityStatus(settings: ChannelSettingsInput): "Ready" | "Unavailable" | "Identity Mismatch" {
  if (process.env.AZURE_KEY_VAULT_AUTH_MODE !== "vercel_oidc" || !process.env.AZURE_TENANT_ID || !process.env.AZURE_CLIENT_ID) return "Unavailable";
  return settings.microsoft_tenant_id?.toLowerCase() === process.env.AZURE_TENANT_ID.toLowerCase()
    && settings.microsoft_client_id?.toLowerCase() === process.env.AZURE_CLIENT_ID.toLowerCase() ? "Ready" : "Identity Mismatch";
}

async function graphToken(settings: ChannelSettingsInput): Promise<string> {
  const configuration = await prepareEmailAdapter(settings);
  if (configuration.provider !== "microsoft_365") throw new MicrosoftEmailError("identity_configuration");
  try {
    const credential = createVercelOidcCredential(configuration.tenantId, configuration.clientId);
    const token = await credential.getToken("https://graph.microsoft.com/.default", { abortSignal: AbortSignal.timeout(15000) });
    if (!token?.token || token.expiresOnTimestamp <= Date.now()) throw new MicrosoftEmailError("authentication_failed");
    return token.token;
  } catch { throw new MicrosoftEmailError("authentication_failed"); }
}

export async function testMicrosoftAuthentication(settings: ChannelSettingsInput): Promise<void> {
  await graphToken(settings);
}

export async function sendMicrosoftEmail(
  settings: ChannelSettingsInput,
  message: { subject: string; body: string; recipients: string[] },
): Promise<void> {
  const token = await graphToken(settings);
  let response: Response;
  try {
    response = await fetch(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(settings.from_address!)}/sendMail`, {
      method: "POST", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ message: {
        subject: message.subject,
        body: { contentType: "Text", content: message.body },
        toRecipients: message.recipients.map((address) => ({ emailAddress: { address } })),
        ...(settings.reply_to_address ? { replyTo: [{ emailAddress: { address: settings.reply_to_address } }] } : {}),
      }, saveToSentItems: true }),
    });
  } catch { throw new MicrosoftEmailError("outcome_unknown"); }
  if (response.status === 202) return;
  if (response.status >= 500) throw new MicrosoftEmailError("outcome_unknown");
  throw new MicrosoftEmailError("graph_rejected");
}

export async function sendMicrosoftTestEmail(settings: ChannelSettingsInput, recipient: string): Promise<void> {
  return sendMicrosoftEmail(settings, {
    subject: MICROSOFT_TEST_SUBJECT, body: MICROSOFT_TEST_BODY, recipients: [recipient],
  });
}

export const MICROSOFT_TEST_SUBJECT = "SubTracker Email connection test";
export const MICROSOFT_TEST_BODY = "This is a deliberately requested SubTracker Email connection test. Microsoft Graph acceptance does not confirm recipient delivery or reading.";
