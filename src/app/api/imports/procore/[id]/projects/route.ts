import { AdminApiError, jsonError } from "@/lib/server-admin";
import { procoreContext, procoreError, procoreResponse, procoreRun, workingProcore } from "@/lib/server-procore-import";
import type { ProcoreRun } from "@/types/procore-import";

export async function PATCH(request: Request, params: { params: Promise<{ id: string }> }) {
  try {
    const context = await procoreContext(request, true);
    const run = await procoreRun(context, (await params.params).id);
    workingProcore(run);
    const body = await request.json() as { revision?: number; token?: string; number?: string; projectId?: number | null };
    if (body.revision !== run.revision) throw new AdminApiError("Review changed; reload before mapping.", 409);
    if (typeof body.token !== "string" || typeof body.number !== "string" || !body.number.trim() ||
      !run.source_rows.some((row) => row["Project > Number"].trim() === body.number) ||
      !(body.projectId === null || (Number.isSafeInteger(body.projectId) && Number(body.projectId) > 0))) {
      throw new AdminApiError("Choose a source project number and an existing SubTracker project, or Leave Unmatched.", 400);
    }
    const { data, error } = await context.admin.rpc("procore_save_project_mapping", {
      p_run: run.id, p_revision: run.revision, p_token: body.token, p_number: body.number,
      p_project: body.projectId, p_actor: context.profile.auth_user_id,
    });
    procoreError(error);
    if (!data) throw new AdminApiError("Project mapping returned no result; reload before retrying.", 503);
    return Response.json(await procoreResponse(context, data as ProcoreRun));
  } catch (error) { return jsonError(error); }
}
