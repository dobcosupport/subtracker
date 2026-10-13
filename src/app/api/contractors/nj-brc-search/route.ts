import { requireModulePermission } from "@/lib/server-admin";
import {
  maskedNjBrcRequest, NJ_BRC_ACTIVE_STATES, NJ_BRC_READ_COLUMNS, njBrcBody, njBrcError,
  njBrcUserClient, positiveInteger, requireNjBrcWorker,
} from "@/lib/server-nj-brc-worker";
import { normalizeFederalTaxIdForNjBrcLookup } from "../../../../../worker/nj-brc/input";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const isReview = url.searchParams.has("review_id");
    const { admin } = await requireModulePermission(request, isReview ? "compliance_sync" : "contractors", isReview ? "view" : "manage");
    if (isReview && url.searchParams.has("contractor_id")) {
      return Response.json({ error: "Provide contractor_id or review_id, not both." }, { status: 400 });
    }
    const field = isReview ? "review_id" : "contractor_id";
    const id = positiveInteger(url.searchParams.get(field));
    if (!id) return Response.json({ error: `${field} must be a positive integer.` }, { status: 400 });
    const { data, error } = await admin.from("nj_brc_search_requests").select(NJ_BRC_READ_COLUMNS)
      .eq(isReview ? "review_queue_id" : "contractor_id", id).order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    const summary = maskedNjBrcRequest(data);
    if (summary) {
      const { data: current, error: currentError } = await admin.from("contractors")
        .select("company_name,nj_brc_number,brc_name_control,federal_tax_id").eq("id", summary.contractor_id).maybeSingle();
      if (currentError) throw currentError;
      const maskedCurrent = maskedNjBrcRequest(current);
      summary.current_contractor = maskedCurrent ? {
        company_name: maskedCurrent.company_name,
        nj_brc_number: maskedCurrent.nj_brc_number,
        brc_name_control: maskedCurrent.brc_name_control,
        federal_tax_id_masked: maskedCurrent.federal_tax_id_masked,
      } : null;
    }
    return Response.json({ request: summary });
  } catch (error) {
    return njBrcError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "contractors", "manage");
    const payload = await njBrcBody(request);
    const contractorId = positiveInteger(payload.contractor_id);
    if (!contractorId) return Response.json({ error: "contractor_id must be a positive integer." }, { status: 400 });
    if (Object.keys(payload).some((field) => field !== "contractor_id")) {
      return Response.json({ error: "Only contractor_id may be submitted. NJ BRC lookup inputs are read from the saved contractor." }, { status: 400 });
    }
    const { data: existing, error: existingError } = await admin.from("nj_brc_search_requests").select(NJ_BRC_READ_COLUMNS)
      .eq("contractor_id", contractorId).in("status", NJ_BRC_ACTIVE_STATES)
      .order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (existingError) throw existingError;
    if (existing) return Response.json({ request: { ...maskedNjBrcRequest(existing), existing: true } });

    const { data: contractor, error: contractorError } = await admin.from("contractors")
      .select("id, company_name, nj_brc_number, brc_name_control, federal_tax_id, active")
      .eq("id", contractorId).maybeSingle();
    if (contractorError) throw contractorError;
    if (!contractor) return Response.json({ error: "Contractor not found." }, { status: 404 });
    if (!contractor.active) return Response.json({ error: "Contractor is inactive." }, { status: 400 });
    if (typeof contractor.brc_name_control !== "string" || !/^[A-Za-z0-9&-]{4}$/.test(contractor.brc_name_control)) {
      return Response.json({ error: "Invalid BRC Name Control: expected exactly 4 approved characters (letters, digits, ampersands, or hyphens), without spaces." }, { status: 400 });
    }
    const normalized = normalizeFederalTaxIdForNjBrcLookup(contractor.federal_tax_id);
    if (!normalized.ok) return Response.json({ error: normalized.error }, { status: 400 });
    await requireNjBrcWorker(admin);

    // The worker-owned transform is used only for the immutable lookup snapshot, never contractor master data.
    const { data, error } = await njBrcUserClient(request).rpc("create_nj_brc_search_request", {
      p_contractor_id: contractorId, p_taxpayer_id_submission: normalized.taxpayerId,
    });
    if (error) throw error;
    return Response.json({ request: maskedNjBrcRequest(data) });
  } catch (error) {
    return njBrcError(error);
  }
}
