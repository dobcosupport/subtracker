import { supabase } from "@/lib/supabase";
import { adminFetch } from "@/lib/admin-client";

// =====================================================================
// Compliance Sync Administration service
//
// COMPLIANCE LOGIC: This module reads sync-run metadata, review-queue
// entries, settings, and exceptions. NJ PWC and NJ BRC review decisions,
// settings changes, and NJ PWC sync-exception actions are executed by
// server routes (transactional SQL functions) and are fully audited. For
// NJ PWC, compliance_sync_settings.mode is the master switch:
// review_required = human workflow, auto_approve = automatic workflow
// (low-confidence results always require review).
// =====================================================================

export type SyncSource = "Manual" | "RPA" | "API";
export type SyncMode = "review_required" | "auto_approve";
export type ReviewStatus = "pending" | "approved" | "rejected";
export type SyncRunStatus = "completed" | "completed_with_errors" | "failed";

export interface ComplianceSyncSetting {
  id: number;
  compliance_name: "NJ PWC" | "NJ BRC" | "NY PWC" | "NY BRC";
  enabled: boolean;
  mode: SyncMode;
  sync_source: SyncSource;
  test_mode?: boolean;
  failure_expire_threshold?: number;
  daily_sync_enabled?: boolean;
  daily_sync_start_date?: string | null;
  daily_sync_time?: string | null;
  daily_sync_timezone?: string | null;
  schedule_cron: string | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
}

export interface ComplianceSyncRun {
  id: number;
  run_type?: string | null;
  run_date?: string | null;
  run_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  run_status?: string | null;
  sync_source: SyncSource;
  status: SyncRunStatus;
  records_checked: number;
  changes_detected: number;
  records_approved: number;
  records_rejected: number;
  failures: number;
  triggered_by: string | null;
  notes: string | null;
  stop_requested_at?: string | null;
  stop_requested_by?: string | null;
}

export interface ComplianceSyncReviewEntry {
  id: number;
  contractor_id: number;
  contractor_name?: string;
  compliance_name: string;
  proposed_registration_number: string | null;
  proposed_status: string | null;
  proposed_expiration_date: string | null;
  current_registration_number: string | null;
  current_effective_date?: string | null;
  current_expiration_date: string | null;
  synced_effective_date_proposed?: string | null;
  status: ReviewStatus;
  sync_source: SyncSource;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  approval_source?: string | null;
  brc_name_control_used?: string | null;
  business_entity_id_used?: string | null;
  matched_company_name?: string | null;
  certificate_number?: string | null;
  last_verified?: string | null;
  exception_message?: string | null;
  result_status?: string | null;
  review_reason?: string | null;
  search_request_id?: number | null;
  is_test?: boolean | null;
}

export interface ComplianceSyncException {
  id: number;
  contractor_id: number | null;
  compliance_name: string | null;
  exception_type: string;
  message: string;
  resolved: boolean;
  created_at: string;
}

export interface ComplianceSyncDashboard {
  lastSync: ComplianceSyncRun | null;
  nextScheduledSync: string | null;
  recordsChecked: number;
  changesDetected: number;
  pendingReview: number;
  approved: number;
  rejected: number;
  failedVerifications: number;
}

export interface NjBrcOrphanedRequest {
  request_id: string;
  contractor_id: number;
  contractor: string;
  status: "claimed" | "processing";
  claimed_at: string | null;
  worker_instance_id: string | null;
  created_at: string;
}

export async function getNjBrcOrphanedRequests(): Promise<{
  data: { requests: NjBrcOrphanedRequest[]; age_threshold_minutes: number } | null;
  error: { message: string } | null;
}> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-brc-orphaned-requests");
    const result = await response.json() as {
      requests?: NjBrcOrphanedRequest[];
      age_threshold_minutes?: number;
      error?: string;
    };
    if (!response.ok) throw new Error(result.error ?? "Unable to load orphaned NJ BRC requests.");
    return {
      data: { requests: result.requests ?? [], age_threshold_minutes: result.age_threshold_minutes ?? 10 },
      error: null,
    };
  } catch (reason) {
    return { data: null, error: { message: reason instanceof Error ? reason.message : "Unable to load orphaned NJ BRC requests." } };
  }
}

export async function recoverNjBrcOrphanedRequest(requestId: string): Promise<{ error: { message: string } | null }> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-brc-orphaned-requests", {
      method: "POST",
      body: JSON.stringify({ request_id: requestId, confirmed: true }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Unable to recover orphaned NJ BRC request.");
    return { error: null };
  } catch (reason) {
    return { error: { message: reason instanceof Error ? reason.message : "Unable to recover orphaned NJ BRC request." } };
  }
}

export interface NjPwcSyncExceptionItem {
  id: number;
  contractor_id: number;
  contractor: string;
  is_test: boolean;
  reason: string;
  kind: "failure" | "review" | "infrastructure" | string;
  expired_by_sync: boolean;
  review_queue_id: number | null;
  first_detected_at: string;
  last_attempt_at: string | null;
  last_successful_sync_at: string | null;
  consecutive_failure_count: number;
  registry_match?: import("@/lib/nj-pwc-registry-fields").NjPwcRegistryMatch | null;
  retry_request?: {
    id: number;
    status: string;
    result_status: string | null;
    sync_outcome: string | null;
    searched_company_name: string;
    origin: string;
  } | null;
}

export interface NjPwcActiveRun {
  id: number;
  run_date: string | null;
  started_at: string | null;
  run_status: string;
  is_test: boolean;
  manual_run: boolean;
  stop_requested_at: string | null;
  stop_requested_by: string | null;
}

export interface NjPwcSyncHealth {
  open_exceptions: number;
  review_required: number;
  expired_by_sync: number;
  registry_unavailable: number;
  /** Test Mode dry-run classifications; null when Test Mode is off. */
  would_auto_approve: number | null;
  would_expire: number | null;
  would_request_review: number | null;
  would_propose_expiration: number | null;
  last_successful_daily_run: { id: number; run_date: string | null; completed_at: string | null; run_status: string } | null;
}

export interface NjPwcOrphanedRequest {
  request_id: number;
  contractor_id: number | null;
  contractor: string;
  status: "claimed" | "processing";
  worker_instance_id: string;
  claimed_at: string;
}

export async function getNjPwcOrphanedRequests(): Promise<{
  data: { requests: NjPwcOrphanedRequest[]; age_threshold_minutes: number } | null;
  error: { message: string } | null;
}> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-orphaned-requests");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Unable to load NJ PWC orphaned requests.");
    return { data: result, error: null };
  } catch (reason) {
    return { data: null, error: { message: reason instanceof Error ? reason.message : "Unable to load NJ PWC orphaned requests." } };
  }
}

export async function recoverNjPwcOrphanedRequest(requestId: number, action: "fail" | "retry" | "resolve"): Promise<{ error: { message: string } | null }> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-orphaned-requests", {
      method: "POST", body: JSON.stringify({ request_id: requestId, action, confirmed: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Unable to recover NJ PWC orphaned request.");
    return { error: null };
  } catch (reason) {
    return { error: { message: reason instanceof Error ? reason.message : "Unable to recover NJ PWC orphaned request." } };
  }
}

export async function getNjPwcSyncExceptions(): Promise<{
  data: { exceptions: NjPwcSyncExceptionItem[]; health: NjPwcSyncHealth; test_mode: boolean; active_run: NjPwcActiveRun | null } | null;
  error: { message: string } | null;
}> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-sync-exceptions");
    const result = await response.json() as { exceptions?: NjPwcSyncExceptionItem[]; health?: NjPwcSyncHealth; test_mode?: boolean; active_run?: NjPwcActiveRun | null; error?: string };
    if (!response.ok || !result.health) throw new Error(result.error ?? "Unable to load NJ PWC sync exceptions.");
    return { data: { exceptions: result.exceptions ?? [], health: result.health, test_mode: result.test_mode === true, active_run: result.active_run ?? null }, error: null };
  } catch (reason) {
    return { data: null, error: { message: reason instanceof Error ? reason.message : "Unable to load NJ PWC sync exceptions." } };
  }
}

export async function stopNjPwcDailyRun(runId: number): Promise<{
  data: { run_id: number; stop_requested: boolean; already_requested: boolean; run_status: string; finished: boolean } | null;
  error: { message: string } | null;
}> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-stop-run", {
      method: "POST",
      body: JSON.stringify({ run_id: runId }),
    });
    const result = await response.json() as {
      run_id?: number; stop_requested?: boolean; already_requested?: boolean;
      run_status?: string; finished?: boolean; error?: string;
    };
    if (!response.ok || typeof result.run_id !== "number" || typeof result.run_status !== "string") {
      throw new Error(result.error ?? "Unable to stop the NJ PWC run.");
    }
    return { data: {
      run_id: result.run_id, stop_requested: result.stop_requested === true,
      already_requested: result.already_requested === true, run_status: result.run_status,
      finished: result.finished === true,
    }, error: null };
  } catch (reason) {
    return {
      data: null,
      error: { message: reason instanceof Error ? reason.message : "Unable to stop the NJ PWC run." },
    };
  }
}

export async function retryNjPwcSyncException(exceptionId: number): Promise<{
  data: { search_request_id: number; created: boolean } | null;
  error: { message: string } | null;
}> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-sync-exceptions", {
      method: "POST",
      body: JSON.stringify({ action: "retry", exception_id: exceptionId }),
    });
    const result = await response.json() as { search_request_id?: number; created?: boolean; error?: string };
    if (!response.ok || typeof result.search_request_id !== "number") {
      throw new Error(result.error ?? "Unable to queue the NJ PWC search.");
    }
    return { data: { search_request_id: result.search_request_id, created: result.created === true }, error: null };
  } catch (reason) {
    return {
      data: null,
      error: { message: reason instanceof Error ? reason.message : "Unable to queue the NJ PWC search." },
    };
  }
}

export async function resolveNjPwcSyncException(exceptionId: number, resetFailureCount: boolean, note?: string): Promise<{ error: { message: string } | null }> {
  return postNjPwcSyncExceptionAction(
    { action: "resolve", exception_id: exceptionId, confirmed: true, reset_failure_count: resetFailureCount, note: note ?? null },
    "Unable to resolve the NJ PWC sync exception.",
  );
}

async function postNjPwcSyncExceptionAction(body: Record<string, unknown>, fallback: string): Promise<{ error: { message: string } | null }> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-sync-exceptions", { method: "POST", body: JSON.stringify(body) });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? fallback);
    return { error: null };
  } catch (reason) {
    return { error: { message: reason instanceof Error ? reason.message : fallback } };
  }
}

export async function getComplianceSyncDashboard(): Promise<{ data: ComplianceSyncDashboard | null; error: { message: string } | null }> {
  const [runsResult, settingsResult, reviewResult, exceptionsResult] = await Promise.all([
    supabase.from("compliance_sync_runs").select("*").order("run_at", { ascending: false }),
    supabase.from("compliance_sync_settings").select("next_sync_at")
      .eq("compliance_name", "NJ PWC").eq("daily_sync_enabled", true)
      .not("next_sync_at", "is", null).limit(1),
    supabase.from("compliance_sync_review_queue").select("status"),
    supabase.from("compliance_sync_exceptions").select("id").eq("resolved", false),
  ]);

  const loadError = runsResult.error || settingsResult.error || reviewResult.error || exceptionsResult.error;
  if (loadError) return { data: null, error: { message: loadError.message } };

  const runs = (runsResult.data ?? []) as ComplianceSyncRun[];
  const reviews = (reviewResult.data ?? []) as Pick<ComplianceSyncReviewEntry, "status">[];

  return {
    data: {
      lastSync: runs[0] ?? null,
      nextScheduledSync: (settingsResult.data?.[0] as { next_sync_at: string } | undefined)?.next_sync_at ?? null,
      recordsChecked: runs.reduce((sum, run) => sum + run.records_checked, 0),
      changesDetected: runs.reduce((sum, run) => sum + run.changes_detected, 0),
      pendingReview: reviews.filter((entry) => entry.status === "pending").length,
      approved: reviews.filter((entry) => entry.status === "approved").length,
      rejected: reviews.filter((entry) => entry.status === "rejected").length,
      failedVerifications: (exceptionsResult.data ?? []).length,
    },
    error: null,
  };
}

export async function getComplianceSyncSettings(): Promise<{ data: ComplianceSyncSetting[] | null; error: { message: string } | null }> {
  const { data, error } = await supabase.from("compliance_sync_settings").select("*").order("compliance_name");
  return { data: (data as ComplianceSyncSetting[] | null) ?? null, error: error ? { message: error.message } : null };
}

export async function updateComplianceSyncSetting(id: number, updates: Partial<Pick<ComplianceSyncSetting, "enabled" | "mode" | "sync_source" | "test_mode" | "failure_expire_threshold">>): Promise<{ error: { message: string } | null }> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/settings", {
      method: "PATCH",
      body: JSON.stringify({ id, ...updates }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) throw new Error(result.error ?? "Unable to update compliance sync setting.");
    return { error: null };
  } catch (reason) {
    return { error: { message: reason instanceof Error ? reason.message : "Unable to update compliance sync setting." } };
  }
}

export async function saveNjPwcDailySyncSchedule(schedule: {
  daily_sync_enabled: boolean;
  daily_sync_start_date: string;
  daily_sync_time: string;
  daily_sync_timezone: "America/New_York";
}): Promise<{ data: { next_sync_at: string | null } | null; error: { message: string } | null }> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-schedule", {
      method: "POST",
      body: JSON.stringify(schedule),
    });
    const result = await response.json() as { next_sync_at?: string | null; error?: string };
    if (!response.ok || result.next_sync_at === undefined) {
      throw new Error(result.error ?? "Unable to save the NJ PWC daily schedule.");
    }
    return { data: { next_sync_at: result.next_sync_at }, error: null };
  } catch (reason) {
    return {
      data: null,
      error: { message: reason instanceof Error ? reason.message : "Unable to save the NJ PWC daily schedule." },
    };
  }
}

export async function runNjPwcDailySyncNow(requestKey: string): Promise<{
  data: { run_id: number; created: boolean; is_test: boolean; run_date: string; run_status: string; already_active: boolean } | null;
  error: { message: string } | null;
}> {
  try {
    const response = await adminFetch("/api/admin/compliance-sync/nj-pwc-run-now", {
      method: "POST",
      body: JSON.stringify({ request_key: requestKey }),
    });
    const result = await response.json() as {
      run_id?: number; created?: boolean; is_test?: boolean; run_date?: string;
      run_status?: string; already_active?: boolean; error?: string;
    };
    if (!response.ok || typeof result.run_id !== "number" || typeof result.run_status !== "string") {
      throw new Error(result.error ?? "Unable to start the NJ PWC sync.");
    }
    return { data: {
      run_id: result.run_id, created: result.created === true, is_test: result.is_test === true,
      run_date: result.run_date ?? "", run_status: result.run_status,
      already_active: result.already_active === true,
    }, error: null };
  } catch (reason) {
    return {
      data: null,
      error: { message: reason instanceof Error ? reason.message : "Unable to start the NJ PWC sync." },
    };
  }
}

export async function getComplianceSyncRuns(limit = 25): Promise<{ data: ComplianceSyncRun[] | null; error: { message: string } | null }> {
  const { data, error } = await supabase.from("compliance_sync_runs").select("*").order("run_at", { ascending: false }).limit(limit);
  return { data: (data as ComplianceSyncRun[] | null) ?? null, error: error ? { message: error.message } : null };
}

export async function getComplianceSyncReviewQueue(status: ReviewStatus | "all" = "pending"): Promise<{ data: ComplianceSyncReviewEntry[] | null; error: { message: string } | null }> {
  let query = supabase
    .from("compliance_sync_review_queue")
    .select("*, contractors(company_name)")
    .order("created_at", { ascending: false });
  if (status !== "all") query = query.eq("status", status);

  const { data, error } = await query;
  const rows = ((data ?? []) as Array<Record<string, unknown> & { contractors?: { company_name: string } | { company_name: string }[] | null }>).map((row) => {
    const contractor = Array.isArray(row.contractors) ? row.contractors[0] : row.contractors;
    const { contractors: _contractors, ...rest } = row;
    return { ...rest, contractor_name: contractor?.company_name ?? "" } as ComplianceSyncReviewEntry;
  });
  return { data: rows, error: error ? { message: error.message } : null };
}

export async function reviewComplianceSyncEntry(id: number, decision: Exclude<ReviewStatus, "pending">, reviewedBy: string, notes?: string): Promise<{ error: { message: string } | null }> {
  const { data: reviewType, error: typeError } = await supabase.from("compliance_sync_review_queue")
    .select("compliance_name").eq("id", id).maybeSingle();
  if (typeError) return { error: { message: typeError.message } };
  if (!reviewType) return { error: { message: "Review item no longer exists or is not accessible." } };
  if (reviewType.compliance_name === "NJ BRC" || reviewType.compliance_name === "NJ PWC") {
    const route = reviewType.compliance_name === "NJ BRC" ? "nj-brc-review" : "nj-pwc-review";
    try {
      const response = await adminFetch(`/api/admin/compliance-sync/${route}`, {
        method: "POST", body: JSON.stringify({ review_id: id, decision, notes: notes ?? null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? `${reviewType.compliance_name} review failed.`);
      return { error: null };
    } catch (reason) {
      return { error: { message: reason instanceof Error ? reason.message : `${reviewType.compliance_name} review failed.` } };
    }
  }
  // Records the admin decision on the review-queue entry. On APPROVAL it
  // additionally writes the proposed (synced) values through to the
  // authoritative Active Compliance Record and, when the certificate number
  // differs, to contractors.nj_pwc_number. Rejection records the decision
  // only. Every approval write-through is fully audited.
  const now = new Date().toISOString();
  const { error } = await supabase
    .from("compliance_sync_review_queue")
    .update({
      status: decision,
      reviewed_by: reviewedBy,
      reviewed_at: now,
      review_notes: notes ?? null,
      approval_source: decision === "approved" ? "Manual Review" : null,
      rejection_reason: decision === "rejected" ? notes ?? null : null,
      updated_at: now,
    })
    .eq("id", id);
  if (error) return { error: { message: error.message } };

  // ---- Approval write-through ----------------------------------------
  // Copy approved NJ PWC values into the authoritative Active Compliance
  // Record and reconcile contractors.nj_pwc_number. Rejections skip this.
  let writethrough: {
    compliance_record_id: number | null;
    contractor_id: number | null;
    registration_number: { old: string | null; new: string | null } | null;
    effective_date: { old: string | null; new: string | null } | null;
    expiration_date: { old: string | null; new: string | null } | null;
    contractor_nj_pwc_number: { old: string | null; new: string | null } | null;
  } | null = null;

  if (decision === "approved") {
    const { data: entry, error: entryError } = await supabase
      .from("compliance_sync_review_queue")
      .select("compliance_record_id, contractor_id, compliance_name, certificate_number, proposed_registration_number, synced_effective_date_proposed, proposed_expiration_date")
      .eq("id", id)
      .maybeSingle();

    if (entryError) return { error: { message: entryError.message } };

    if (entry) {
      const approvedRegistration = (entry.certificate_number ?? entry.proposed_registration_number) || null;
      const approvedEffective = entry.synced_effective_date_proposed ?? null;
      const approvedExpiration = entry.proposed_expiration_date ?? null;

      let promotedRecordId: number | null = null;
      let deactivatedRecordIds: number[] = [];
      let recordOld: { registration_number: string | null; effective_date: string | null; expiration_date: string | null; active: boolean | null; is_current: boolean | null } | null = null;

      // 1) Authoritative Active Compliance Record write-through + promotion.
      if (entry.compliance_record_id) {
        const { data: record, error: recordReadError } = await supabase
          .from("compliance_records")
          .select("registration_number, effective_date, expiration_date, active, is_current, contractor_id, compliance_type_id")
          .eq("id", entry.compliance_record_id)
          .maybeSingle();
        if (recordReadError) return { error: { message: recordReadError.message } };
        recordOld = record ?? null;

        // Deactivate any OTHER active/current record for the same contractor +
        // compliance type so only the approved record remains authoritative.
        if (record?.contractor_id && record?.compliance_type_id) {
          const { data: others, error: othersReadError } = await supabase
            .from("compliance_records")
            .select("id")
            .eq("contractor_id", record.contractor_id)
            .eq("compliance_type_id", record.compliance_type_id)
            .eq("active", true)
            .eq("is_current", true)
            .neq("id", entry.compliance_record_id);
          if (othersReadError) return { error: { message: othersReadError.message } };

          const otherIds = (others ?? []).map((row) => row.id);
          if (otherIds.length > 0) {
            const { error: deactivateError } = await supabase
              .from("compliance_records")
              .update({ active: false, is_current: false })
              .in("id", otherIds);
            if (deactivateError) return { error: { message: deactivateError.message } };
            deactivatedRecordIds = otherIds;

            await supabase.from("administration_audit_log").insert({
              user_name: reviewedBy,
              user_email: "",
              action: "NJ_PWC_PREVIOUS_RECORD_DEACTIVATED",
              object_type: "compliance_sync",
              object_id: String(id),
              object_label: `Review #${id}`,
              details: { deactivated_record_ids: otherIds, promoted_record_id: entry.compliance_record_id, contractor_id: record.contractor_id },
            });
          }
        }

        // Promote the approved record: active/current + approved values.
        const recordUpdates: Record<string, unknown> = { active: true, is_current: true, sync_status: "Approved" };
        if (approvedRegistration !== null) recordUpdates.registration_number = approvedRegistration;
        if (approvedEffective !== null) recordUpdates.effective_date = approvedEffective;
        if (approvedExpiration !== null) recordUpdates.expiration_date = approvedExpiration;

        const { error: recordUpdateError } = await supabase
          .from("compliance_records")
          .update(recordUpdates)
          .eq("id", entry.compliance_record_id);
        if (recordUpdateError) return { error: { message: recordUpdateError.message } };
        promotedRecordId = entry.compliance_record_id;

        await supabase.from("administration_audit_log").insert({
          user_name: reviewedBy,
          user_email: "",
          action: "NJ_PWC_RECORD_PROMOTED",
          object_type: "compliance_sync",
          object_id: String(id),
          object_label: `Review #${id}`,
          details: {
            record_id: entry.compliance_record_id,
            contractor_id: entry.contractor_id ?? null,
            registration_number: { old: recordOld?.registration_number ?? null, new: approvedRegistration },
            effective_date: { old: recordOld?.effective_date ?? null, new: approvedEffective },
            expiration_date: { old: recordOld?.expiration_date ?? null, new: approvedExpiration },
            active: { old: recordOld?.active ?? null, new: true },
            is_current: { old: recordOld?.is_current ?? null, new: true },
            deactivated_record_ids: deactivatedRecordIds,
          },
        });

        writethrough = {
          compliance_record_id: entry.compliance_record_id,
          contractor_id: entry.contractor_id ?? null,
          registration_number: approvedRegistration !== (record?.registration_number ?? null) ? { old: record?.registration_number ?? null, new: approvedRegistration } : null,
          effective_date: approvedEffective !== (record?.effective_date ?? null) ? { old: record?.effective_date ?? null, new: approvedEffective } : null,
          expiration_date: approvedExpiration !== (record?.expiration_date ?? null) ? { old: record?.expiration_date ?? null, new: approvedExpiration } : null,
          contractor_nj_pwc_number: null,
        };
      }

      // 2) Reconcile contractors.nj_pwc_number for NJ PWC approvals when it differs.
      if (entry.compliance_name === "NJ PWC" && entry.contractor_id && approvedRegistration !== null) {
        const { data: contractor, error: contractorReadError } = await supabase
          .from("contractors")
          .select("nj_pwc_number")
          .eq("id", entry.contractor_id)
          .maybeSingle();
        if (contractorReadError) return { error: { message: contractorReadError.message } };

        if (contractor && contractor.nj_pwc_number !== approvedRegistration) {
          const { error: contractorUpdateError } = await supabase
            .from("contractors")
            .update({ nj_pwc_number: approvedRegistration })
            .eq("id", entry.contractor_id);
          if (contractorUpdateError) return { error: { message: contractorUpdateError.message } };

          writethrough = {
            compliance_record_id: entry.compliance_record_id ?? null,
            contractor_id: entry.contractor_id,
            registration_number: writethrough?.registration_number ?? null,
            effective_date: writethrough?.effective_date ?? null,
            expiration_date: writethrough?.expiration_date ?? null,
            contractor_nj_pwc_number: { old: contractor.nj_pwc_number ?? null, new: approvedRegistration },
          };
        }
      }
    }
  }

  await supabase.from("administration_audit_log").insert({
    user_name: reviewedBy,
    user_email: "",
    action: decision === "approved" ? "NJ_BRC_SYNC_REVIEW_APPROVED" : "NJ_BRC_SYNC_REVIEW_REJECTED",
    object_type: "compliance_sync",
    object_id: String(id),
    object_label: `Review #${id}`,
    details: {
      decision,
      reviewed_by: reviewedBy,
      reviewed_at: now,
      rejection_reason: decision === "rejected" ? notes ?? null : null,
      ...(writethrough ? { writethrough } : {}),
    },
  });
  return { error: null };
}

export async function getComplianceSyncExceptions(resolved = false): Promise<{ data: ComplianceSyncException[] | null; error: { message: string } | null }> {
  const { data, error } = await supabase.from("compliance_sync_exceptions").select("*").eq("resolved", resolved).order("created_at", { ascending: false });
  return { data: (data as ComplianceSyncException[] | null) ?? null, error: error ? { message: error.message } : null };
}

export async function resolveComplianceSyncException(id: number, resolvedBy: string): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase
    .from("compliance_sync_exceptions")
    .update({ resolved: true, resolved_by: resolvedBy, resolved_at: new Date().toISOString() })
    .eq("id", id);
  return { error: error ? { message: error.message } : null };
}

export interface NjPwcSearchStats {
  lastRequestReceived: string | null;
  lastResultSubmitted: string | null;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
}

// Attended Add Contractor → Search NJ PWC request statistics (admin/testing
// display only). Reads compliance_sync_search_requests; never touches Active
// Compliance Records or dashboard counts.
export async function getNjPwcSearchStats(): Promise<{ data: NjPwcSearchStats | null; error: { message: string } | null }> {
  const { data, error } = await supabase
    .from("compliance_sync_search_requests")
    .select("status, created_at, completed_at")
    .eq("compliance_name", "NJ PWC");
  if (error) return { data: null, error: { message: error.message } };

  const rows = (data ?? []) as { status: string; created_at: string; completed_at: string | null }[];
  const latest = (values: (string | null)[]): string | null =>
    values.filter((value): value is string => Boolean(value)).sort().reverse()[0] ?? null;

  return {
    data: {
      lastRequestReceived: latest(rows.map((row) => row.created_at)),
      lastResultSubmitted: latest(rows.map((row) => row.completed_at)),
      pendingCount: rows.filter((row) => ["pending", "claimed", "processing"].includes(row.status)).length,
      completedCount: rows.filter((row) => row.status === "completed").length,
      failedCount: rows.filter((row) => row.status === "failed").length,
    },
    error: null,
  };
}
