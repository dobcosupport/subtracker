import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { contractorFilter, getCommunicationSummaries } from "@/lib/server-communication-history";
import { insuranceRelatedItems } from "@/lib/followup-related-item";
import type { ContractorTimeline, ContractorTimelineEntry, TimelineOffsets } from "@/types/contractor-activity";

const PAGE_SIZE = 50;
function offsets(params: URLSearchParams): TimelineOffsets {
  const result = { activity: 0, followup: 0, communication: 0 };
  for (const key of ["activity", "followup", "communication"] as const) {
    const value = params.get(key) ?? "0";
    if (!/^\d{1,7}$/.test(value)) throw new AdminApiError("Invalid timeline position.", 400);
    result[key] = Number(value);
  }
  return result;
}

export async function GET(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "activity", "view");
    const params = new URL(request.url).searchParams;
    const contractorId = contractorFilter(params.get("contractor_id"));
    const start = offsets(params);
    const { data: contractor, error: contractorError } = await admin.from("contractors")
      .select("id,company_name").eq("id", contractorId).maybeSingle();
    if (contractorError) throw contractorError;
    if (!contractor) throw new AdminApiError("Contractor not found.", 404);
    const { data: permissions, error: permissionError } = await admin.from("role_permissions")
      .select("module,can_view").eq("role", profile.role);
    if (permissionError) throw permissionError;
    const allowed = (module: string) => profile.system_administrator
      || (permissions ?? []).some((permission) => permission.module === module && permission.can_view);
    const followupsAllowed = allowed("followups"), communicationsAllowed = allowed("communications_summary");
    const activityQuery = admin.from("activity_log")
      .select("id,contractor_id,project_id,activity_date,activity_type,notes,follow_up_date,created_by,created_at")
      .eq("contractor_id", contractorId).order("activity_date", { ascending: false })
      .order("created_at", { ascending: false }).order("id")
      .range(start.activity, start.activity + PAGE_SIZE);
    const followupQuery = followupsAllowed ? admin.from("contractor_followups")
      .select("id,contractor_id,followup_date,followup_method,subject,status,created_at,compliance_record_id,compliance_type_id,insurance_item_key,related_type:compliance_types(compliance_name),related_record:compliance_records(contractor_id,related_type:compliance_types(compliance_name))")
      .eq("contractor_id", contractorId).order("followup_date", { ascending: false })
      .order("created_at", { ascending: false }).order("id")
      .range(start.followup, start.followup + PAGE_SIZE) : null;
    const [activities, followups, communications] = await Promise.all([
      activityQuery, followupQuery,
      communicationsAllowed ? getCommunicationSummaries(request, new URLSearchParams({
        contractor_id: String(contractorId), offset: String(start.communication),
      }), PAGE_SIZE + 1) : null,
    ]);
    if (activities.error) throw activities.error;
    if (followups?.error) throw followups.error;
    const activityEntries: ContractorTimelineEntry[] = (activities.data ?? []).map((record) => ({
      source: "activity", date: `${record.activity_date}T00:00:00.000Z`, created_at: record.created_at, record,
    }));
    const followupEntries: ContractorTimelineEntry[] = (followups?.data ?? []).map((row) => {
      const relatedType = Array.isArray(row.related_type) ? row.related_type[0] : row.related_type;
      const relatedRecord = Array.isArray(row.related_record) ? row.related_record[0] : row.related_record;
      const recordType = relatedRecord?.contractor_id === contractorId
        ? Array.isArray(relatedRecord.related_type) ? relatedRecord.related_type[0] : relatedRecord.related_type : null;
      const relatedItem = row.insurance_item_key
        ? insuranceRelatedItems.find((item) => item.key === row.insurance_item_key)?.label ?? "Insurance item unavailable"
        : relatedType?.compliance_name ?? recordType?.compliance_name
          ?? (row.compliance_type_id ? `Compliance type #${row.compliance_type_id}` : row.compliance_record_id ? `Compliance record #${row.compliance_record_id}` : "General Follow-Up");
      return {
        source: "followup", date: `${row.followup_date}T00:00:00.000Z`, created_at: row.created_at,
        record: { id: row.id, contractor_id: row.contractor_id, followup_date: row.followup_date, followup_method: row.followup_method,
          subject: row.subject, status: row.status, created_at: row.created_at, related_item: relatedItem },
      };
    });
    const communicationEntries: ContractorTimelineEntry[] = (communications?.messages ?? []).map((record) => ({
      source: "communication", date: record.created_at, created_at: record.created_at, record,
    }));
    const sorted = [...activityEntries, ...followupEntries, ...communicationEntries].sort((a, b) =>
      Date.parse(b.date) - Date.parse(a.date) || Date.parse(b.created_at) - Date.parse(a.created_at)
      || a.source.localeCompare(b.source) || (typeof a.record.id === "number" && typeof b.record.id === "number"
        ? a.record.id - b.record.id : String(a.record.id).localeCompare(String(b.record.id))));
    const entries = sorted.slice(0, PAGE_SIZE);
    const next = { ...start };
    for (const entry of entries) next[entry.source]++;
    const result: ContractorTimeline = {
      contractor, entries, next: sorted.length > PAGE_SIZE ? next : null,
      sources: { activity: true, followups: followupsAllowed, communications: communicationsAllowed },
    };
    return Response.json(result);
  } catch (error) { return jsonError(error); }
}
