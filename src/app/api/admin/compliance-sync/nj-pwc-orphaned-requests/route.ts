import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, optionalText, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";

function configuredAgeThreshold(): number {
  const value = Number(process.env.NJ_PWC_ORPHANED_REQUEST_AGE_MINUTES ?? "10");
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new AdminApiError("NJ PWC orphan age must be an integer between 1 and 1440 minutes.", 503);
  }
  return value;
}

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "manage");
    const age = configuredAgeThreshold();
    const { data, error } = await admin.rpc("list_orphaned_nj_pwc_requests", { p_min_age_minutes: age });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    if (!Array.isArray(data)) throw new AdminApiError("Invalid NJ PWC orphan list response.", 500);
    return Response.json({
      requests: data.map((row) => ({
        request_id: row.id, contractor_id: row.contractor_id, contractor: row.searched_company_name,
        status: row.status, worker_instance_id: row.worker_instance_id, claimed_at: row.claimed_at,
      })),
      age_threshold_minutes: age,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const body = await readJsonObject(request, ["request_id", "action", "confirmed", "note"]);
    const requestId = positiveInt(body.request_id);
    if (!requestId) throw new AdminApiError("request_id must be a positive integer.", 400);
    if (!["fail", "retry", "resolve"].includes(String(body.action))) throw new AdminApiError("Invalid recovery action.", 400);
    if (body.confirmed !== true) throw new AdminApiError("Explicit confirmation is required.", 400);
    const { data, error } = await admin.rpc("recover_orphaned_nj_pwc_request", {
      p_request_id: requestId, p_action: body.action, p_min_age_minutes: configuredAgeThreshold(),
      p_actor_id: profile.auth_user_id, p_actor_name: profile.name, p_actor_email: profile.email,
      p_note: optionalText(body.note, "note", 1000),
    });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    return Response.json({ ok: true, request: firstRpcRow(data) });
  } catch (error) { return jsonError(error); }
}
