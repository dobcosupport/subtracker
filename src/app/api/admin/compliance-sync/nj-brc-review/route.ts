import { requireModulePermission } from "@/lib/server-admin";
import { njBrcBody, njBrcError, njBrcUserClient, positiveInteger, redactNjBrcEvidence } from "@/lib/server-nj-brc-worker";

export async function POST(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "manage");
    const payload = await njBrcBody(request);
    const reviewId = positiveInteger(payload.review_id);
    if (!reviewId) return Response.json({ error: "review_id must be a positive integer." }, { status: 400 });
    if (payload.decision !== "approved" && payload.decision !== "rejected") {
      return Response.json({ error: "decision must be approved or rejected." }, { status: 400 });
    }
    if (payload.notes !== undefined && payload.notes !== null
      && (typeof payload.notes !== "string" || payload.notes.length > 2000)) {
      return Response.json({ error: "notes must be text of at most 2000 characters." }, { status: 400 });
    }
    if (payload.decision === "rejected" && (typeof payload.notes !== "string" || !payload.notes.trim())) {
      return Response.json({ error: "A rejection reason is required." }, { status: 400 });
    }
    if (Object.keys(payload).some((key) => !["review_id", "decision", "notes"].includes(key))) {
      return Response.json({ error: "Only review_id, decision, and notes may be submitted." }, { status: 400 });
    }
    const { data: lookup, error: lookupError } = await admin.from("nj_brc_search_requests")
      .select("id,federal_tax_id,taxpayer_id_submission").eq("review_queue_id", reviewId).maybeSingle();
    if (lookupError) throw lookupError;
    if (!lookup) return Response.json({ error: "NJ BRC review request not found." }, { status: 404 });
    const { data, error } = await njBrcUserClient(request).rpc(
      payload.decision === "approved" ? "approve_nj_brc_search_request" : "reject_nj_brc_search_request",
      { p_request_id: lookup.id, p_decision_notes: redactNjBrcEvidence(payload.notes, lookup.federal_tax_id, lookup.taxpayer_id_submission) },
    );
    if (error) throw error;
    return Response.json({ ok: true, compliance_record_id: payload.decision === "approved" ? data : null });
  } catch (error) {
    return njBrcError(error);
  }
}
