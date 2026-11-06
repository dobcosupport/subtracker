import { AdminApiError, jsonError } from "@/lib/server-admin";
import { procoreContext, procoreError } from "@/lib/server-procore-import";

async function healthContext(request: Request) {
  const context = await procoreContext(request, true);
  if (!context.profile.system_administrator && context.profile.role !== "Administrator") {
    throw new AdminApiError("Procore health controls require an Administrator.", 403);
  }
  return context;
}

export async function GET(request: Request) {
  try {
    const context = await healthContext(request);
    const { data, error } = await context.admin.rpc("procore_operation_health", { p_actor: context.profile.auth_user_id });
    procoreError(error);
    if (!data) throw new AdminApiError("Procore Import Status is unavailable.", 503);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const context = await healthContext(request);
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => key !== "operationId" && key !== "confirmed")
      || !("confirmed" in body) || body.confirmed !== true
      || !("operationId" in body) || typeof body.operationId !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.operationId)) {
      throw new AdminApiError("Confirm a specific Procore Operation ID. Process identifiers are not accepted.", 400);
    }
    const { data, error } = await context.admin.rpc("procore_request_operation_stop", {
      p_operation: body.operationId, p_actor: context.profile.auth_user_id,
    });
    procoreError(error);
    if (!data) throw new AdminApiError("Stop request could not be confirmed. Refresh Import Status.", 503);
    return Response.json(data, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
