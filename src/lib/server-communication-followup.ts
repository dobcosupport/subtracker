import "server-only";
import { AdminApiError, type AdminContext } from "@/lib/server-admin";
import { readTemplateRenderContext, renderTemplateContent } from "@/lib/server-template-rendering";

type Admin = AdminContext["admin"];
export interface FollowupResult { state: "not_configured" | "pending" | "recoverable" | "completed"; followup_id?: number | null; error?: string | null }
export async function processCommunicationFollowup(admin: Admin, id: string): Promise<FollowupResult> {
  const { data, error } = await admin.from("communication_followup_actions").select("snapshot,state,followup_id").eq("message_id", id).maybeSingle();
  // Graph acceptance has already been recorded; errors here must never turn Sent into a retryable email.
  if (error) return { state: "recoverable", error: "Email was accepted. Follow-Up status is unavailable; retry Follow-Up processing only." };
  if (!data) return { state: "not_configured" };
  if (data.state === "completed") return { state: "completed", followup_id: data.followup_id };
  let subject: string | null = null, reason: string | null = null;
  try { subject = renderTemplateContent("", "", readTemplateRenderContext(data.snapshot)).followup_subject; }
  catch (error) { reason = error instanceof Error ? error.message : "Reviewed Follow-Up context could not be rendered."; }
  const result = await admin.rpc("process_communication_followup", { p_message: id, p_subject: subject, p_error: reason });
  if (result.error) return { state: "recoverable", error: "Email was accepted. Follow-Up processing is pending recovery; do not resend." };
  const value = result.data;
  if (!value || !["completed", "recoverable", "not_configured"].includes(value.state)) {
    throw new AdminApiError("Email was accepted but Follow-Up completion could not be verified. Do not resend.", 503);
  }
  return value;
}
export async function recoverCommunicationFollowups(admin: Admin) {
  const { data, error } = await admin.from("communication_followup_actions").select("message_id").in("state", ["pending", "recoverable"])
    .order("updated_at").order("message_id").limit(20);
  if (error) throw new AdminApiError("Unable to read recoverable Follow-Up actions. No email was resent.", 503);
  const results: FollowupResult[] = [];
  for (const action of data ?? []) results.push(await processCommunicationFollowup(admin, action.message_id));
  return results;
}
