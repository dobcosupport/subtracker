import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { CredentialStoreError, getProviderCredentialStatus, setProviderCredential } from "@/lib/server-provider-credentials";
import type { CommunicationChannel, CredentialProvider } from "@/types/communications";

export const runtime = "nodejs";
type Context = { params: Promise<{ channel: string }> };
const headers = { "Cache-Control": "no-store" };
function channelName(value: string): CommunicationChannel {
  if (value !== "email" && value !== "sms") throw new CredentialStoreError(400, "Unknown communications channel.");
  return value;
}
function providerName(request: Request, channel: CommunicationChannel): CredentialProvider {
  const provider = new URL(request.url).searchParams.get("provider") ?? "azure_communication_services";
  if (provider === "azure_communication_services" || (channel === "email" && provider === "microsoft_365")) return provider;
  throw new CredentialStoreError(400, "Unsupported credential provider or channel.");
}
function safeError(error: unknown): Response {
  if (error instanceof CredentialStoreError) return Response.json({ error: error.message }, { status: error.status, headers });
  if (error instanceof AdminApiError && [401, 403].includes(error.status)) {
    return Response.json({ error: error.status === 401 ? "Authentication is required." : "Settings permission is required." }, { status: error.status, headers });
  }
  return Response.json({ error: "Credential operation failed. An administrator must verify server configuration and access." }, { status: 503, headers });
}

export async function GET(request: Request, context: Context) {
  try {
    await requireModulePermission(request, "settings", "view");
    const channel = channelName((await context.params).channel);
    const configured = await getProviderCredentialStatus(providerName(request, channel), channel);
    return Response.json({ credential_configured: configured }, { headers });
  } catch (error) { return safeError(error); }
}

export async function PUT(request: Request, context: Context) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "manage");
    const channel = channelName((await context.params).channel);
    const provider = providerName(request, channel);
    const { data, error } = await admin.from("communication_channel_settings").select("provider").eq("channel", channel).single();
    if (error || !data) throw new CredentialStoreError(503, "Unable to verify the saved channel provider.");
    if (data.provider !== provider) throw new CredentialStoreError(409, "Save the selected credential provider as the channel provider first.");
    // Bound the streamed body as Content-Length is not trustworthy.
    const reader = request.body?.getReader();
    if (!reader) throw new CredentialStoreError(400, "Enter the provider credential.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8192) { await reader.cancel(); throw new CredentialStoreError(413, "Credential request is too large."); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let input: unknown;
    try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new CredentialStoreError(400, "Invalid credential request."); }
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== 1 || !("credential" in input)) {
      throw new CredentialStoreError(400, "Provide only the provider credential.");
    }
    await setProviderCredential(provider, channel, input.credential);
    return Response.json({ credential_configured: true }, { headers });
  } catch (error) { return safeError(error); }
}
