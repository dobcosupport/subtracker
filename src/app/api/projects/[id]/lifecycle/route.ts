import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";

const reasons = ["Work Complete", "No Longer Onsite", "Removed from Project", "Added in Error", "Other"];
type Context = { params: Promise<{ id: string }> };
const projectId = async (context: Context) => {
  const { id } = await context.params;
  if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) throw new AdminApiError("Invalid project.", 400);
  return Number(id);
};
const rpcError = (error: { message: string; code?: string }) => {
  const status = error.code === "42501" ? 403 : error.code === "PT409" ? 409 :
    error.code === "PT404" ? 404 : error.code === "22023" ? 400 : 503;
  return new AdminApiError(error.message, status);
};

export async function GET(request: Request, context: Context) {
  try {
    const { admin, profile } = await requireModulePermission(request, "projects", "view");
    const { data, error } = await admin.rpc("project_lifecycle_review", { p_project: await projectId(context) });
    if (error) throw rpcError(error);
    if (!data) throw new AdminApiError("Project not found.", 404);
    let canManage = profile.system_administrator;
    if (!canManage && profile.role === "Administrator") {
      const { data: permission, error: permissionError } = await admin.from("role_permissions")
        .select("can_edit").eq("role", profile.role).eq("module", "projects").maybeSingle();
      if (permissionError) throw rpcError(permissionError);
      canManage = permission?.can_edit === true;
    }
    return Response.json({ ...data, canManage }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request, context: Context) {
  try {
    const { admin, profile, actor } = await requireModulePermission(request, "projects", "edit");
    if (!profile.system_administrator && profile.role !== "Administrator") {
      throw new AdminApiError("Administrator permission required.", 403);
    }
    const body: unknown = await request.json().catch(() => { throw new AdminApiError("Invalid JSON.", 400); });
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new AdminApiError("Invalid action.", 400);
    const input = body as Record<string, unknown>;
    const keys = input.action === "close" ? ["action", "token"] :
      input.action === "end" ? ["action", "token", "assignment", "reason"] :
        input.action === "detach" ? ["action", "token", "assignment", "source"] : [];
    if (!keys.length || Object.keys(input).some(key => !keys.includes(key)) ||
        typeof input.token !== "string" || !/^[a-f0-9]{32}$/.test(input.token) ||
        (input.action !== "close" && (!Number.isSafeInteger(input.assignment) || Number(input.assignment) <= 0)) ||
        (input.action === "end" && !reasons.includes(String(input.reason))) ||
        (input.action === "detach" && !["PROCORE", "MYCOI"].includes(String(input.source)))) {
      throw new AdminApiError("Invalid lifecycle action. Reload the project review.", 400);
    }
    const { data, error } = await admin.rpc("project_lifecycle_action", {
      p_project: await projectId(context), p_actor: actor.id, p_token: input.token, p_action: input.action,
      p_assignment: input.assignment ?? null, p_reason: input.reason ?? null, p_source: input.source ?? null,
    });
    if (error) throw rpcError(error);
    return Response.json({ ...data, canManage: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
