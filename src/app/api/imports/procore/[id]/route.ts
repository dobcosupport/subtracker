import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { procoreContext, procoreError, procoreReference, procoreResponse, procoreRun, validateProcoreDecisions, workingProcore } from "@/lib/server-procore-import";
import { buildProcorePreview } from "@/lib/procore-preview";
import type { ProcoreRun } from "@/types/procore-import";

type Params = { params: Promise<{ id: string }> };
export async function GET(request: Request, params: Params) {
  try {
    const context = await procoreContext(request);
    return Response.json(await procoreResponse(context, await procoreRun(context, (await params.params).id)));
  } catch (error) { return jsonError(error); }
}
export async function PATCH(request: Request, params: Params) {
  try {
    const context = await procoreContext(request, true);
    const run = await procoreRun(context, (await params.params).id);
    workingProcore(run);
    const body = await request.json() as { revision?: number; decisions?: unknown };
    if (body.revision !== run.revision) throw new AdminApiError("Review changed; reload before saving.", 409);
    const decisions = validateProcoreDecisions(body.decisions, run);
    const { data, error } = await context.admin.rpc("procore_save_review", {
      p_run: run.id, p_revision: run.revision, p_decisions: decisions, p_actor: context.profile.auth_user_id,
    });
    procoreError(error);
    return Response.json(await procoreResponse(context, data as ProcoreRun));
  } catch (error) { return jsonError(error); }
}
export async function POST(request: Request, params: Params) {
  try {
    const context = await procoreContext(request, true);
    const run = await procoreRun(context, (await params.params).id);
    workingProcore(run);
    const body = await request.json() as { revision?: number; token?: string };
    const reference = await procoreReference(context);
    if (body.revision !== run.revision || body.token !== reference.token) throw new AdminApiError("Review or reference data changed; reload before importing.", 409);
    const preview = buildProcorePreview(run.source_rows, run.decisions, reference, run.imported_rows);
    if (!preview.ready.length) throw new AdminApiError("No resolved Procore assignments are ready.", 400);
    if (preview.ready.some((p) => p.createContractor)) await requireModulePermission(request, "contractors", "add");
    const { data, error } = await context.admin.rpc("procore_apply_import", {
      p_run: run.id, p_revision: run.revision, p_token: reference.token, p_plan: preview.ready, p_actor: context.profile.auth_user_id,
    });
    procoreError(error, true);
    if (!data) throw new AdminApiError("Import returned no result; reload before retrying.", 503);
    return Response.json(await procoreResponse(context, await procoreRun(context, run.id)));
  } catch (error) { return jsonError(error); }
}
