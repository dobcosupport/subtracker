import {
  isResultStatus,
  isSyncableComplianceType,
  isValidDateString,
  jsonError,
  requireRpaKey,
} from "@/lib/server-compliance-sync";
import { writeAdministrationAudit } from "@/lib/server-admin";

// =====================================================================
// COMPLIANCE LOGIC LOCK (Phase 1)
// This endpoint writes ONLY to:
//   - compliance_records.synced_* columns (display-only Synced records)
//   - compliance_sync_review_queue
//   - compliance_sync_exceptions
//   - administration_audit_log
// It NEVER updates the authoritative compliance_records.expiration_date /
// registration_number used by dashboard counts, Missing Information,
// contractor status, reminders, or reports.
//
// AUTO APPROVE WRITE-LOCK: When a compliance type is configured as
// auto_approve, the review item stays "pending" with
// approval_source = "Auto Approve Requested". Automatic write-through to
// Active Compliance Records will be enabled ONLY after the NJ BRC RPA
// workflow has been validated.
// =====================================================================

// NJ BRC-specific exception types (in addition to the generic result statuses)
const NJ_BRC_EXCEPTION_TYPES = new Set([
  "Missing BRC Name Control",
  "Missing NJ BRC Number",
  "Invalid BRC Name Control",
  "Invalid Business Entity ID",
  "No Match Found",
  "Multiple Matches",
  "NJ Website Unavailable",
  "Search Form Not Found",
  "Search Timed Out",
  "Result Page Changed",
  "Result Fields Could Not Be Read",
  "SubTracker Submission Failed",
  "Human Verification Required",
  "RPA Error",
]);

function toDateOrNull(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (!isValidDateString(value)) return null;
  return String(value).slice(0, 10);
}

function toTextOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export async function POST(request: Request) {
  try {
    const auth = await requireRpaKey(request);
    if (auth instanceof Response) return auth;
    const { admin } = auth;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }

    const payload = (body ?? {}) as Record<string, unknown>;
    const {
      sync_run_id,
      contractor_id,
      compliance_type,
      // NJ BRC lookup inputs (echoed back by the RPA)
      searched_name_control,
      searched_business_entity_id,
      // Generic / legacy search field
      searched_registration_number,
      // Result fields
      matched_company_name,
      matched_business_entity_id,
      matched_registration_number,
      certificate_number,
      registration_number,
      synced_status,
      synced_effective_date,
      synced_expiration_date,
      last_verified,
      source_url,
      result_status,
      error_message,
      raw_result_summary,
    } = payload;

    // ---- Validation -------------------------------------------------
    const runId = Number(sync_run_id);
    if (!Number.isInteger(runId) || runId <= 0) return Response.json({ error: "sync_run_id is invalid." }, { status: 400 });

    const contractorId = Number(contractor_id);
    if (!Number.isInteger(contractorId) || contractorId <= 0) return Response.json({ error: "contractor_id is invalid." }, { status: 400 });

    if (!isSyncableComplianceType(compliance_type)) {
      return Response.json({ error: "compliance_type is unsupported." }, { status: 400 });
    }
    if (!isResultStatus(result_status)) {
      return Response.json({ error: "result_status is missing or invalid." }, { status: 400 });
    }
    if (synced_expiration_date !== undefined && synced_expiration_date !== null && synced_expiration_date !== "" && !isValidDateString(synced_expiration_date)) {
      return Response.json({ error: "synced_expiration_date is invalid." }, { status: 400 });
    }
    if (synced_effective_date !== undefined && synced_effective_date !== null && synced_effective_date !== "" && !isValidDateString(synced_effective_date)) {
      return Response.json({ error: "synced_effective_date is invalid." }, { status: 400 });
    }

    // Confirm the run exists
    const { data: run, error: runError } = await admin.from("compliance_sync_runs").select("id").eq("id", runId).maybeSingle();
    if (runError) throw runError;
    if (!run) return Response.json({ error: "sync_run_id does not reference an existing sync run." }, { status: 404 });

    // Confirm the contractor exists
    const { data: contractor, error: contractorError } = await admin.from("contractors").select("id, company_name").eq("id", contractorId).maybeSingle();
    if (contractorError) throw contractorError;
    if (!contractor) return Response.json({ error: "contractor does not exist." }, { status: 404 });

    // ---- Idempotency ------------------------------------------------
    // One result per (sync_run_id, contractor_id, compliance_type).
    const resultKey = `${runId}:${contractorId}:${compliance_type}`;
    const { data: existing } = await admin
      .from("compliance_sync_review_queue")
      .select("id, status")
      .eq("sync_run_id", runId)
      .eq("contractor_id", contractorId)
      .eq("compliance_name", compliance_type)
      .maybeSingle();
    if (existing) {
      return Response.json({ duplicate: true, review_queue_id: existing.id, review_status: existing.status, result_key: resultKey });
    }

    // ---- Resolve compliance type + matching Active Compliance Record --
    const { data: complianceType } = await admin.from("compliance_types").select("id").eq("compliance_name", compliance_type).maybeSingle();
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

    // Proposed values (null when the NJ source does not provide them — never fabricated)
    const proposedExpiration = toDateOrNull(synced_expiration_date);
    const proposedEffective = toDateOrNull(synced_effective_date);
    const proposedRegistration = toTextOrNull(registration_number) ?? toTextOrNull(matched_registration_number);
    const certificateNumber = toTextOrNull(certificate_number);
    const matchedCompanyName = toTextOrNull(matched_company_name);
    const matchedBusinessEntityId = toTextOrNull(matched_business_entity_id);
    const searchedNameControl = toTextOrNull(searched_name_control);
    const searchedBusinessEntityId = toTextOrNull(searched_business_entity_id) ?? toTextOrNull(searched_registration_number);
    const lastVerified = last_verified ? String(last_verified) : new Date().toISOString();
    const sourceUrl = toTextOrNull(source_url);
    const rawSummary = toTextOrNull(raw_result_summary);
    const errorMessage = toTextOrNull(error_message);

    // Approval mode for this compliance type (Phase 1: auto-approve is write-locked)
    const { data: setting } = await admin
      .from("compliance_sync_settings")
      .select("mode")
      .eq("compliance_name", compliance_type)
      .maybeSingle();
    const isAutoApprove = setting?.mode === "auto_approve";
    const approvalSource = isAutoApprove ? "Auto Approve Requested" : null;

    const currentExpiration = activeRecord?.expiration_date ?? null;
    const changeDetected = result_status === "Match Found" && proposedExpiration !== currentExpiration;

    if (result_status === "Match Found") {
      // 1) Update the display-only Synced Compliance Record
      if (activeRecord) {
        const { error: syncUpdateError } = await admin
          .from("compliance_records")
          .update({
            synced_registration_number: proposedRegistration,
            synced_status: toTextOrNull(synced_status),
            synced_effective_date: proposedEffective,
            synced_expiration_date: proposedExpiration,
            synced_last_verified_at: lastVerified,
            last_sync_at: new Date().toISOString(),
            sync_source: "RPA",
            sync_status: "Pending Review",
            source_url: sourceUrl,
            certificate_number: certificateNumber,
            searched_name_control: searchedNameControl,
            searched_business_entity_id: searchedBusinessEntityId,
            matched_business_entity_id: matchedBusinessEntityId,
            matched_company_name: matchedCompanyName,
            sync_run_id: runId,
            raw_result_summary: rawSummary,
          })
          .eq("id", activeRecord.id);
        if (syncUpdateError) throw syncUpdateError;
      }

      // 2) Create the review queue entry (current vs proposed)
      const { data: queueEntry, error: queueError } = await admin
        .from("compliance_sync_review_queue")
        .insert({
          sync_run_id: runId,
          contractor_id: contractorId,
          compliance_record_id: activeRecord?.id ?? null,
          compliance_name: compliance_type,
          proposed_registration_number: proposedRegistration,
          proposed_status: toTextOrNull(synced_status),
          proposed_expiration_date: proposedExpiration,
          current_registration_number: activeRecord?.registration_number ?? null,
          current_effective_date: activeRecord?.effective_date ?? null,
          current_expiration_date: currentExpiration,
          status: "pending",
          sync_source: "RPA",
          result_key: resultKey,
          brc_name_control_used: searchedNameControl,
          business_entity_id_used: searchedBusinessEntityId,
          certificate_number: certificateNumber,
          matched_registration_number: toTextOrNull(matched_registration_number),
          matched_company_name: matchedCompanyName,
          synced_effective_date_proposed: proposedEffective,
          last_verified: lastVerified,
          source_url: sourceUrl,
          result_status,
          raw_result_summary: rawSummary,
          approval_source: approvalSource,
        })
        .select("id, status")
        .single();
      if (queueError) throw queueError;

      if (changeDetected) {
        const { data: runRow } = await admin.from("compliance_sync_runs").select("changes_detected").eq("id", runId).maybeSingle();
        await admin.from("compliance_sync_runs").update({ changes_detected: (runRow?.changes_detected ?? 0) + 1 }).eq("id", runId);
      }

      await writeAdministrationAudit(admin, null, "NJ_BRC_SYNC_RESULT_RECEIVED", "compliance_sync", String(queueEntry.id), contractor.company_name, {
        compliance_type,
        sync_run_id: runId,
        result_status,
        previous_synced_value: activeRecord?.registration_number ?? null,
        new_synced_value: proposedRegistration,
        source: "RPA",
      }).catch(() => undefined);

      return Response.json({
        review_queue_id: queueEntry.id,
        review_status: "pending",
        approval_source: approvalSource,
        change_detected: changeDetected,
        result_key: resultKey,
      });
    }

    // ---- Non-match / error results -----------------------------------
    // Preserve search values, create a review item (for No Match / Multiple
    // Matches) and always an exception. Do NOT erase a prior synced result.
    const isReviewable = result_status === "No Match Found" || result_status === "Multiple Matches";
    let reviewQueueId: number | null = null;

    if (isReviewable) {
      const { data: queueEntry, error: queueError } = await admin
        .from("compliance_sync_review_queue")
        .insert({
          sync_run_id: runId,
          contractor_id: contractorId,
          compliance_record_id: activeRecord?.id ?? null,
          compliance_name: compliance_type,
          proposed_registration_number: null,
          proposed_status: null,
          proposed_expiration_date: null,
          current_registration_number: activeRecord?.registration_number ?? null,
          current_effective_date: activeRecord?.effective_date ?? null,
          current_expiration_date: currentExpiration,
          status: "pending",
          sync_source: "RPA",
          result_key: resultKey,
          brc_name_control_used: searchedNameControl,
          business_entity_id_used: searchedBusinessEntityId,
          matched_company_name: matchedCompanyName,
          source_url: sourceUrl,
          result_status,
          raw_result_summary: rawSummary,
          exception_message: errorMessage,
        })
        .select("id")
        .single();
      if (!queueError) reviewQueueId = queueEntry?.id ?? null;
    }

    const exceptionType = NJ_BRC_EXCEPTION_TYPES.has(result_status) ? result_status : "RPA Error";
    const { data: exception } = await admin
      .from("compliance_sync_exceptions")
      .insert({
        sync_run_id: runId,
        contractor_id: contractorId,
        company_name: contractor.company_name,
        compliance_name: compliance_type,
        exception_type: exceptionType,
        message: errorMessage ?? `${result_status} for ${compliance_type}`,
        result_status,
        source_url: sourceUrl,
        resolved: false,
      })
      .select("id")
      .single();

    // Increment the failed count on the run
    const { data: runRow } = await admin.from("compliance_sync_runs").select("records_failed, failures").eq("id", runId).maybeSingle();
    await admin.from("compliance_sync_runs").update({ records_failed: (runRow?.records_failed ?? 0) + 1, failures: (runRow?.failures ?? 0) + 1 }).eq("id", runId);

    // Mark the synced record's sync_status as Failed (without erasing prior data)
    if (activeRecord) {
      await admin.from("compliance_records").update({ sync_status: "Failed" }).eq("id", activeRecord.id);
    }

    await writeAdministrationAudit(admin, null, "NJ_BRC_SYNC_FAILED", "compliance_sync", exception ? String(exception.id) : null, contractor.company_name, {
      compliance_type,
      sync_run_id: runId,
      result_status,
      exception_type: exceptionType,
      source: "RPA",
    }).catch(() => undefined);

    return Response.json({ exception_created: true, review_queue_id: reviewQueueId, result_status, result_key: resultKey });
  } catch (error) {
    return jsonError(error);
  }
}
