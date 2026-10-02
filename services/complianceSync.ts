import { supabase } from "@/lib/supabase";

// =====================================================================
// Compliance Sync Administration service
//
// COMPLIANCE LOGIC LOCK: This module is administrative/informational
// only. It reads and writes sync-run metadata, review-queue entries,
// settings, and exceptions. It NEVER writes to the authoritative
// compliance_records.expiration_date / registration_number used by the
// contractor_compliance_status view, dashboard counts, reports, or
// reminders. Approving a review entry records a decision only; wiring
// approvals to update Active Compliance Records is future work.
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
  // Records the admin decision only. Does NOT update the Active
  // Compliance Record (compliance_records) — automatic write-through will
  // be enabled only after the NJ BRC RPA workflow has been validated.
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

  await supabase.from("administration_audit_log").insert({
    user_name: reviewedBy,
    user_email: "",
    action: decision === "approved" ? "NJ_BRC_SYNC_REVIEW_APPROVED" : "NJ_BRC_SYNC_REVIEW_REJECTED",
    object_type: "compliance_sync",
    object_id: String(id),
    object_label: `Review #${id}`,
    details: { decision, reviewed_by: reviewedBy, reviewed_at: now, rejection_reason: decision === "rejected" ? notes ?? null : null },
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
