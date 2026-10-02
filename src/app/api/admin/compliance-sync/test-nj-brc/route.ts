import { jsonError, requireModulePermission } from "@/lib/server-admin";
import { normalizeBrcNameControl, normalizeNjBrcNumber, validateNjBrcLookup } from "@/lib/server-nj-brc";

// =====================================================================
// NJ BRC Test Mode — Administrator-only attended test of a single
// contractor lookup. Creates a test Sync Run and a Review Queue result,
// labeled Testing Only. NEVER updates Active Compliance Records. The
// first test is attended and manually observed; no unattended scheduling.
// =====================================================================

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const contractorId = Number((body as Record<string, unknown>)?.contractor_id);
    if (!Number.isInteger(contractorId) || contractorId <= 0) {
      return Response.json({ error: "contractor_id is required." }, { status: 400 });
    }

    // Confirm the NJ BRC sync type is in Test Mode and enabled
    const { data: setting } = await admin.from("compliance_sync_settings").select("enabled, test_mode").eq("compliance_name", "NJ BRC").maybeSingle();
    if (!setting?.test_mode) {
      return Response.json({ error: "NJ BRC Test Mode is not enabled. Enable Test Mode in Compliance Sync Settings first." }, { status: 400 });
    }

    // Load the contractor
    const { data: contractor, error: contractorError } = await admin
      .from("contractors")
      .select("id, company_name, brc_name_control, nj_brc_number, active")
      .eq("id", contractorId)
      .maybeSingle();
    if (contractorError) throw contractorError;
    if (!contractor) return Response.json({ error: "Contractor not found." }, { status: 404 });

    const now = new Date().toISOString();

    // Create a test sync run (labeled Testing Only)
    const { data: run, error: runError } = await admin
      .from("compliance_sync_runs")
      .insert({
        run_at: now,
        started_at: now,
        sync_source: "Manual",
        run_status: "Running",
        status: "completed",
        records_checked: 1,
        changes_detected: 0,
        records_failed: 0,
        failures: 0,
        initiated_by: profile.name,
        triggered_by: profile.name,
        is_test: true,
        notes: "Testing Only — NJ BRC attended test lookup",
      })
      .select("id")
      .single();
    if (runError) throw runError;

    // Validate inputs; on failure create a test exception and fail the run
    const validation = validateNjBrcLookup(contractor);
    if (!contractor.active) {
      await admin.from("compliance_sync_exceptions").insert({
        sync_run_id: run.id,
        contractor_id: contractor.id,
        company_name: contractor.company_name,
        compliance_name: "NJ BRC",
        exception_type: "RPA Error",
        message: "Testing Only: contractor is inactive.",
        result_status: "RPA Error",
        is_test: true,
        resolved: false,
      });
      await admin.from("compliance_sync_runs").update({ run_status: "Failed", status: "failed", completed_at: new Date().toISOString(), records_failed: 1, failures: 1 }).eq("id", run.id);
      return Response.json({ sync_run_id: run.id, error: "Contractor is inactive." }, { status: 400 });
    }
    if (!validation.ok) {
      await admin.from("compliance_sync_exceptions").insert({
        sync_run_id: run.id,
        contractor_id: contractor.id,
        company_name: contractor.company_name,
        compliance_name: "NJ BRC",
        exception_type: validation.error,
        message: `Testing Only: ${validation.error}.`,
        result_status: "Invalid Search",
        is_test: true,
        resolved: false,
      });
      await admin.from("compliance_sync_runs").update({ run_status: "Completed With Errors", status: "completed_with_errors", completed_at: new Date().toISOString(), records_failed: 1, failures: 1 }).eq("id", run.id);
      return Response.json({ sync_run_id: run.id, error: validation.error }, { status: 400 });
    }

    // Resolve the matching Active Compliance Record for current values
    const { data: complianceType } = await admin.from("compliance_types").select("id").eq("compliance_name", "NJ BRC").maybeSingle();
    const { data: activeRecord } = complianceType
      ? await admin
          .from("compliance_records")
          .select("id, registration_number, effective_date, expiration_date")
          .eq("contractor_id", contractor.id)
          .eq("compliance_type_id", complianceType.id)
          .eq("active", true)
          .eq("is_current", true)
          .maybeSingle()
      : { data: null };

    // Create a test Review Queue result (Testing Only, Pending Review)
    const resultKey = `${run.id}:${contractor.id}:NJ BRC`;
    const { data: queueEntry, error: queueError } = await admin
      .from("compliance_sync_review_queue")
      .insert({
        sync_run_id: run.id,
        contractor_id: contractor.id,
        compliance_record_id: activeRecord?.id ?? null,
        compliance_name: "NJ BRC",
        proposed_registration_number: null,
        proposed_status: null,
        proposed_expiration_date: null,
        current_registration_number: activeRecord?.registration_number ?? null,
        current_effective_date: activeRecord?.effective_date ?? null,
        current_expiration_date: activeRecord?.expiration_date ?? null,
        status: "pending",
        sync_source: "Manual",
        result_key: resultKey,
        brc_name_control_used: normalizeBrcNameControl(contractor.brc_name_control),
        business_entity_id_used: normalizeNjBrcNumber(contractor.nj_brc_number),
        result_status: "Match Found",
        raw_result_summary: "Testing Only — attended NJ BRC test lookup (no website result submitted).",
        is_test: true,
      })
      .select("id, status")
      .single();
    if (queueError) throw queueError;

    await admin.from("compliance_sync_runs").update({ run_status: "Completed", status: "completed", completed_at: new Date().toISOString() }).eq("id", run.id);

    return Response.json({
      test: true,
      sync_run_id: run.id,
      review_queue_id: queueEntry.id,
      review_status: queueEntry.status,
      message: "Testing Only — NJ BRC test run created. Active Compliance Records unchanged.",
    });
  } catch (error) {
    return jsonError(error);
  }
}
