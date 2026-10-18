import "server-only";
import { CredentialStoreError, getProviderCredential } from "@/lib/server-provider-credentials";
import { emailProviderPlan } from "@/lib/email-provider";
import type { ChannelSettingsInput } from "@/types/communications";

type EmailAdapterConfiguration =
  | { provider: "microsoft_365"; authentication: "application_client_secret"; tenantId: string; clientId: string; clientSecret: string; senderMailbox: string }
  | { provider: "azure_communication_services"; authentication: "connection_string"; connectionString: string; senderMailbox: string };

// Server adapter boundary only. No SDK client, token acquisition, test or dispatch occurs here.
export async function prepareEmailAdapter(settings: ChannelSettingsInput): Promise<EmailAdapterConfiguration> {
  const plan = emailProviderPlan(settings, true);
  if (!plan.adapter || plan.connection_status !== "Ready for Testing" || !settings.from_address) {
    throw new CredentialStoreError(409, "Complete and enable the Email provider configuration first.");
  }
  const credential = await getProviderCredential(plan.adapter, "email");
  if (plan.adapter === "microsoft_365" && settings.microsoft_tenant_id && settings.microsoft_client_id) {
    return { provider: "microsoft_365", authentication: "application_client_secret", tenantId: settings.microsoft_tenant_id,
      clientId: settings.microsoft_client_id, clientSecret: credential, senderMailbox: settings.from_address };
  }
  return { provider: "azure_communication_services", authentication: "connection_string", connectionString: credential, senderMailbox: settings.from_address };
}
