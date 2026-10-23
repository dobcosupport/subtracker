import { AdminApiError, jsonError } from "@/lib/server-admin";
import { procoreContext, procoreError, procoreResponse } from "@/lib/server-procore-import";
import { parseProcoreWorkbook } from "@/lib/procore-parser";
import { blankProcoreDecisions } from "@/lib/procore-preview";
import type { ProcoreRun } from "@/types/procore-import";

export async function GET(request: Request) {
  try {
    const context = await procoreContext(request);
    const params = new URL(request.url).searchParams;
    const scope = params.get("scope") ?? "working";
    const offset = Number(params.get("offset") ?? "0");
    if (!["working", "finalized"].includes(scope) || !Number.isSafeInteger(offset) || offset < 0) {
      throw new AdminApiError("Invalid Procore history scope or offset.", 400);
    }
    const { data, error } = await context.admin.rpc("procore_list_import_runs", {
      p_finalized: scope === "finalized", p_offset: offset, p_actor: context.profile.auth_user_id,
    });
    procoreError(error);
    if (!Array.isArray(data)) throw new AdminApiError("Procore history returned an invalid list.", 503);
    return Response.json({ runs: data });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const context = await procoreContext(request, true);
    const file = (await request.formData()).get("file");
    if (!(file instanceof File) || !file.size || file.size > 3 * 1024 * 1024 || file.name.length > 250) {
      throw new AdminApiError("Choose a nonempty Procore XLSX/CSV file up to 3 MB, with filename up to 250 characters.", 400);
    }
    let source;
    try { source = parseProcoreWorkbook(await file.arrayBuffer(), file.name); }
    catch (error) { throw new AdminApiError(error instanceof Error ? error.message : "Invalid Procore report.", 400); }
    if (Buffer.byteLength(JSON.stringify(source), "utf8") > 4_000_000) throw new AdminApiError("Expanded Procore report exceeds the 4 MB review limit.", 400);
    const { data, error } = await context.admin.from("procore_import_runs").insert({
      file_name: file.name, source_rows: source, decisions: blankProcoreDecisions(), created_by: context.profile.auth_user_id,
    }).select("*").single();
    procoreError(error);
    return Response.json(await procoreResponse(context, data as ProcoreRun));
  } catch (error) { return jsonError(error); }
}
