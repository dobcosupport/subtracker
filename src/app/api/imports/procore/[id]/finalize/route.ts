import { AdminApiError, jsonError } from "@/lib/server-admin";
import { procoreContext, procoreError, procoreReference, procoreRun, workingProcore } from "@/lib/server-procore-import";
import { buildProcorePreview } from "@/lib/procore-preview";

type Params = { params: Promise<{ id: string }> };
async function closeout(request: Request, id: string) {
  const context = await procoreContext(request, true);
  const run = await procoreRun(context, id);
  workingProcore(run);
  const reference = await procoreReference(context);
  const preview = buildProcorePreview(run.source_rows, run.decisions, reference, run.imported_rows);
  return { context, run, reference, review: { preview, contractors: reference.contractors, token: "" } };
}
export async function GET(request: Request, params: Params) {
  try {
    const { run, reference, review } = await closeout(request, (await params.params).id);
    return Response.json({ revision: run.revision, token: reference.token, summary: review.preview.summary });
  } catch (error) { return jsonError(error); }
}
export async function POST(request: Request, params: Params) {
  try {
    const { context, run, reference, review } = await closeout(request, (await params.params).id);
    const body = await request.json() as { revision?: number; token?: string; confirmed?: boolean };
    if (body.confirmed !== true || body.revision !== run.revision || body.token !== reference.token) {
      throw new AdminApiError("Confirm the current finalization review; reload if it changed.", 409);
    }
    const { data, error } = await context.admin.rpc("procore_finalize_import", {
      p_run: run.id, p_revision: run.revision, p_token: reference.token, p_review: review, p_actor: context.profile.auth_user_id,
    });
    procoreError(error);
    if (!data?.finalized_at) throw new AdminApiError("No authoritative finalization result; reload before retrying.", 503);
    return Response.json({ result: data });
  } catch (error) { return jsonError(error); }
}
