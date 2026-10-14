import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, readJsonObject } from "@/lib/server-nj-pwc-sync";

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const body = await readJsonObject(request, ["request_key"]);
    if (typeof body.request_key !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_key)) {
      throw new AdminApiError("request_key must be a UUID.", 400);
    }
    const { data, error } = await admin.rpc("run_nj_pwc_daily_sync_now", {
      p_request_key: body.request_key,
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