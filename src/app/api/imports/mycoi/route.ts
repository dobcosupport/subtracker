import { jsonError, AdminApiError } from "@/lib/server-admin";
import { mycoiContext, runResponse } from "@/lib/server-mycoi-import";
import { parseMycoiWorkbook } from "@/lib/mycoi-parser";
import { blankDecisions } from "@/lib/mycoi-preview";
import type { MycoiImportRun } from "@/types/mycoi-import";

export async function GET(request: Request) {
  try {
    const context = await mycoiContext(request);
    const params = new URL(request.url).searchParams;
    const offset = Number(params.get("offset") ?? "0");
    const scope = params.get("scope") ?? "working";
    if (!["working", "finalized"].includes(scope)) throw new AdminApiError("Choose working or finalized import history.", 400);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new AdminApiError("Invalid history offset.", 400);
    const { data, error } = await context.admin.rpc("mycoi_list_import_runs", { p_finalized: scope === "finalized", p_offset: offset });
    if (error) throw new AdminApiError(error.message, 503);
    if (!Array.isArray(data)) throw new AdminApiError("Import history returned no valid list. Reload before continuing.", 503);
    return Response.json({ runs: data });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const context = await mycoiContext(request, true);
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size || file.size > 3 * 1024 * 1024 || file.name.length > 250) {
      throw new AdminApiError("Choose a nonempty myCOI XLSX/CSV file no larger than 3 MB, with filename at most 250 characters.", 400);
    }
    let rows;
    try { rows = parseMycoiWorkbook(await file.arrayBuffer(), file.name); }
    catch (error) { throw new AdminApiError(error instanceof Error ? error.message : "Invalid myCOI workbook.", 400); }
    if (Buffer.byteLength(JSON.stringify(rows), "utf8") > 4_000_000) throw new AdminApiError("Expanded report data exceeds the 4 MB review limit.", 400);
    const { data, error } = await context.admin.from("mycoi_import_runs").insert({
      file_name: file.name, created_by: context.profile.auth_user_id,
      source_rows: rows, decisions: blankDecisions(),
      metrics: { rows: 0, vendors: 0, policies: 0, changes: 0, exceptions: rows.length },
    }).select("*").single();
    if (error) throw new AdminApiError(error.message, 503);
    return Response.json(await runResponse(context, data as MycoiImportRun));
  } catch (error) { return jsonError(error); }
}
