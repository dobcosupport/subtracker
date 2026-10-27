import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { optionalText, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";
import type { UnlinkCompliance, UnlinkContractor, UnlinkRecord } from "@/types/registration-unlink";

function compliance(value: unknown): UnlinkCompliance {
  if (value !== "NJ PWC" && value !== "NJ BRC") throw new AdminApiError("Select NJ PWC or NJ BRC.", 400);
  return value;
}

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "manage");
    const url = new URL(request.url);
    const type = compliance(url.searchParams.get("compliance"));
    if (!url.searchParams.has("contractor_id")) {
      const contractors: UnlinkContractor[] = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await admin.from("contractors").select("id,company_name,active")
          .is("merged_into_contractor_id", null)
          .order("company_name").order("id").range(offset, offset + 999).returns<UnlinkContractor[]>();
        if (error) throw error;
        contractors.push(...(data ?? []));
        if (!data || data.length < 1000) break;
      }
      return Response.json({ contractors });
    }
    const id = positiveInt(url.searchParams.get("contractor_id"));
    if (!id) throw new AdminApiError("contractor_id must be a positive integer.", 400);
    const { data: contractor, error: companyError } = await admin.from("contractors")
      .select("id,company_name,active,nj_pwc_number,nj_brc_number,brc_name_control,city,state,zip_code")
      .is("merged_into_contractor_id", null)
      .eq("id", id).maybeSingle();
    if (companyError) throw companyError;
    if (!contractor) throw new AdminApiError("Contractor not found.", 404);
    const { data: typeRow, error: typeError } = await admin.from("compliance_types")
      .select("id").eq("compliance_name", type).maybeSingle();
    if (typeError) throw typeError;
    if (!typeRow) throw new AdminApiError("Compliance type not found.", 404);
    const records: UnlinkRecord[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.from("compliance_records")
        .select("id,registration_number,synced_registration_number,certificate_number,matched_business_entity_id,matched_company_name,searched_name_control,effective_date,expiration_date,verified_date,verification_source,active,is_current,updated_at")
        .eq("contractor_id", id).eq("compliance_type_id", typeRow.id)
        .order("updated_at", { ascending: false }).order("id", { ascending: false })
        .range(offset, offset + 999).returns<UnlinkRecord[]>();
      if (error) throw error;
      records.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    const { data: unlinks, error: unlinkError } = await admin.from("compliance_record_unlinks")
      .select("record_id,unlinked_at").eq("contractor_id", id).eq("compliance_type_id", typeRow.id);
    if (unlinkError) throw new AdminApiError(`Unable to load unlink history. The administrative unlink migration is required: ${unlinkError.message}`, 503);
    const { data: reviews, error: reviewError } = await admin.from("compliance_sync_review_queue")
      .select("compliance_record_id,matched_company_name,brc_evidence,brc_name_control_used")
      .eq("contractor_id", id).eq("compliance_name", type).eq("status", "approved").order("id", { ascending: false });
    if (reviewError) throw reviewError;
    const current = records.find((record) => record.active && record.is_current && record.registration_number?.trim()
      && (type === "NJ BRC" || record.expiration_date) && !unlinks?.some((item) => item.record_id === record.id));
    const identifier = type === "NJ PWC" ? contractor.nj_pwc_number : contractor.nj_brc_number;
    return Response.json({ contractor, records: records.map((record) => {
      const review = reviews?.find((item) => item.compliance_record_id === record.id);
      return { ...record,
        matched_company_name: record.matched_company_name ?? review?.matched_company_name ?? review?.brc_evidence?.taxpayer_name ?? null,
        searched_name_control: record.searched_name_control ?? review?.brc_name_control_used ?? null,
        supplies_identifier: current?.id === record.id && identifier === record.registration_number,
        unlinked_at: unlinks?.find((item) => item.record_id === record.id)?.unlinked_at ?? null };
    }) });
  } catch (error) { return jsonError(error); }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const body = await readJsonObject(request, ["contractor_id", "record_id", "compliance", "expected_updated_at", "expected_identifier", "reason", "confirmed"]);
    const type = compliance(body.compliance);
    const contractor = positiveInt(body.contractor_id);
    const record = positiveInt(body.record_id);
    const reason = optionalText(body.reason, "reason");
    if (!contractor || !record || !reason || body.confirmed !== true
      || typeof body.expected_updated_at !== "string" || !Number.isFinite(Date.parse(body.expected_updated_at))
      || (body.expected_identifier !== null && typeof body.expected_identifier !== "string")) {
      throw new AdminApiError("A record, non-blank reason, current snapshot and explicit confirmation are required.", 400);
    }
    const { data, error } = await admin.rpc("unlink_contractor_registration", {
      p_contractor: contractor, p_record: record, p_compliance: type,
      p_expected_updated_at: body.expected_updated_at, p_expected_identifier: body.expected_identifier,
      p_reason: reason, p_confirmed: true, p_actor: profile.auth_user_id,
    });
    if (error) throw new AdminApiError(error.message,
      error.code === "40001" ? 409 : error.code === "42501" ? 403 : error.code === "P0002" ? 404 : error.code === "22023" ? 400 : 503);
    if (!data || typeof data !== "object" || !("compliance_record_id" in data)) {
      throw new AdminApiError("Unlink returned no authoritative result. Reload the linked records before taking further action.", 503);
    }
    return Response.json({ result: data });
  } catch (error) { return jsonError(error); }
}
