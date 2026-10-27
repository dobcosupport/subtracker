import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";
import type { NjPwcExceptionCandidates } from "@/lib/nj-pwc-registry-fields";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");
    const id = positiveInt(new URL(request.url).searchParams.get("exception_id"));
    if (!id) throw new AdminApiError("exception_id must be a positive integer.", 400);
    const { data, error } = await admin.rpc("get_nj_pwc_exception_candidates", { p_exception_id: id });
    const failure = njPwcRpcError(error);
    if (failure) throw failure;
    return Response.json({ selection: firstRpcRow<NjPwcExceptionCandidates>(data) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    await requireModulePermission(request, "contractors", "manage");
    const body = await readJsonObject(request, ["exception_id", "search_request_id", "candidate_identity", "snapshot", "confirmed"]);
    const id = positiveInt(body.exception_id), requestId = positiveInt(body.search_request_id);
    if (!id || !requestId) throw new AdminApiError("A valid exception and search request are required.", 400);
    if (body.confirmed !== true) throw new AdminApiError("Explicit confirmation is required.", 400);
    if (typeof body.snapshot !== "string" || !/^[a-f0-9]{32}$/.test(body.snapshot)
      || typeof body.candidate_identity !== "string" || !/^[a-f0-9]{32}$/.test(body.candidate_identity)) {
      throw new AdminApiError("Select a stored candidate from the current results.", 400);
    }
    const { data, error } = await admin.rpc("select_nj_pwc_exception_match", {
      p_exception_id: id, p_request_id: requestId, p_candidate_identity: body.candidate_identity,
      p_snapshot: body.snapshot, p_confirmed: true,
      p_actor_id: profile.auth_user_id, p_actor_name: profile.name, p_actor_email: profile.email,
    });
    const failure = njPwcRpcError(error);
    if (failure) throw failure;
    const result = firstRpcRow<{ approval: string; review_reason: string | null; record_action: string;
      compliance_record_id: number | null; review_queue_id: number | null; already_processed?: boolean }>(data);
    const review = result.approval === "review_required" && result.review_queue_id != null;
    const applied = ["auto_approved", "refreshed"].includes(result.approval) && result.compliance_record_id != null;
    if (!review && !applied) throw new AdminApiError("NJ PWC selection returned no application or review outcome.", 503);
    const message = review
      ? `Sent to PWC Review${result.review_reason ? ` (${result.review_reason})` : ""}. The exception remains open pending review.`
      : `Synced NJ PWC compliance record ${result.record_action === "refreshed" ? "refreshed" : "applied"}; Multiple Matches resolved.`;
    return Response.json({ ok: true, ...result, message: `${result.already_processed ? "Already processed. " : ""}${message}` });
  } catch (error) { return jsonError(error); }
}
