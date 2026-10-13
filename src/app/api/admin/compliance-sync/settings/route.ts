import { AdminApiError, jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";

// Audited Compliance Sync settings update. For NJ PWC, `mode` is the master
// switch: review_required = human workflow, auto_approve = automatic
// workflow (low-confidence results always go to review).
const EDITABLE = ["enabled", "mode", "sync_source", "test_mode", "failure_expire_threshold"] as const;
const MODES = ["review_required", "auto_approve"];
const SOURCES = ["Manual", "RPA", "API"];

export async function PATCH(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const payload = await readJsonObject(request, ["id", ...EDITABLE]);
    const id = positiveInt(payload.id);
    if (!id) throw new AdminApiError("id must be a positive integer.", 400);

    const updates: Record<string, unknown> = {};
    if (payload.enabled !== undefined) {
      if (typeof payload.enabled !== "boolean") throw new AdminApiError("enabled must be true or false.", 400);
      updates.enabled = payload.enabled;
    }
    if (payload.test_mode !== undefined) {
      if (typeof payload.test_mode !== "boolean") throw new AdminApiError("test_mode must be true or false.", 400);
      updates.test_mode = payload.test_mode;
    }
    if (payload.mode !== undefined) {
      if (typeof payload.mode !== "string" || !MODES.includes(payload.mode)) throw new AdminApiError("mode is invalid.", 400);
      updates.mode = payload.mode;
    }
    if (payload.sync_source !== undefined) {
      if (typeof payload.sync_source !== "string" || !SOURCES.includes(payload.sync_source)) throw new AdminApiError("sync_source is invalid.", 400);
      updates.sync_source = payload.sync_source;
    }
    if (payload.failure_expire_threshold !== undefined) {
      const threshold = positiveInt(payload.failure_expire_threshold);
      if (!threshold || threshold > 30) throw new AdminApiError("failure_expire_threshold must be between 1 and 30.", 400);
      updates.failure_expire_threshold = threshold;
    }
    if (Object.keys(updates).length === 0) throw new AdminApiError("No setting changes were submitted.", 400);

    const { data: current, error: readError } = await admin.from("compliance_sync_settings").select("*").eq("id", id).maybeSingle();
    if (readError) throw new AdminApiError(readError.message, 500);
    if (!current) throw new AdminApiError("Compliance sync setting not found.", 404);
    if (current.compliance_name === "NJ BRC" && updates.mode === "auto_approve") {
      throw new AdminApiError("NJ BRC requires manual review; Auto Approve is locked.", 409);
    }

    const { error: updateError } = await admin.from("compliance_sync_settings")
      .update({ ...updates, updated_at: new Date().toISOString() }).eq("id", id);
    if (updateError) throw new AdminApiError(updateError.message, 500);

    const changes = Object.fromEntries(Object.entries(updates).map(([key, value]) => [key, { old: current[key] ?? null, new: value }]));
    await writeAdministrationAudit(admin, profile, "COMPLIANCE_SYNC_SETTING_CHANGED", "compliance_sync_settings",
      String(id), String(current.compliance_name), { changes });

    return Response.json({ ok: true });
  } catch (error) {
    return jsonError(error);
  }
}