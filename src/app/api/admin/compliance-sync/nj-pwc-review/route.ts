import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, optionalText, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";

// Manual NJ PWC review decisions. Approval/rejection, compliance-record
// versioning, exception resolution, and auditing all run inside a single
// SECURITY DEFINER transaction (approve_nj_pwc_review / reject_nj_pwc_review).
export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const payload = await readJsonObject(request, ["review_id", "decision", "notes"]);
    const reviewId = positiveInt(payload.review_id);
    if (!reviewId) throw new AdminApiError("review_id must be a positive integer.", 400);
    if (payload.decision !== "approved" && payload.decision !== "rejected") {
      throw new AdminApiError("decision must be approved or rejected.", 400);
    }
    const notes = optionalText(payload.notes, "notes");
    if (payload.decision === "rejected" && !notes) throw new AdminApiError("A rejection reason is required.", 400);

    const actor = { p_actor_id: profile.auth_user_id, p_actor_name: profile.name, p_actor_email: profile.email };
    const { data, error } = payload.decision === "approved"
      ? await admin.rpc("approve_nj_pwc_review", { p_review_id: reviewId, ...actor, p_notes: notes })
      : await admin.rpc("reject_nj_pwc_review", { p_review_id: reviewId, ...actor, p_reason: notes });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    const row = firstRpcRow<{ compliance_record_id?: number | null; record_action?: string | null }>(data);
    return Response.json({
      ok: true,
      decision: payload.decision,
      compliance_record_id: row?.compliance_record_id ?? null,
      record_action: row?.record_action ?? null,
    });
  } catch (error) {
    return jsonError(error);
  }
}