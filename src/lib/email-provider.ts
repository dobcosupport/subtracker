import type { ChannelSettingsInput, EmailConnectionStatus, EmailProvider } from "@/types/communications";

// Configuration readiness is not a provider test and can never establish Verified.
export function emailProviderPlan(settings: ChannelSettingsInput, credentialConfigured: boolean): {
  adapter: EmailProvider | null;
  authentication: "vercel_oidc" | "connection_string" | null;
  connection_status: EmailConnectionStatus;
  configuration_status: "Incomplete" | "Credential Required" | "Ready for Testing";
  connector_implemented: boolean;
  test_enabled: false;
  send_enabled: false;
} {
  const adapter = settings.provider === "microsoft_365" || settings.provider === "azure_communication_services" ? settings.provider : null;
  const sender = Boolean(settings.from_address && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.from_address));
  const uuid = (value: string | null | undefined) => Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value));
  const complete = adapter && settings.enabled && sender
    && (adapter !== "microsoft_365" || (uuid(settings.microsoft_tenant_id) && uuid(settings.microsoft_client_id)));
  const ready = complete && (adapter === "microsoft_365" || credentialConfigured);
  return {
    adapter, authentication: adapter === "microsoft_365" ? "vercel_oidc" : adapter ? "connection_string" : null,
    connection_status: ready ? "Ready for Testing" : "Not Configured",
    configuration_status: !complete ? "Incomplete" : ready ? "Ready for Testing" : "Credential Required",
    connector_implemented: adapter === "microsoft_365", test_enabled: false, send_enabled: false,
  };
}
