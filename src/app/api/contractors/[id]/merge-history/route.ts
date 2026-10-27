import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import type { AdminContext } from "@/lib/server-admin";
import type { CompanyMergeHistory, CompanyMergeHistoryPage, CompanyMergeIdentity, CompanyMergeReceipt } from "@/types/database";

const PAGE_SIZE = 50;
const GRAPH_LIMIT = 200;
const identityColumns = "id,company_name,merged_into_contractor_id";
const receiptColumns = "id,primary_id,secondary_id,successor_id,actor_id,merged_at";
const lineageColumns = "merge_id,category,source_id,before_contractor_id:before_row->>contractor_id,after_contractor_id:after_row->>contractor_id,before_active:before_row->>active,after_active:after_row->>active,before_current:before_row->>is_current,after_current:after_row->>is_current,after_assignment_id:after_row->>assignment_id,after_tiered_sub_id:after_row->>tiered_sub_id,before_tiered_sub_contractor_id:before_row->>tiered_sub_contractor_id,after_tiered_sub_contractor_id:after_row->>tiered_sub_contractor_id";
const mappingColumns = `${lineageColumns},before_import_history_id:before_row->>import_history_id,after_import_history_id:after_row->>import_history_id,before_import_run_id:before_row->>import_run_id,after_import_run_id:after_row->>import_run_id,before_vendor_mapping_id:before_row->>vendor_mapping_id,after_vendor_mapping_id:after_row->>vendor_mapping_id,before_accepted_at:before_row->>accepted_at,after_accepted_at:after_row->>accepted_at,before_last_imported_at:before_row->>last_imported_at,after_last_imported_at:after_row->>last_imported_at`;
const queueColumns = "merge_id,category,source_id,before_contractor_id:before_row->>contractor_id,before_status:before_row->>status,before_result_status:before_row->>result_status,before_created_at:before_row->>created_at,before_reviewed_at:before_row->>reviewed_at,before_sync_run_id:before_row->>sync_run_id,before_compliance_record_id:before_row->>compliance_record_id";

// Explicit column lists are also the disclosure boundary for the service-role client.
const categories = {
  projects: { label: "Project assignments", modules: ["projects"], table: "contractor_projects",
    columns: "id,contractor_id,project_id,assigned_date,removed_date,active,manual_owned,mycoi_owned,project:projects(project_number,project_name)", order: "id" },
  tiers: { label: "Tier relationships (both roles)", modules: ["tiered_subs"], table: "contractor_tiered_subs",
    columns: "id,contractor_id,tiered_sub_contractor_id,active,assigned_date,removed_date", order: "id" },
  compliance: { label: "Compliance history", modules: ["compliance"], table: "compliance_records",
    columns: "id,contractor_id,compliance_type_id,effective_date,expiration_date,verified_date,verification_source,active,is_current,type:compliance_types(compliance_name)", order: "id" },
  insurance: { label: "Insurance verification history", modules: ["insurance"], table: "contractor_insurance_history",
    columns: "id,contractor_id,coi_on_file,general_liability_on_file,general_liability_expiration_date,workers_comp_on_file,workers_comp_expiration_date,verified_date,created_at", order: "id" },
  insurance_snapshot: { label: "Original insurance tracking", modules: ["insurance"], table: "contractor_insurance",
    columns: "contractor_id,certificate_on_file,general_liability_on_file,general_liability_expiration_date,workers_comp_on_file,workers_comp_expiration_date,last_verified_date", order: "contractor_id" },
  mycoi: { label: "myCOI policies and import evidence", modules: ["insurance"], table: "mycoi_policies",
    columns: "id,contractor_id,vendor_mapping_id,policy_line,expiration_date,expired,active,is_current,last_imported_at,import_history_id", order: "id" },
  mycoi_vendors: { label: "myCOI vendor import evidence", modules: ["insurance"], table: "mycoi_vendor_mappings",
    columns: "id,contractor_id,raw_vendor_name,active,last_imported_at,import_history_id", order: "id" },
  mycoi_divisions: { label: "myCOI division / import evidence", modules: ["insurance"], table: "mycoi_contractor_divisions",
    columns: "id,vendor_mapping_id,division_mapping_id,compliance_status,active,is_current,last_imported_at,import_history_id,vendor:mycoi_vendor_mappings!inner(contractor_id)", order: "id" },
  activity: { label: "Activity history", modules: ["activity"], table: "activity_log",
    columns: "id,contractor_id,project_id,activity_date,activity_type,follow_up_date,created_at", order: "id" },
  documents: { label: "Document history", modules: ["documents"], table: "documents",
    columns: "id,contractor_id,compliance_record_id,document_name,document_type,upload_date,expiration_date", order: "id" },
  followups: { label: "Follow-up history", modules: ["followups"], table: "contractor_followups",
    columns: "id,contractor_id,followup_date,followup_method,status,created_at", order: "id" },
  reminders: { label: "Reminder history", modules: ["followups"], table: "reminders",
    columns: "id,contractor_id,reminder_stage,scheduled_date,sent_date,delivery_status,resolved_date", order: "id" },
  communications: { label: "Communications links", modules: ["communications_summary"], table: "communication_contractors",
    columns: "message_id,contractor_id,message:communication_messages(id,channel,source,status,created_at)", order: "message_id" },
  provenance: { label: "Moved compliance / relationship provenance", modules: ["compliance", "projects", "tiered_subs"], table: "company_merge_lineage",
    columns: lineageColumns, order: "source_id" },
  contact_provenance: { label: "Moved contact UUID provenance (no contact details)", modules: ["contractors"], table: "company_merge_lineage",
    columns: "merge_id,category,source_id,before_contractor_id:before_row->>contractor_id,after_contractor_id:after_row->>contractor_id", order: "source_id" },
  identity_provenance: { label: "Original company identity receipt (no tax fields)", modules: ["contractors"], table: "company_merge_lineage",
    columns: "merge_id,category,source_id,before_id:before_row->>id,before_company_name:before_row->>company_name,before_active:before_row->>active,after_id:after_row->>id,after_company_name:after_row->>company_name,after_active:after_row->>active", order: "source_id" },
  procore_provenance: { label: "Retired Procore mapping before-images / import lineage", modules: ["imports"], table: "company_merge_lineage",
    columns: mappingColumns, order: "source_id" },
  mycoi_provenance: { label: "Original myCOI mapping / policy before-and-after evidence", modules: ["insurance"], table: "company_merge_lineage",
    columns: mappingColumns, order: "source_id" },
  sync_provenance: { label: "Immutable original registry queue / search receipt metadata", modules: ["compliance_sync"], table: "company_merge_lineage",
    columns: queueColumns, order: "source_id" },
  sync_reviews: { label: "Retained original registry review queue", modules: ["compliance_sync"], table: "compliance_sync_review_queue",
    columns: "id,contractor_id,compliance_record_id,compliance_name,status,result_status,sync_run_id,created_at,reviewed_at", order: "id" },
  pwc_requests: { label: "Retained original NJ PWC search requests", modules: ["compliance_sync"], table: "compliance_sync_search_requests",
    columns: "id,contractor_id,compliance_name,status,result_status,created_at", order: "id" },
  brc_requests: { label: "Retained original NJ BRC search requests", modules: ["compliance_sync"], table: "nj_brc_search_requests",
    columns: "id,contractor_id,status,result_type,created_at", order: "id" },
} as const;
type Category = keyof typeof categories;

function positiveId(value: string | null): number {
  if (!value || !/^[1-9]\d*$/.test(value) || Number(value) > 2147483647) {
    throw new AdminApiError("A valid company ID is required.", 400);
  }
  return Number(value);
}

function check(error: { code?: string; message: string } | null) {
  if (!error) return;
  if (["42P01", "42703", "PGRST204", "PGRST205"].includes(error.code ?? "")) {
    throw new AdminApiError("Company merge history is unavailable: required database migration/schema is missing or outdated.", 503);
  }
  throw new AdminApiError(`Unable to load company merge history: ${error.message}`, 503);
}

async function graph(admin: AdminContext["admin"], id: number) {
  const { data: selected, error } = await admin.from("contractors").select(identityColumns).eq("id", id).maybeSingle();
  check(error);
  if (!selected) throw new AdminApiError("Company not found.", 404);
  const identities = new Map<number, CompanyMergeIdentity>([[id, selected]]);
  const receipts = new Map<string, Omit<CompanyMergeReceipt, "actor_name">>();
  const visited = new Set<number>();
  const frontier = [id];
  while (frontier.length) {
    const batch = frontier.splice(0, 40);
    batch.forEach((value) => visited.add(value));
    const predicate = ["primary_id", "secondary_id", "successor_id"]
      .map((column) => `${column}.in.(${batch.join(",")})`).join(",");
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await admin.from("company_merges").select(receiptColumns)
        .or(predicate).order("id").range(offset, offset + PAGE_SIZE - 1);
      check(error);
      for (const receipt of data ?? []) {
        receipts.set(receipt.id, receipt);
        for (const companyId of [receipt.primary_id, receipt.secondary_id, receipt.successor_id]) {
          if (!visited.has(companyId) && !frontier.includes(companyId)) frontier.push(companyId);
        }
      }
      if (visited.size + frontier.length > GRAPH_LIMIT || receipts.size > GRAPH_LIMIT) {
        throw new AdminApiError(`Merge history exceeds the ${GRAPH_LIMIT}-company/receipt traversal limit. History is not complete; contact an administrator for a full export.`, 409);
      }
      if (!data || data.length < PAGE_SIZE) break;
    }
  }
  const ids = [...visited];
  for (let offset = 0; offset < ids.length; offset += 40) {
    const { data, error } = await admin.from("contractors").select(identityColumns).in("id", ids.slice(offset, offset + 40));
    check(error);
    for (const company of data ?? []) identities.set(company.id, company);
  }
  if (identities.size !== visited.size) throw new AdminApiError("Merge history contains an unavailable Company Card. History cannot be displayed completely.", 409);
  for (const company of identities.values()) {
    if (company.merged_into_contractor_id && !visited.has(company.merged_into_contractor_id)) {
      throw new AdminApiError("Archived company has no matching permanent merge receipt. History is incomplete.", 409);
    }
  }
  return { companies: [...identities.values()], receipts: [...receipts.values()] };
}

function safeRow(row: Record<string, unknown>): CompanyMergeHistoryPage["rows"][number] {
  const result: CompanyMergeHistoryPage["rows"][number] = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") result[key] = value;
    else if (value && typeof value === "object") {
      const related = Array.isArray(value) ? value[0] : value;
      if (related && typeof related === "object") {
        for (const [field, text] of Object.entries(related)) {
          if (text === null || typeof text === "string" || typeof text === "number" || typeof text === "boolean") result[`${key}_${field}`] = text;
        }
      }
    }
  }
  return result;
}

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin, profile } = await requireModulePermission(request, "contractors", "view");
    const id = positiveId((await context.params).id);
    const { data: permissions, error } = await admin.from("role_permissions").select("module,can_view").eq("role", profile.role);
    check(error);
    const allowed = (module: string) => profile.system_administrator
      || (permissions ?? []).some((permission) => permission.module === module && permission.can_view);
    const family = await graph(admin, id);
    const params = new URL(request.url).searchParams;
    const category = params.get("category");
    if (category !== null) {
      if (!Object.hasOwn(categories, category)) throw new AdminApiError("Unknown merge history category.", 400);
      const key = category as Category;
      const config = categories[key];
      if (!config.modules.some(allowed)) throw new AdminApiError("You do not have permission to view this history category.", 403);
      const sourceId = positiveId(params.get("source_id"));
      if (!family.companies.some((company) => company.id === sourceId)) throw new AdminApiError("Company is not part of this merge history.", 404);
      const rawOffset = params.get("offset") ?? "0";
      if (!/^\d{1,7}$/.test(rawOffset)) throw new AdminApiError("Invalid history offset.", 400);
      const offset = Number(rawOffset);
      let query = admin.from(config.table).select(config.columns);
      if (key === "tiers") query = query.or(`contractor_id.eq.${sourceId},tiered_sub_contractor_id.eq.${sourceId}`);
      else if (config.table === "company_merge_lineage") {
        const mergeIds = family.receipts.filter((receipt) => [receipt.primary_id, receipt.secondary_id, receipt.successor_id].includes(sourceId)).map((receipt) => receipt.id);
        if (!mergeIds.length) return Response.json({ source_id: sourceId, category, rows: [], next_offset: null });
        const visibleCategories = key === "contact_provenance" ? ["contractor_contacts"]
          : key === "identity_provenance" ? ["contractors"]
          : key === "procore_provenance" ? ["procore_vendor_mappings", "procore_import_lineage"]
          : key === "mycoi_provenance" ? ["mycoi_vendor_mappings", "mycoi_policies"]
          : key === "sync_provenance" ? ["compliance_sync_review_queue", "compliance_sync_exceptions",
            "compliance_sync_search_requests", "nj_brc_search_requests", "nj_pwc_sync_state", "nj_pwc_sync_exceptions"]
          : [
          ...(allowed("compliance") ? ["compliance", "compliance_records"] : []),
          ...(allowed("projects") ? ["projects", "contractor_projects"] : []),
          ...(allowed("tiered_subs") ? ["tiered_subs", "contractor_tiered_subs"] : []),
        ];
        query = query.in("merge_id", mergeIds).in("category", visibleCategories);
        if (key === "identity_provenance") query = query.eq("source_id", String(sourceId));
        else query = query.or(`before_row->>contractor_id.eq.${sourceId},before_row->>tiered_sub_contractor_id.eq.${sourceId}`);
      } else if (key === "mycoi_divisions") query = query.eq("vendor.contractor_id", sourceId);
      else query = query.eq("contractor_id", sourceId);
      query = query.order(config.order);
      if (config.table === "company_merge_lineage") query = query.order("merge_id").order("category");
      const { data, error } = await query.range(offset, offset + PAGE_SIZE);
      check(error);
      const rows = (data ?? []) as unknown as Record<string, unknown>[];
      const result: CompanyMergeHistoryPage = {
        source_id: sourceId, category, rows: rows.slice(0, PAGE_SIZE).map(safeRow),
        next_offset: rows.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
      };
      return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
    }
    const actorIds = [...new Set(family.receipts.map((receipt) => receipt.actor_id))];
    const actors = new Map<string, string>();
    for (let offset = 0; offset < actorIds.length; offset += 40) {
      const { data, error } = await admin.from("user_profiles").select("auth_user_id,name").in("auth_user_id", actorIds.slice(offset, offset + 40));
      check(error);
      for (const actor of data ?? []) actors.set(actor.auth_user_id, actor.name);
    }
    const result: CompanyMergeHistory = {
      contractor_id: id, companies: family.companies,
      receipts: family.receipts.map((receipt) => ({ ...receipt, actor_name: actors.get(receipt.actor_id) ?? null })),
      categories: Object.entries(categories).map(([key, config]) => ({ key, label: config.label, allowed: config.modules.some(allowed) })),
    };
    return Response.json(result, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return jsonError(error); }
}
