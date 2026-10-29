import { isUuid, njBrcBody, njBrcError, requireNjBrcWorkerAuth } from "@/lib/server-nj-brc-worker";

export async function POST(request: Request) {
  try {
    const auth = await requireNjBrcWorkerAuth(request);
    if (auth instanceof Response) return auth;
    const body = await njBrcBody(request);
    if (!isUuid(body.instance_id) || !["acquire", "renew", "release"].includes(String(body.action))
      || Object.keys(body).some((key) => !["instance_id", "action"].includes(key))) {
      return Response.json({ error: "Invalid NJ BRC lease request." }, { status: 400 });
    }
    const { data, error } = await auth.admin.rpc("manage_nj_brc_worker_lease", {
      p_instance: body.instance_id, p_action: body.action,
    });
    if (error) throw error;
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return njBrcError(error);
  }
}
