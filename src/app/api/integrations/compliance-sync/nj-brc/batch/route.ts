import { AdminApiError } from "@/lib/server-admin";
import { isUuid, njBrcBody, njBrcError, requireNjBrcWorkerAuth } from "@/lib/server-nj-brc-worker";

export async function GET(request: Request) {
  try {
    const auth = await requireNjBrcWorkerAuth(request);
    if (auth instanceof Response) return auth;
    const params = new URL(request.url).searchParams;
    if ([...params.keys()].some((key) => !["instance_id", "session_id"].includes(key))
      || params.getAll("instance_id").length !== 1 || params.getAll("session_id").length !== 1
      || !isUuid(params.get("instance_id")) || !isUuid(params.get("session_id"))) {
      throw new AdminApiError("instance_id and session_id must be UUIDs.", 400);
    }
    const { data, error } = await auth.admin.rpc("get_owned_nj_brc_batch", {
      p_instance: params.get("instance_id"), p_session: params.get("session_id"),
    });
    if (error) throw error;
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return njBrcError(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await requireNjBrcWorkerAuth(request);
    if (auth instanceof Response) return auth;
    const payload = await njBrcBody(request);
    if (Object.keys(payload).some((key) => !["instance_id", "session_id", "action", "request_id"].includes(key))
      || !isUuid(payload.instance_id) || !isUuid(payload.session_id)
      || !["next", "complete", "pause"].includes(String(payload.action))
      || (payload.action === "complete" ? !isUuid(payload.request_id) : payload.request_id !== undefined)) {
      throw new AdminApiError("Invalid attended NJ BRC batch action.", 400);
    }
    const { data, error } = await auth.admin.rpc("control_nj_brc_batch", {
      p_instance: payload.instance_id, p_session: payload.session_id,
      p_action: payload.action, p_request: payload.request_id ?? null,
    });
    if (error) throw error;
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return njBrcError(error);
  }
}
