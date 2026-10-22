import { AdminApiError, jsonError } from "@/lib/server-admin";
import { mycoiCloseout, mycoiContext, mycoiReference, mycoiRun, requireWorkingImport } from "@/lib/server-mycoi-import";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await mycoiContext(request, true);
    const run = await mycoiRun(access, (await context.params).id);
    requireWorkingImport(run);
    const reference = await mycoiReference(access);
    const { closeout } = await mycoiCloseout(access, run, reference);
    return Response.json({ id: run.id, file_name: run.file_name, revision: run.revision, token: reference.token, closeout });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await mycoiContext(request, true);
    const run = await mycoiRun(access, (await context.params).id);
    requireWorkingImport(run);
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)
      || Object.keys(body).some((key) => !["revision", "token", "confirmed"].includes(key))
      || !("confirmed" in body) || body.confirmed !== true
      || !("revision" in body) || !Number.isSafeInteger(body.revision)
      || !("token" in body) || typeof body.token !== "string") {
      throw new AdminApiError("Saved revision, reference token and deliberate finalization confirmation are required.", 400);
    }
    if (body.revision !== run.revision) throw new AdminApiError("Review changed; reload close-out statistics before finalizing.", 409);
    const reference = await mycoiReference(access);
    if (body.token !== reference.token) throw new AdminApiError("Reference data changed; reload close-out statistics before finalizing.", 409);
    const { closeout, review } = await mycoiCloseout(access, run, reference);
    const { data, error } = await access.admin.rpc("mycoi_finalize_import", {
      p_run: run.id, p_revision: run.revision, p_token: reference.token,
      p_closeout: closeout, p_review: review, p_actor: access.profile.auth_user_id,
    });
    if (error) throw new AdminApiError(error.message, error.code === "40001" ? 409 : error.code === "42501" ? 403 : 503);
    if (!data || typeof data !== "object" || !("finalized_at" in data) || !data.finalized_at) {
      throw new AdminApiError("Finalization returned no authoritative result. Reload the import list before retrying.", 503);
    }
    return Response.json({ result: data });
  } catch (error) { return jsonError(error); }
}
