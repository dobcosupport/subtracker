import { supabase } from "@/lib/supabase";

// =====================================================================
// Compliance Sync Administration service
//
// COMPLIANCE LOGIC: This module reads and writes sync-run metadata,
// review-queue entries, settings, and exceptions. Review decisions are
// recorded here. On APPROVAL of an NJ PWC entry, the approved values are
// written through to the authoritative compliance_records
// (registration_number / effective_date / expiration_date) and, when the
// certificate number differs, to contractors.nj_pwc_number. Rejections
// record the decision only. All write-through is fully audited.
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
  schedule_cron: string | null;
  last_sync_at: string | null;
  next_sync_at: string | null;
}

export interface ComplianceSyncRun {
  id: number;
  run_at: string;
  sync_source: SyncSource;
  status: SyncRunStatus;
  records_checked: number;
  changes_detected: number;
  records_approved: number;
  records_rejected: number;
  failures: number;
  triggered_by: string | null;
  notes: string | null;
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

export async function getComplianceSyncDashboard(): Promise<{ data: ComplianceSyncDashboard | null; error: { message: string } | null }> {
  const [runsResult, settingsResult, reviewResult, exceptionsResult] = await Promise.all([
    supabase.from("compliance_sync_runs").select("*").order("run_at", { ascending: false }),
    supabase.from("compliance_sync_settings").select("next_sync_at").not("next_sync_at", "is", null).order("next_sync_at", { ascending: true }).limit(1),
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

export async function updateComplianceSyncSetting(id: number, updates: Partial<Pick<ComplianceSyncSetting, "enabled" | "mode" | "sync_source" | "test_mode" | "schedule_cron" | "next_sync_at">>): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase.from("compliance_sync_settings").update({ ...updates, updated_at: new Date().toISOString() }).eq("id", id);
  return { error: error ? { message: error.message } : null };
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
      pendingCount: rows.filter((row) => row.status === "pending").length,
      completedCount: rows.filter((row) => row.status === "completed").length,
      failedCount: rows.filter((row) => row.status === "failed").length,
    },
    error: null,
  };
}
