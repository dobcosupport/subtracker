import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";
import { njPwcRegistryFields, type NjPwcRegistryMatch } from "@/lib/nj-pwc-registry-fields";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");
    const id = positiveInt(new URL(request.url).searchParams.get("exception_id"));
    if (!id) throw new AdminApiError("exception_id must be a positive integer.", 400);
    const { data, error } = await admin.rpc("get_nj_pwc_registry_match", { p_exception_id: id });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    return Response.json({ comparison: firstRpcRow<NjPwcRegistryMatch>(data) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    // This is also a deliberate user-selected contractor import.
    await requireModulePermission(request, "contractors", "manage");
    const body = await readJsonObject(request, ["exception_id", "snapshot", "selected_fields", "confirmed"]);
    const id = positiveInt(body.exception_id);
    if (!id) throw new AdminApiError("exception_id must be a positive integer.", 400);
    if (body.confirmed !== true) throw new AdminApiError("Explicit confirmation is required.", 400);
    if (typeof body.snapshot !== "string" || !/^[a-f0-9]{32}$/.test(body.snapshot)) {
      throw new AdminApiError("A current registry comparison is required.", 400);
    }
    const fields = body.selected_fields;
    if (!Array.isArray(fields) || !fields.includes("company_name")
      || fields.some((field) => !njPwcRegistryFields.some((supported) => supported.field === field))
      || new Set(fields).size !== fields.length) {
      throw new AdminApiError("Select Company Name and only supported registry fields.", 400);
    }
    const { data, error } = await admin.rpc("accept_nj_pwc_registry_match", {
      p_exception_id: id, p_snapshot: body.snapshot, p_selected_fields: fields, p_confirmed: true,
      p_actor_id: profile.auth_user_id, p_actor_name: profile.name, p_actor_email: profile.email,
    });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    const result = firstRpcRow<{ company_name: string; approval: string; record_action: string }>(data);
    const processing = result.approval === "review_required" ? "NJ PWC result sent to Review Required."
      : result.record_action === "refreshed" ? "NJ PWC verification refreshed." : "NJ PWC compliance result approved.";
    return Response.json({ ok: true, ...result, message: `${result.company_name}: selected fields updated, Name Mismatch resolved, failure count reset. ${processing}` });
  } catch (error) { return jsonError(error); }
}
