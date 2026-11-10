import "server-only";
import { AdminApiError, type AdminContext } from "@/lib/server-admin";
import { assertEmailDeliveryReady, deliverReservedEmail, savedEmailSettings } from "@/lib/server-communication-email-delivery";
import { checkDatabaseError } from "@/lib/server-communications";

type Admin = AdminContext["admin"];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Claim = { id: string; claim_token: string };
function claims(value: unknown): Claim[] {
  if (!Array.isArray(value)) throw new AdminApiError("Scheduled Email claims could not be verified.", 503);
  return value.map(item => {
    if (!item || typeof item !== "object" || typeof item.id !== "string" || !uuid.test(item.id)
      || typeof item.claim_token !== "string" || !uuid.test(item.claim_token)) {
      throw new AdminApiError("Scheduled Email claim could not be verified.", 503);
    }
    return { id: item.id, claim_token: item.claim_token };
  });
}

// Hosting-specific authentication and wake-up cadence belong to the trigger,
// never to this service. Supabase owns claims, policy and current eligibility.
export async function processScheduledEmail(admin: Admin) {
  const { data, error } = await admin.rpc("claim_due_scheduled_communications");
  checkDatabaseError(error);
  const result = { claimed: 0, sent: 0, blocked: 0, deferred: 0, failed: 0, superseded: 0 };
  for (const claim of claims(data)) {
    result.claimed++;
    let settings: Awaited<ReturnType<typeof savedEmailSettings>>;
    try {
      settings = await savedEmailSettings(admin);
      // Disabled business controls are evaluated by the final SQL reservation,
      // not treated as infrastructure failures which exhaust retry attempts.
      if (settings.enabled && settings.automated_enabled) assertEmailDeliveryReady(settings);
    } catch (error) {
      const { error: deferError } = await admin.rpc("defer_scheduled_communication_email", {
        p_message: claim.id, p_claim: claim.claim_token,
        p_reason: error instanceof AdminApiError ? error.message : "Email delivery preparation failed. Review server configuration.",
        p_blocked: false,
      });
      if (deferError?.code === "PT409") { result.superseded++; continue; }
      checkDatabaseError(deferError);
      result.deferred++;
      continue;
    }
    const { data: reserved, error: reserveError } = await admin.rpc("reserve_scheduled_communication_email", {
      p_message: claim.id, p_claim: claim.claim_token, p_settings_revision: settings.revision,
    });
    if (reserveError?.code === "PT409") { result.superseded++; continue; }
    checkDatabaseError(reserveError);
    if (!reserved || typeof reserved.blocked !== "boolean") {
      throw new AdminApiError("Scheduled Email reservation could not be verified. Do not retry delivery.", 503);
    }
    if (reserved.blocked) { result.blocked++; continue; }
    const outcome = await deliverReservedEmail(settings, reserved.reservation, claim.id, async outcome => {
      const { error: finishError } = await admin.rpc("finish_scheduled_communication_email", {
        p_message: claim.id, p_claim: claim.claim_token, p_outcome: outcome,
      });
      if (finishError) {
        throw new AdminApiError(`Scheduled Email outcome could not be recorded for ${claim.id}. Review history and mailbox; do not resend.`, 503);
      }
    });
    if (outcome === "accepted") result.sent++;
    else result.failed++;
  }
  return result;
}
