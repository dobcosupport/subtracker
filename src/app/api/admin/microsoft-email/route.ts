import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { settingsColumns } from "@/lib/server-communications";
import { emailProviderPlan } from "@/lib/email-provider";
import { MicrosoftEmailError, microsoftIdentityStatus, sendMicrosoftTestEmail, testMicrosoftAuthentication } from "@/lib/server-email-provider";
import type { ChannelSettings } from "@/types/communications";
import type { MicrosoftEmailConnection } from "@/types/microsoft-email";
import { communicationId } from "@/lib/communications";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
type Admin = Awaited<ReturnType<typeof requireModulePermission>>["admin"];

async function savedSettings(admin: Admin): Promise<ChannelSettings> {
  const { data, error } = await admin.from("communication_channel_settings").select(settingsColumns).eq("channel", "email").single();
  if (error || !data) throw new AdminApiError("Unable to read saved Email configuration.", 503);
  return data as ChannelSettings;
}

function safeError(error: unknown): Response {
  if (error instanceof AdminApiError) return Response.json({ error: error.message }, { status: error.status, headers });
  return Response.json({ error: "Microsoft Email operation failed. No automatic retry was attempted." }, { status: 503, headers });
}

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "view");
    const settings = await savedSettings(admin);
    const { data, error } = await admin.from("microsoft_email_connection_state")
      .select("settings_revision,authentication_status,diagnostic_category,delivery_status").eq("channel", "email").maybeSingle();
    if (error) throw new AdminApiError("Unable to read Microsoft Email test state; apply the Step 6F migration.", 503);
    const identity = microsoftIdentityStatus(settings);
    const complete = settings.provider === "microsoft_365" && emailProviderPlan(settings, false).configuration_status === "Ready for Testing";
    const current = complete && identity === "Ready" && data?.settings_revision === settings.revision;
    const authentication = current ? data.authentication_status : "Not Tested";
    const delivery = current ? data.delivery_status : "Not Tested";
    const result: MicrosoftEmailConnection = {
      identity_status: identity, authentication_status: authentication,
      diagnostic_category: current ? data.diagnostic_category : null,
      delivery_status: delivery,
      overall_status: authentication !== "Verified" ? "Not Verified" : delivery === "Accepted by Graph" ? "Verified" : "Ready for Test Email",
      can_test: complete && identity === "Ready", can_send_test: current && authentication === "Verified" && delivery !== "In Progress",
    };
    return Response.json(result, { headers });
  } catch (error) { return safeError(error); }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    // Only small, non-secret action/recipient inputs are accepted.
    const reader = request.body?.getReader();
    if (!reader) throw new AdminApiError("Test action is required.", 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 2048) { await reader.cancel(); throw new AdminApiError("Test request is too large.", 413); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const body = Buffer.concat(chunks).toString("utf8");
    let input: unknown;
    try { input = JSON.parse(body); } catch { throw new AdminApiError("Invalid test request.", 400); }
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminApiError("Invalid test request.", 400);
    const values = input as Record<string, unknown>;
    if (Object.keys(values).some((key) => !["action", "revision", "recipient", "request_id", "confirmed"].includes(key))) throw new AdminApiError("Unsupported test field.", 400);
    const settings = await savedSettings(admin);
    if (values.revision !== settings.revision) throw new AdminApiError("Email settings changed; refresh before testing.", 409);
    if (settings.provider !== "microsoft_365" || emailProviderPlan(settings, false).configuration_status !== "Ready for Testing") {
      throw new AdminApiError("Save and enable the Microsoft Email configuration first.", 409);
    }
    if (values.action === "authenticate") {
      let category: "identity_configuration" | "authentication_failed" | null = null;
      try { await testMicrosoftAuthentication(settings); }
      catch (error) { category = error instanceof MicrosoftEmailError && error.category === "identity_configuration" ? "identity_configuration" : "authentication_failed"; }
      const { error } = await admin.rpc("record_microsoft_authentication", {
        p_actor: profile.auth_user_id, p_revision: settings.revision, p_category: category,
      });
      if (error) throw new AdminApiError("Authentication test result could not be saved; refresh and test again.", 409);
      return Response.json({ authentication_status: category ? "Test Failed" : "Verified", diagnostic_category: category }, { headers });
    }
    if (values.action !== "send_test" || values.confirmed !== true || typeof values.recipient !== "string"
      || values.recipient.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.recipient)) {
      throw new AdminApiError("Explicit recipient and confirmation of real Email delivery are required.", 400);
    }
    if (microsoftIdentityStatus(settings) !== "Ready") throw new AdminApiError("Server identity configuration is unavailable or does not match saved IDs.", 409);
    let id: string;
    try { id = communicationId(String(values.request_id)); } catch { throw new AdminApiError("A valid unique test request ID is required.", 400); }
    const { error: reserveError } = await admin.rpc("reserve_microsoft_test_email", {
      p_actor: profile.auth_user_id, p_revision: settings.revision, p_request_id: id, p_recipient: values.recipient,
    });
    if (reserveError) throw new AdminApiError("Test Email was not started. Authenticate first, check for an existing request, and refresh settings.", 409);
    let outcome = "accepted";
    try { await sendMicrosoftTestEmail(settings, values.recipient); }
    catch (error) { outcome = error instanceof MicrosoftEmailError ? error.category : "outcome_unknown"; }
    const { error: finishError } = await admin.rpc("finish_microsoft_test_email", {
      p_actor: profile.auth_user_id, p_revision: settings.revision, p_message_id: id, p_outcome: outcome,
    });
    if (finishError) throw new AdminApiError(`Provider outcome could not be recorded for Communication ${id}. Check Logs; do not retry automatically.`, 503);
    return Response.json({ communication_id: id, outcome, status: outcome === "accepted" ? "Sent" : "Failed",
      receipt_confirmed: false }, { headers, status: outcome === "accepted" ? 200 : 502 });
  } catch (error) { return safeError(error); }
}
