import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { assertEmailDeliveryReady, deliverReservedEmail, savedEmailSettings } from "@/lib/server-communication-email-delivery";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";

export const runtime = "nodejs";
const headers = { "Cache-Control": "no-store" };
type Context = { params: Promise<{ id: string }> };
async function confirmedSend(request: Request): Promise<number> {
  const reader = request.body?.getReader();
  if (!reader) throw new AdminApiError("Explicit confirmation and reviewed Draft revision are required.", 400);
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
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AdminApiError("Explicit confirmation and reviewed Draft revision are required.", 400);
  const values = input as Record<string, unknown>;
  if (values.confirmed !== true || Object.keys(values).some(key => !["confirmed", "revision"].includes(key))
    || typeof values.revision !== "number" || !Number.isSafeInteger(values.revision) || values.revision < 1 || values.revision > 2147483647) {
    throw new AdminApiError("Explicit confirmation and reviewed Draft revision are required.", 400);
  }
  return values.revision;
}

export async function POST(request: Request, context: Context) {
  let messageId: string | null = null;
  try {
    const { admin, profile } = await requireModulePermission(request, "communications_delivery", "manage");
    const revision = await confirmedSend(request);
    messageId = communicationId((await context.params).id);
    const settings = await savedEmailSettings(admin);
    assertEmailDeliveryReady(settings);
    const { data, error } = await admin.rpc("reserve_reviewed_communication_email_send", {
      p_actor: profile.auth_user_id, p_message_id: messageId, p_settings_revision: settings.revision, p_message_revision: revision,
    });
    checkDatabaseError(error);
    const outcome = await deliverReservedEmail(settings, data, messageId, async result => {
      const { error: finishError } = await admin.rpc("finish_communication_email_send", {
        p_actor: profile.auth_user_id, p_message_id: messageId, p_outcome: result,
      });
      if (finishError) {
        throw new AdminApiError(`Email outcome could not be recorded for Communication ${messageId}. Check Logs before any further action.`, 503);
      }
    });
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
