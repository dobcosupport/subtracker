import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { positiveInt } from "@/lib/server-nj-pwc-sync";
import type { ComplianceUnlinkHistory } from "@/types/registration-unlink";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin } = await requireModulePermission(request, "contractors", "view");
    const id = positiveInt((await context.params).id);
    if (!id) throw new AdminApiError("Contractor id must be a positive integer.", 400);
    const unlinks: ComplianceUnlinkHistory[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.from("compliance_record_unlinks")
        .select("record_id,reason,unlinked_at,unlinked_by,administrator:user_profiles!unlinked_by(name)")
        .eq("contractor_id", id).order("record_id").range(offset, offset + 999);
      if (error) throw error;
      for (const row of data ?? []) {
        const administrator = Array.isArray(row.administrator) ? row.administrator[0] : row.administrator;
        unlinks.push({ record_id: row.record_id, reason: row.reason, unlinked_at: row.unlinked_at,
          administrator: administrator?.name ?? row.unlinked_by, record_company_name: null, identifiers: null });
      }
      if (!data || data.length < 1000) break;
    }
    if (unlinks.length) {
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await admin.from("administration_audit_log")
          .select("details,user_name").eq("object_type", "contractor").eq("object_id", String(id))
          .eq("action", "COMPLIANCE_RECORD_UNLINKED").order("id").range(offset, offset + 999);
        if (error) throw error;
        for (const audit of data ?? []) {
          const details: unknown = audit.details;
          if (!details || typeof details !== "object" || !("compliance_record_id" in details)) continue;
          const entry = unlinks.find((item) => item.record_id === details.compliance_record_id);
          if (!entry) continue;
          if (audit.user_name) entry.administrator = audit.user_name;
          if ("record_company_name" in details && typeof details.record_company_name === "string") {
            entry.record_company_name = details.record_company_name;
          }
          if ("previous_identifier" in details && "resulting_identifier" in details
            && (details.previous_identifier === null || typeof details.previous_identifier === "string")
            && (details.resulting_identifier === null || typeof details.resulting_identifier === "string")) {
            entry.identifiers = { previous: details.previous_identifier, resulting: details.resulting_identifier };
          }
        }
        if (!data || data.length < 1000) break;
      }
    }
    return Response.json({ unlinks });
  } catch (error) { return jsonError(error); }
}
