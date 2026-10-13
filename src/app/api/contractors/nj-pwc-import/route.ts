import { jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, positiveInt } from "@/lib/server-nj-pwc-sync";

// =====================================================================
// NJ PWC user-selected import
//
// The user's explicit selection of a stored NJ PWC search result is the
// approval decision. Everything happens server-side in ONE transaction
// inside import_nj_pwc_candidate():
//   - the selected certificate is validated against the stored search
//     results (client-supplied candidate fields are never trusted);
//   - compliance_sync_settings.mode (NJ PWC) decides the workflow:
//       auto_approve    -> compliance record created/versioned/refreshed,
//                          approved review entry + audit entry;
//       review_required -> pending Review Queue entry (manual approval);
//   - low-confidence selections (name mismatch, expired registration,
//     certificate change, registry anomaly) always go to review.
// =====================================================================

type ImportResult = {
  sync_run_id: number | null;
  review_queue_id: number | null;
  approval: "auto_approved" | "refreshed" | "review_required" | "already_imported" | string;
  review_reason: string | null;
  compliance_record_id: number | null;
  record_action: string | null;
};

function messageFor(result: ImportResult): string {
  switch (result.approval) {
    case "auto_approved":
      return "NJ PWC registration approved and the compliance record was updated.";
    case "refreshed":
      return "NJ PWC registration already matches the active compliance record; verification was refreshed.";
    case "review_required":
      return `NJ PWC result sent to the Review Queue${result.review_reason ? ` (${result.review_reason})` : ""}.`;
    default:
      return "This NJ PWC search result was already imported.";
  }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "contractors", "manage");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const payload = (body ?? {}) as Record<string, unknown>;

    const contractorId = positiveInt(payload.contractor_id);
    if (!contractorId) return Response.json({ error: "contractor_id is required." }, { status: 400 });

    const searchRequestId = positiveInt(payload.search_request_id);
    if (!searchRequestId) return Response.json({ error: "search_request_id is required." }, { status: 400 });

    const candidate = (payload.candidate ?? {}) as Record<string, unknown>;
    const certificateNumber = typeof candidate.certificate_number === "string" ? candidate.certificate_number.trim() : "";
    if (!certificateNumber) {
      return Response.json({ error: "candidate.certificate_number is required." }, { status: 400 });
    }

    const { data, error } = await admin.rpc("import_nj_pwc_candidate", {
      p_search_request_id: searchRequestId,
      p_contractor_id: contractorId,
      p_certificate_number: certificateNumber,
      p_actor_id: profile.auth_user_id,
      p_actor_name: profile.name,
      p_actor_email: profile.email,
    });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    const result = firstRpcRow<ImportResult>(data);
    return Response.json({
      ok: true,
      approval: result.approval,
      review_reason: result.review_reason,
      sync_run_id: result.sync_run_id,
      review_queue_id: result.review_queue_id,
      review_status: result.approval === "review_required" ? "pending" : result.approval === "already_imported" ? null : "approved",
      compliance_record_id: result.compliance_record_id,
      record_action: result.record_action,
      message: messageFor(result),
    });
  } catch (error) {
    return jsonError(error);
  }
}
