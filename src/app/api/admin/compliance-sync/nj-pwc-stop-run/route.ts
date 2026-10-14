import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";

// =====================================================================
// NJ PWC Graceful Stop Run
//
// POST { run_id }
//   Requests a batch-boundary stop for the specific active NJ PWC automatic
//   run. Idempotent: repeating the request for the same run reports the
//   existing stop request. The in-flight search finishes normally; unstarted
//   searches are never claimed. The run is recorded as Cancelled once no
//   active automatic work remains.
// =====================================================================

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const body = await readJsonObject(request, ["run_id"]);
    const runId = positiveInt(body.run_id);
    if (!runId) throw new AdminApiError("run_id must be a positive integer.", 400);
    const { data, error } = await admin.rpc("request_nj_pwc_daily_run_stop", {
      p_run_id: runId,
      p_actor_id: profile.auth_user_id,
      p_actor_name: profile.name,
      p_actor_email: profile.email,
    });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    return Response.json({ ok: true, ...firstRpcRow<Record<string, unknown>>(data) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}
