import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { mycoiAudits, mycoiContext, mycoiReference, mycoiRun, runResponse, validateDecisions } from "@/lib/server-mycoi-import";
import { buildMycoiPreview } from "@/lib/mycoi-preview";
import type { MycoiImportRun } from "@/types/mycoi-import";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await mycoiContext(request);
    return Response.json(await runResponse(access, await mycoiRun(access, (await context.params).id)));
  } catch (error) { return jsonError(error); }
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await mycoiContext(request, true);
    const run = await mycoiRun(access, (await context.params).id);
    const body = await request.json() as { revision?: number; decisions?: unknown };
    if (body.revision !== run.revision) throw new AdminApiError("Review changed; reload before saving.", 409);
    const decisions = validateDecisions(body.decisions, run);
    const status = run.source_rows.every((row) => run.imported_rows.includes(row.row))
      ? "Complete" : (run.import_history_id ? "Partial" : "Review");
    const { data, error } = await access.admin.from("mycoi_import_runs").update({ decisions, status, revision: run.revision + 1 })
      .eq("id", run.id).eq("revision", run.revision).select("*").maybeSingle();
    if (error) throw new AdminApiError(error.message, 503);
    if (!data) throw new AdminApiError("Review changed; reload before saving.", 409);
    return Response.json(await runResponse(access, data as MycoiImportRun));
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await mycoiContext(request, true);
    const run = await mycoiRun(access, (await context.params).id);
    const body = await request.json() as { revision?: number; token?: string; acceptCompleteSnapshot?: boolean };
    if (body.revision !== run.revision) throw new AdminApiError("Review changed; reload before importing.", 409);
    const reference = await mycoiReference(access);
    // The client confirms a preview, but never supplies trusted policy/mapping mutations.
    if (body.token !== reference.token) throw new AdminApiError("Reference data changed; refresh preview before importing.", 409);
    const preview = buildMycoiPreview(run.source_rows, run.decisions, reference, run.imported_rows);
    const snapshot = body.acceptCompleteSnapshot === true
      ? buildMycoiPreview(run.source_rows, run.decisions, reference) : null;
    if (preview.ready.some((vendor) => vendor.createContractor)) {
      await requireModulePermission(request, "contractors", "add");
    }
    if (snapshot && (!run.source_rows.length || run.decisions.ignored.length || snapshot.summary.unresolvedRows
      || snapshot.summary.readyRows !== run.source_rows.length)) {
      throw new AdminApiError("A COMPLETE snapshot requires every source row matched and resolved, with no ignored rows.", 400);
    }
    if (!preview.ready.length && !run.decisions.ignored.length && !snapshot) throw new AdminApiError("No fully resolved vendors or ignored source rows to record.", 400);
    const { error } = await access.admin.rpc("mycoi_apply_import", {
      p_run: run.id, p_revision: run.revision, p_token: reference.token,
      p_plan: preview.ready, p_audits: mycoiAudits(access, run, reference), p_actor: access.profile.auth_user_id,
      p_snapshot: snapshot?.ready ?? null,
    });
    if (error) throw new AdminApiError(error.message, error.code === "40001" ? 409 : 503);
    return Response.json(await runResponse(access, await mycoiRun(access, run.id)));
  } catch (error) { return jsonError(error); }
}
