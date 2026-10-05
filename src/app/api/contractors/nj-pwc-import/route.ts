import { jsonError, requireModulePermission } from "@/lib/server-admin";

// =====================================================================
// NJ PWC import → Synced Compliance Record + Review Queue (post-save)
//
// Called by the Add Contractor flow AFTER the contractor has been created
// and the user selected + confirmed an NJ PWC match. Writes ONLY:
//   - compliance_records.synced_* display-only columns (when an Active
//     Compliance Record exists for the type) — NEVER the authoritative
//     expiration_date / registration_number
//   - compliance_sync_review_queue (pending review entry)
//
// If the contractor does not exist, nothing is written (no orphaned
// synced records). Active Compliance Records remain the sole source for
// dashboard counts, statuses, reports, and reminders.
// =====================================================================

function toTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function toDateOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? String(value).slice(0, 10) : null;
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

    const contractorId = Number(payload.contractor_id);
    if (!Number.isInteger(contractorId) || contractorId <= 0) {
      return Response.json({ error: "contractor_id is required." }, { status: 400 });
    }

    const candidate = (payload.candidate ?? {}) as Record<string, unknown>;
    const createSyncedRecord = payload.create_synced_record === true;

    // Confirm the contractor exists (guards against orphaned records)
    const { data: contractor, error: contractorError } = await admin
      .from("contractors")
      .select("id, company_name")
      .eq("id", contractorId)
      .maybeSingle();
    if (contractorError) throw contractorError;
    if (!contractor) return Response.json({ error: "Contractor not found." }, { status: 404 });

    const now = new Date().toISOString();
    const certificateNumber = toTextOrNull(candidate.certificate_number);
    const matchedCompanyName = toTextOrNull(candidate.business_name) ?? toTextOrNull(candidate.matched_company_name);
    const registrationDate = toDateOrNull(candidate.registration_date);
    const expirationDate = toDateOrNull(candidate.expiration_date);

    // Create a sync run for this attended import (labeled, non-test)
    const { data: run, error: runError } = await admin
      .from("compliance_sync_runs")
      .insert({
        run_at: now,
        started_at: now,
        completed_at: now,
        sync_source: "RPA",
        run_status: "Completed",
        status: "completed",
        records_checked: 1,
        changes_detected: 0,
        records_failed: 0,
        failures: 0,
        initiated_by: profile.name,
        triggered_by: profile.name,
        is_test: false,
        notes: "NJ PWC Add Contractor import — synced record + review queue only; Active Compliance Records unchanged.",
      })
      .select("id")
      .single();
    if (runError) throw runError;

    // Resolve the NJ PWC compliance type + any matching Active record
    const { data: complianceType } = await admin.from("compliance_types").select("id").eq("compliance_name", "NJ PWC").maybeSingle();
    const { data: activeRecord } = complianceType
      ? await admin
          .from("compliance_records")
          .select("id, registration_number, effective_date, expiration_date")
          .eq("contractor_id", contractorId)
          .eq("compliance_type_id", complianceType.id)
          .eq("active", true)
          .eq("is_current", true)
          .maybeSingle()
      : { data: null };

    // Optionally stamp the display-only Synced Compliance Record columns
    if (createSyncedRecord && activeRecord) {
      const { error: syncUpdateError } = await admin
        .from("compliance_records")
        .update({
          synced_registration_number: certificateNumber,
          synced_status: null,
          synced_effective_date: registrationDate,
          synced_expiration_date: expirationDate,
          synced_last_verified_at: now,
          last_sync_at: now,
          sync_source: "RPA",
          sync_status: "Pending Review",
          certificate_number: certificateNumber,
          matched_company_name: matchedCompanyName,
          sync_run_id: run.id,
          raw_result_summary: "NJ PWC Add Contractor import.",
        })
        .eq("id", activeRecord.id);
      if (syncUpdateError) throw syncUpdateError;
    }

    // Always create the pending Review Queue entry
    const resultKey = `${run.id}:${contractorId}:NJ PWC`;
    const { data: queueEntry, error: queueError } = await admin
      .from("compliance_sync_review_queue")
      .insert({
        sync_run_id: run.id,
        contractor_id: contractorId,
        compliance_record_id: activeRecord?.id ?? null,
        compliance_name: "NJ PWC",
        proposed_registration_number: certificateNumber,
        proposed_status: null,
        proposed_expiration_date: expirationDate,
        current_registration_number: activeRecord?.registration_number ?? null,
        current_effective_date: activeRecord?.effective_date ?? null,
        current_expiration_date: activeRecord?.expiration_date ?? null,
        status: "pending",
        sync_source: "RPA",
        result_key: resultKey,
        certificate_number: certificateNumber,
        matched_company_name: matchedCompanyName,
        synced_effective_date_proposed: registrationDate,
        last_verified: now,
        result_status: "Match Found",
        raw_result_summary: "NJ PWC Add Contractor import.",
        is_test: false,
      })
      .select("id, status")
      .single();
    if (queueError) throw queueError;

    return Response.json({
      ok: true,
      sync_run_id: run.id,
      review_queue_id: queueEntry.id,
      review_status: queueEntry.status,
      synced_record_updated: Boolean(createSyncedRecord && activeRecord),
      message: "NJ PWC synced record + review queue entry created. Active Compliance Records unchanged.",
    });
  } catch (error) {
    return jsonError(error);
  }
}
