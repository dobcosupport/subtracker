import { jsonError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";

// =====================================================================
// Create Test NJ PWC Result — Administrator-only PAD simulator.
//
// Simulates Power Automate Desktop output for an existing pending NJ PWC
// search request, WITHOUT requiring PAD to run. Lets an admin validate
// the full Add Contractor → Search → Results → Import flow end-to-end.
//
// COMPLIANCE LOGIC LOCK: writes ONLY to compliance_sync_search_requests.
// Never touches contractors, Active Compliance Records, dashboard counts,
// reports, reminders, or contractor status.
// =====================================================================

type TestOutcome = "Match Found" | "No Match Found" | "Multiple Matches" | "Failed";

const TEST_MATCH_CANDIDATE = {
  business_name: "ABCO",
  certificate_number: "123456",
  registration_date: null,
  expiration_date: null,
  address: null,
  city: null,
  state: null,
  zip_code: null,
  county: null,
  source_url: "https://nj.gov/labor/public-works/",
};

function toTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const payload = (body ?? {}) as Record<string, unknown>;

    const requestId = Number(payload.search_request_id);
    if (!Number.isInteger(requestId) || requestId <= 0) {
      return Response.json({ error: "search_request_id is required." }, { status: 400 });
    }
    const outcome = payload.outcome as TestOutcome;
    if (!["Match Found", "No Match Found", "Multiple Matches", "Failed"].includes(outcome)) {
      return Response.json({ error: "outcome must be one of: Match Found, No Match Found, Multiple Matches, Failed." }, { status: 400 });
    }

    // Confirm the request exists and is still pending
    const { data: existing, error: findError } = await admin
      .from("compliance_sync_search_requests")
      .select("id, status, searched_company_name")
      .eq("id", requestId)
      .maybeSingle();
    if (findError) throw findError;
    if (!existing) return Response.json({ error: "Search request not found." }, { status: 404 });
    if (existing.status !== "pending") {
      return Response.json({ error: `Search request #${requestId} is already ${existing.status}. Only pending requests can be simulated.` }, { status: 400 });
    }

    // Build the simulated result
    const companyName = existing.searched_company_name;
    let status: "completed" | "no_match" | "failed";
    let resultStatus: TestOutcome;
    let candidates: Record<string, string | null>[] = [];
    let errorMessage: string | null = null;

    if (outcome === "Match Found") {
      status = "completed";
      resultStatus = "Match Found";
      candidates = [{ ...TEST_MATCH_CANDIDATE, business_name: companyName }];
    } else if (outcome === "Multiple Matches") {
      status = "completed";
      resultStatus = "Multiple Matches";
      candidates = [
        { ...TEST_MATCH_CANDIDATE, business_name: companyName },
        { ...TEST_MATCH_CANDIDATE, business_name: `${companyName} INC`, certificate_number: "789012" },
      ];
    } else if (outcome === "No Match Found") {
      status = "no_match";
      resultStatus = "No Match Found";
      candidates = [];
    } else {
      status = "failed";
      resultStatus = "Failed";
      candidates = [];
      errorMessage = toTextOrNull(payload.error_message) ?? "Simulated failure: NJ Public Works registry did not respond.";
    }

    const now = new Date().toISOString();
    const { error: updateError } = await admin
      .from("compliance_sync_search_requests")
      .update({
        status,
        result_status: resultStatus,
        candidates,
        error_message: errorMessage,
        source_url: candidates[0]?.source_url ?? null,
        is_test: true,
        completed_at: now,
        updated_at: now,
      })
      .eq("id", requestId);
    if (updateError) throw updateError;

    await writeAdministrationAudit(admin, profile, "NJ_PWC_TEST_RESULT_CREATED", "compliance_sync", String(requestId), "NJ PWC Test Result", {
      outcome: resultStatus,
      status,
      candidate_count: candidates.length,
      simulated_by: profile.name,
    }).catch(() => undefined);

    return Response.json({
      ok: true,
      search_request_id: requestId,
      status,
      result_status: resultStatus,
      candidate_count: candidates.length,
      message: `Test result created for search request #${requestId}: ${resultStatus}.`,
    });
  } catch (error) {
    return jsonError(error);
  }
}
