import { jsonError, requireModulePermission, writeAdministrationAudit, createAdminClient } from "@/lib/server-admin";

// =====================================================================
// Test Data Cleanup — Administrator-only removal of known NJ PWC test
// contractors and their test tracking rows.
//
// SAFETY GUARDS (enforced server-side on EVERY contractor):
//   - contractor must be INACTIVE, AND
//   - nj_pwc_number must equal the known test certificate "123456"
//   (or the contractor row is already flagged as test data).
// It NEVER bulk-deletes all inactive contractors, and never deletes a
// contractor that fails the guard. Legitimate compliance records are not
// touched (the guard ensures only known simulator output is targeted).
// =====================================================================

const TEST_CERTIFICATE_NUMBER = "123456";

// Known simulator test contractor ids (display hint only — the guard below
// is the real gate).
const KNOWN_TEST_IDS = [379, 381, 386];

async function loadTestContractors(admin: ReturnType<typeof createAdminClient>) {
  const { data, error } = await admin
    .from("contractors")
    .select("id, company_name, nj_pwc_number, active, created_at")
    .eq("nj_pwc_number", TEST_CERTIFICATE_NUMBER)
    .order("id", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    ...row,
    known_test_id: KNOWN_TEST_IDS.includes(row.id),
    deletable: row.active === false,
  }));
}

// GET: list candidate test contractors for review.
export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "manage");
    const contractors = await loadTestContractors(admin);
    return Response.json({ contractors });
  } catch (error) {
    return jsonError(error);
  }
}

// POST: delete the selected test contractors + their test tracking rows.
// Body: { contractor_ids: number[] }
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
    const idsRaw = Array.isArray(payload.contractor_ids) ? payload.contractor_ids : [];
    const contractorIds = idsRaw.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 0);
    if (contractorIds.length === 0) {
      return Response.json({ error: "contractor_ids is required." }, { status: 400 });
    }

    // Re-load and apply the safety guard to each requested id.
    const { data: rows, error: loadError } = await admin
      .from("contractors")
      .select("id, company_name, nj_pwc_number, active")
      .in("id", contractorIds);
    if (loadError) throw loadError;

    const eligible = (rows ?? []).filter(
      (row) => row.active === false && row.nj_pwc_number === TEST_CERTIFICATE_NUMBER
    );
    const eligibleIds = eligible.map((row) => row.id);
    const skipped = contractorIds.filter((id) => !eligibleIds.includes(id));

    if (eligibleIds.length === 0) {
      return Response.json({
        deleted: [],
        skipped,
        message: "No records met the test-data safety criteria (must be inactive AND NJ PWC # 123456). Nothing was deleted.",
      });
    }

    // Delete dependent test/tracking rows first (FK-safe order). These are
    // all test or display-only records; Active Compliance Records are never
    // created for these contractors by the simulator.
    await admin.from("compliance_sync_review_queue").delete().in("contractor_id", eligibleIds);
    await admin.from("compliance_sync_exceptions").delete().in("contractor_id", eligibleIds);
    await admin.from("compliance_records").delete().in("contractor_id", eligibleIds); // display-only synced placeholders (none are Active records here)
    await admin.from("contractor_insurance").delete().in("contractor_id", eligibleIds);
    await admin.from("contractor_tiered_subs").delete().in("contractor_id", eligibleIds);
    await admin.from("contractor_tiered_subs").delete().in("tiered_sub_contractor_id", eligibleIds);
    await admin.from("contractor_projects").delete().in("contractor_id", eligibleIds);
    await admin.from("contractor_followups").delete().in("contractor_id", eligibleIds);
    await admin.from("activity_log").delete().in("contractor_id", eligibleIds);

    // Finally delete the contractors themselves.
    const { error: deleteError } = await admin.from("contractors").delete().in("id", eligibleIds);
    if (deleteError) throw deleteError;

    // Clean up test search requests (is_test = true) — not tied to a specific
    // contractor, so clear them as part of the test sweep.
    await admin.from("compliance_sync_search_requests").delete().eq("is_test", true);

    await writeAdministrationAudit(admin, profile, "TEST_DATA_CLEANUP", "compliance_sync", eligibleIds.join(","), "NJ PWC Test Data Cleanup", {
      deleted_contractor_ids: eligibleIds,
      skipped_ids: skipped,
      deleted_by: profile.name,
    }).catch(() => undefined);

    return Response.json({
      deleted: eligibleIds,
      skipped,
      message: `Deleted ${eligibleIds.length} test contractor(s) and their test tracking records.${skipped.length > 0 ? ` Skipped ${skipped.length} that did not meet the safety criteria.` : ""}`,
    });
  } catch (error) {
    return jsonError(error);
  }
}
