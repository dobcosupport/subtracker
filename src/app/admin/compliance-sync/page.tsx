"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import WorkerHealthPanel from "@/components/compliance-sync/WorkerHealthPanel";
import { NjBrcReviewEvidence } from "@/components/compliance-sync/NjBrcRequestPanel";
import NjPwcRegistryMatchDialog, { NjPwcRegistryComparison } from "@/components/compliance-sync/NjPwcRegistryMatchDialog";
import type { NjPwcRegistryMatch } from "@/lib/nj-pwc-registry-fields";
import {
  getComplianceSyncDashboard,
  getComplianceSyncExceptions,
  getComplianceSyncReviewQueue,
  getComplianceSyncRuns,
  getComplianceSyncSettings,
  getNjBrcOrphanedRequests,
  getNjPwcSearchStats,
  getNjPwcSyncExceptions,
  getNjPwcOrphanedRequests,
  recoverNjPwcOrphanedRequest,
  type NjPwcOrphanedRequest,
  recoverNjBrcOrphanedRequest,
  resolveNjPwcSyncException,
  retryNjPwcSyncException,
  resolveComplianceSyncException,
  reviewComplianceSyncEntry,
  updateComplianceSyncSetting,
  type ComplianceSyncDashboard,
  type ComplianceSyncException,
  type ComplianceSyncReviewEntry,
  type ComplianceSyncRun,
  type ComplianceSyncSetting,
  type NjPwcSearchStats,
  type NjBrcOrphanedRequest,
  type NjPwcSyncExceptionItem,
  type NjPwcSyncHealth,
  type ReviewStatus,
  type SyncMode,
  type SyncSource,
} from "@/services/complianceSync";

const syncSources: SyncSource[] = ["Manual", "RPA", "API"];
const syncModes: { value: SyncMode; label: string }[] = [
  { value: "review_required", label: "Review Required" },
  { value: "auto_approve", label: "Auto Approve" },
];

const reviewStatusStyles: Record<ReviewStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
};

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function ComplianceSyncPage() {
  const [dashboard, setDashboard] = useState<ComplianceSyncDashboard | null>(null);
  const [settings, setSettings] = useState<ComplianceSyncSetting[]>([]);
  const [runs, setRuns] = useState<ComplianceSyncRun[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ComplianceSyncReviewEntry[]>([]);
  const [exceptions, setExceptions] = useState<ComplianceSyncException[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewStatus | "all">("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [acting, setActing] = useState<number | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testContractorId, setTestContractorId] = useState("");
  const [testLookupBusy, setTestLookupBusy] = useState(false);
  const [testPwcContractorId, setTestPwcContractorId] = useState("");
  const [testPwcLookupBusy, setTestPwcLookupBusy] = useState(false);
  const [searchStats, setSearchStats] = useState<NjPwcSearchStats | null>(null);
  const [searchEndpointTesting, setSearchEndpointTesting] = useState(false);
  const [searchEndpointResult, setSearchEndpointResult] = useState<string | null>(null);
  const [testResultRequestId, setTestResultRequestId] = useState("");
  const [testResultOutcome, setTestResultOutcome] = useState<"Match Found" | "No Match Found" | "Multiple Matches" | "Failed">("Match Found");
  const [testResultBusy, setTestResultBusy] = useState(false);
  const [cleanupRows, setCleanupRows] = useState<{ id: number; company_name: string; nj_pwc_number: string | null; active: boolean; created_at: string }[]>([]);
  const [cleanupSelected, setCleanupSelected] = useState<Set<number>>(new Set());
  const [cleanupBusy, setCleanupBusy] = useState(false);
  const [orphanedRequests, setOrphanedRequests] = useState<NjBrcOrphanedRequest[]>([]);
  const [orphanAgeThresholdMinutes, setOrphanAgeThresholdMinutes] = useState(10);
  const [orphanRecoveryBusy, setOrphanRecoveryBusy] = useState<string | null>(null);
  const [njPwcSyncExceptions, setNjPwcSyncExceptions] = useState<NjPwcSyncExceptionItem[]>([]);
  const [njPwcSyncHealth, setNjPwcSyncHealth] = useState<NjPwcSyncHealth | null>(null);
  const [njPwcSyncTestMode, setNjPwcSyncTestMode] = useState(false);
  const [njPwcSyncError, setNjPwcSyncError] = useState<string | null>(null);
  const [njPwcExceptionBusy, setNjPwcExceptionBusy] = useState<number | null>(null);
  const [njPwcOrphans, setNjPwcOrphans] = useState<NjPwcOrphanedRequest[]>([]);
  const [njPwcOrphanError, setNjPwcOrphanError] = useState<string | null>(null);
  const [njPwcOrphanBusy, setNjPwcOrphanBusy] = useState<number | null>(null);
  const [njPwcOrphanAge, setNjPwcOrphanAge] = useState(10);
  const [njPwcRegistryMatch, setNjPwcRegistryMatch] = useState<NjPwcRegistryMatch | null>(null);

  const origin = typeof window === "undefined" ? "" : window.location.origin;
  const rpaEndpoints = [
    { label: "Work Items", method: "GET", path: "/api/integrations/compliance-sync/work-items" },
    { label: "Start Run", method: "POST", path: "/api/integrations/compliance-sync/runs" },
    { label: "Submit Result", method: "POST", path: "/api/integrations/compliance-sync/results" },
    { label: "Complete Run", method: "POST", path: "/api/integrations/compliance-sync/runs/{id}/complete" },
  ];

  const copyToClipboard = async (text: string) => {
    await navigator.clipboard.writeText(text);
    setSuccess("Copied to clipboard.");
  };

  const handleTestConnection = async () => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/test-connection");
      const result = await response.json() as { ok?: boolean; checks?: Record<string, boolean>; missing_tables?: string[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Test failed.");
      const missing = result.missing_tables ?? [];
      setTestResult(
        `Endpoint reachable: Yes\nAuthentication: Yes\nRPA key configured: ${result.checks?.rpa_key_configured ? "Yes" : "No"}\nRequired tables exist: ${result.checks?.tables_exist ? "Yes" : `No (missing: ${missing.join(", ")})`}`
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Test connection failed.");
    } finally {
      setTesting(false);
    }
  };

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [dashboardResult, settingsResult, runsResult, reviewResult, exceptionsResult, orphanedResult, njPwcSyncResult, njPwcOrphanResult] = await Promise.all([
      getComplianceSyncDashboard(),
      getComplianceSyncSettings(),
      getComplianceSyncRuns(),
      getComplianceSyncReviewQueue(reviewFilter),
      getComplianceSyncExceptions(),
      getNjBrcOrphanedRequests(),
      getNjPwcSyncExceptions(),
      getNjPwcOrphanedRequests(),
    ]);
    // NJ PWC sync data loads independently so a failure there never hides
    // the rest of the Compliance Sync page.
    setNjPwcSyncError(njPwcSyncResult.error?.message ?? null);
    setNjPwcSyncExceptions(njPwcSyncResult.data?.exceptions ?? []);
    setNjPwcSyncHealth(njPwcSyncResult.data?.health ?? null);
    setNjPwcSyncTestMode(njPwcSyncResult.data?.test_mode ?? false);
    setNjPwcOrphans(njPwcOrphanResult.data?.requests ?? []);
    setNjPwcOrphanError(njPwcOrphanResult.error?.message ?? null);
    setNjPwcOrphanAge(njPwcOrphanResult.data?.age_threshold_minutes ?? 10);
    if (orphanedResult.error) {
      setOrphanedRequests([]);
    } else {
      setOrphanedRequests(orphanedResult.data?.requests ?? []);
      setOrphanAgeThresholdMinutes(orphanedResult.data?.age_threshold_minutes ?? 10);
    }
    const loadError = dashboardResult.error || settingsResult.error || runsResult.error || reviewResult.error || exceptionsResult.error || orphanedResult.error;
    if (loadError) {
      setError(loadError.message);
    } else {
      setDashboard(dashboardResult.data);
      setSettings(settingsResult.data ?? []);
      setRuns(runsResult.data ?? []);
      setReviewQueue(reviewResult.data ?? []);
      setExceptions(exceptionsResult.data ?? []);
    }
    const { data: stats } = await getNjPwcSearchStats();
    setSearchStats(stats);
    setLoading(false);
  }, [reviewFilter]);

  const handleRecoverOrphanedRequest = async (item: NjBrcOrphanedRequest) => {
    if (!window.confirm("This request appears orphaned. Mark as Website Error?")) return;
    setOrphanRecoveryBusy(item.request_id);
    setError(null);
    setSuccess(null);
    const { error: recoveryError } = await recoverNjBrcOrphanedRequest(item.request_id);
    setOrphanRecoveryBusy(null);
    if (recoveryError) {
      setError(recoveryError.message);
      return;
    }
    setSuccess(`${item.contractor}: orphaned NJ BRC request marked as Website Error.`);
    void loadAll();
  };

  const handleRecoverNjPwcOrphan = async (item: NjPwcOrphanedRequest, action: "fail" | "retry" | "resolve") => {
    const description = action === "retry" ? "close the abandoned request and queue a linked retry" : action === "resolve" ? "resolve the abandoned request without a new search" : "mark the abandoned request failed";
    if (!window.confirm(`Confirm ${description} for ${item.contractor}? The old worker cannot submit a result afterward.`)) return;
    setNjPwcOrphanBusy(item.request_id);
    setError(null);
    setSuccess(null);
    const result = await recoverNjPwcOrphanedRequest(item.request_id, action);
    setNjPwcOrphanBusy(null);
    if (result.error) setError(result.error.message);
    else {
      setSuccess(`${item.contractor}: NJ PWC orphan recovery completed.`);
      void loadAll();
    }
  };

  const handleRetryNjPwcException = async (item: NjPwcSyncExceptionItem) => {
    setNjPwcExceptionBusy(item.id);
    setError(null);
    setSuccess(null);
    const { error: retryError } = await retryNjPwcSyncException(item.id);
    setNjPwcExceptionBusy(null);
    if (retryError) {
      setError(retryError.message);
      return;
    }
    setSuccess(`${item.contractor}: NJ PWC search queued.`);
    void loadAll();
  };

  const handleCompareNjPwcMatch = async (item: NjPwcSyncExceptionItem) => {
    setNjPwcExceptionBusy(item.id);
    setError(null);
    try {
      const response = await adminFetch(`/api/admin/compliance-sync/nj-pwc-registry-match?exception_id=${item.id}`);
      const result = await response.json() as { comparison?: NjPwcRegistryMatch; error?: string };
      if (!response.ok || !result.comparison) throw new Error(result.error ?? "Unable to load registry comparison.");
      setNjPwcRegistryMatch(result.comparison);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load registry comparison.");
    } finally { setNjPwcExceptionBusy(null); }
  };

  const handleResolveNjPwcException = async (item: NjPwcSyncExceptionItem) => {
    if (!window.confirm(`Resolve the "${item.reason}" exception for ${item.contractor}?`)) return;
    const resetFailureCount = item.consecutive_failure_count > 0
      && window.confirm(`Also reset the consecutive failure count (${item.consecutive_failure_count}) to 0?`);
    const note = window.prompt("Resolution note (optional):") ?? undefined;
    setNjPwcExceptionBusy(item.id);
    setError(null);
    setSuccess(null);
    const { error: resolveError } = await resolveNjPwcSyncException(item.id, resetFailureCount, note);
    setNjPwcExceptionBusy(null);
    if (resolveError) {
      setError(resolveError.message);
      return;
    }
    setSuccess(`${item.contractor}: NJ PWC sync exception resolved.`);
    void loadAll();
  };

  const handleSettingChange = async (setting: ComplianceSyncSetting, updates: Partial<Pick<ComplianceSyncSetting, "enabled" | "mode" | "sync_source" | "test_mode" | "failure_expire_threshold">>) => {
    if (setting.compliance_name === "NJ PWC" && setting.test_mode && updates.test_mode === false
      && !window.confirm("Turn off NJ PWC Test Mode? The daily sync will begin modifying compliance records and statuses according to Mode.")) {
      return;
    }
    const { error: updateError } = await updateComplianceSyncSetting(setting.id, updates);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSuccess(`${setting.compliance_name} settings updated.`);
    void loadAll();
  };

  const handleReview = async (entry: ComplianceSyncReviewEntry, decision: Exclude<ReviewStatus, "pending">) => {
    setActing(entry.id);
    setError(null);
    let reason: string | undefined;
    if (decision === "rejected") {
      const input = window.prompt("Rejection reason (required):");
      if (input === null || input.trim() === "") {
        setActing(null);
        setError("A rejection reason is required.");
        return;
      }
      reason = input.trim();
    }
    const { error: reviewError } = await reviewComplianceSyncEntry(entry.id, decision, "Administrator", reason);
    setActing(null);
    if (reviewError) {
      setError(reviewError.message);
      return;
    }
    setSuccess(`Review entry ${decision}. (Records the decision only — Active Compliance Records are unchanged.)`);
    void loadAll();
  };

  const handleTestNjBrcLookup = async () => {
    const id = Number(testContractorId);
    if (!Number.isInteger(id) || id <= 0) {
      setError("Enter a valid contractor ID to test.");
      return;
    }
    setTestLookupBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/test-nj-brc", { method: "POST", body: JSON.stringify({ contractor_id: id }) });
      const result = await response.json() as { message?: string; error?: string; review_queue_id?: number };
      if (!response.ok) throw new Error(result.error ?? "Test lookup failed.");
      setSuccess(result.message ?? "NJ BRC test complete.");
      void loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Test lookup failed.");
    } finally {
      setTestLookupBusy(false);
    }
  };

  const handleTestNjPwcLookup = async () => {
    const id = Number(testPwcContractorId);
    if (!Number.isInteger(id) || id <= 0) {
      setError("Enter a valid contractor ID to test.");
      return;
    }
    setTestPwcLookupBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/test-nj-pwc", { method: "POST", body: JSON.stringify({ contractor_id: id }) });
      const result = await response.json() as { message?: string; error?: string; review_queue_id?: number };
      if (!response.ok) throw new Error(result.error ?? "Test lookup failed.");
      setSuccess(result.message ?? "NJ PWC test complete.");
      void loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Test lookup failed.");
    } finally {
      setTestPwcLookupBusy(false);
    }
  };

  const handleCreateTestNjPwcResult = async () => {
    const id = Number(testResultRequestId);
    if (!Number.isInteger(id) || id <= 0) {
      setError("Enter a valid search request ID to simulate.");
      return;
    }
    setTestResultBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/create-test-nj-pwc-result", { method: "POST", body: JSON.stringify({ search_request_id: id, outcome: testResultOutcome }) });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Failed to create test result.");
      setSuccess(result.message ?? "Test result created.");
      void loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Failed to create test result.");
    } finally {
      setTestResultBusy(false);
    }
  };

  const loadCleanupRows = useCallback(async () => {
    try {
      const response = await adminFetch("/api/admin/compliance-sync/test-data-cleanup");
      const result = await response.json() as { contractors?: { id: number; company_name: string; nj_pwc_number: string | null; active: boolean; created_at: string }[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Unable to load test data.");
      setCleanupRows(result.contractors ?? []);
      setCleanupSelected(new Set());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load test data.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAll();
      void loadCleanupRows();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAll, loadCleanupRows]);

  const handleDeleteTestData = async () => {
    const ids = [...cleanupSelected];
    if (ids.length === 0) {
      setError("Select at least one test record to delete.");
      return;
    }
    const confirmed = window.confirm("This will permanently delete selected test contractors and any test NJ PWC tracking records associated with them.\n\nContinue?");
    if (!confirmed) return;
    setCleanupBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/test-data-cleanup", { method: "POST", body: JSON.stringify({ contractor_ids: ids }) });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Cleanup failed.");
      setSuccess(result.message ?? "Test data deleted.");
      await loadCleanupRows();
      void loadAll();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Cleanup failed.");
    } finally {
      setCleanupBusy(false);
    }
  };

  const handleTestSearchEndpoint = async () => {
    setSearchEndpointTesting(true);
    setSearchEndpointResult(null);
    setError(null);
    try {
      const response = await adminFetch("/api/admin/compliance-sync/test-search-requests");
      const result = await response.json() as { ok?: boolean; checks?: Record<string, boolean>; error?: string };
      if (!response.ok) throw new Error(result.error ?? "Test failed.");
      setSearchEndpointResult(
        `Endpoint reachable: Yes\nAuthentication: Yes\nRPA key configured: ${result.checks?.rpa_key_configured ? "Yes" : "No"}\nSearch requests table exists: ${result.checks?.search_requests_table_exists ? "Yes" : "No"}`
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Test endpoint failed.");
    } finally {
      setSearchEndpointTesting(false);
    }
  };

  const handleResolveException = async (exception: ComplianceSyncException) => {
    setActing(exception.id);
    const { error: resolveError } = await resolveComplianceSyncException(exception.id, "Administrator");
    setActing(null);
    if (resolveError) {
      setError(resolveError.message);
      return;
    }
    setSuccess("Exception marked resolved.");
    void loadAll();
  };

  const summaryCards = [
    { label: "Last Sync", value: dashboard?.lastSync ? formatDateTime(dashboard.lastSync.run_at) : "Never Synced", tone: "text-slate-800" },
    { label: "Next Scheduled Sync", value: dashboard?.nextScheduledSync ? formatDateTime(dashboard.nextScheduledSync) : "Not Scheduled", tone: "text-slate-800" },
    { label: "Records Checked", value: String(dashboard?.recordsChecked ?? 0), tone: "text-slate-800" },
    { label: "Changes Detected", value: String(dashboard?.changesDetected ?? 0), tone: "text-sky-700" },
    { label: "Pending Review", value: String(dashboard?.pendingReview ?? 0), tone: "text-amber-700" },
    { label: "Approved", value: String(dashboard?.approved ?? 0), tone: "text-emerald-700" },
    { label: "Rejected", value: String(dashboard?.rejected ?? 0), tone: "text-red-700" },
    { label: "Failed Verifications", value: String(dashboard?.failedVerifications ?? 0), tone: "text-red-700" },
    { label: "Orphaned NJ BRC Requests", value: String(orphanedRequests.length), tone: "text-amber-700" },
  ];

  const dryRunValue = (count: number | null | undefined) => (njPwcSyncTestMode ? String(count ?? 0) : "Test Mode off");
  const dryRunHint = (count: number | null | undefined, action: string) =>
    njPwcSyncTestMode && count ? `${count} would ${action} (Review Required mode)` : undefined;

  const njPwcHealthCards: { label: string; value: string; tone: string; hint?: string }[] = [
    { label: "Open Exceptions", value: String(njPwcSyncHealth?.open_exceptions ?? 0), tone: "text-amber-700" },
    { label: "Review Required", value: String(njPwcSyncHealth?.review_required ?? 0), tone: "text-amber-700" },
    { label: "Expired by Sync", value: String(njPwcSyncHealth?.expired_by_sync ?? 0), tone: "text-red-700" },
    { label: "Registry Unavailable", value: String(njPwcSyncHealth?.registry_unavailable ?? 0), tone: "text-red-700" },
    {
      label: "Would Auto Approve",
      value: dryRunValue(njPwcSyncHealth?.would_auto_approve),
      tone: njPwcSyncTestMode ? "text-sky-700" : "text-slate-400",
      hint: dryRunHint(njPwcSyncHealth?.would_request_review, "be routed to review"),
    },
    {
      label: "Would Expire",
      value: dryRunValue(njPwcSyncHealth?.would_expire),
      tone: njPwcSyncTestMode ? "text-sky-700" : "text-slate-400",
      hint: dryRunHint(njPwcSyncHealth?.would_propose_expiration, "have expiration proposed"),
    },
    {
      label: "Last Successful Daily Run",
      value: njPwcSyncHealth?.last_successful_daily_run ? formatDateTime(njPwcSyncHealth.last_successful_daily_run.completed_at) : "Never",
      tone: "text-slate-800",
    },
  ];

  const njPwcTestModeOn = settings.find((setting) => setting.compliance_name === "NJ PWC")?.test_mode ?? njPwcSyncTestMode;

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl space-y-6">
        <header>
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Administration</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Compliance Sync</h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
            Administrative foundation for future NJ and NY compliance verification (Manual, RPA, and API). Active Compliance Records remain the sole authoritative source for dashboard counts, expiration buckets (90/60/30 Day, Expired, Missing Information), contractor status, reports, and reminders — synced data does not affect those calculations.
          </p>
        </header>
        <WorkerHealthPanel />

        {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
        {success ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div> : null}

        {njPwcTestModeOn ? (
          <div role="status" data-testid="nj-pwc-test-mode-banner" className="rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            <p className="font-semibold">NJ PWC Daily Sync running in TEST MODE.</p>
            <p>Searches and exception detection are active.</p>
            <p>Compliance records and statuses are NOT being modified.</p>
          </div>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {summaryCards.map((card) => (
            <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <p className="text-sm text-slate-500">{card.label}</p>
              <p className={`mt-3 text-xl font-semibold ${card.tone}`}>{loading ? "…" : card.value}</p>
            </div>
          ))}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">Compliance Sync Settings</h2>
          <p className="mt-1 text-sm text-slate-500">Per-type approval mode and sync source. For NJ PWC, Mode is the master switch: Review Required routes imports and daily-sync results to the Review Queue; Auto Approve applies user-selected imports and high-confidence daily-sync matches automatically (low-confidence results always require review). NJ PWC Test Mode is the daily-sync shadow mode: searches, classification, exceptions, failure counts, and statistics run, but compliance records and statuses are not modified (user-selected imports still follow Mode). Failure Threshold is the number of consecutive No Match / Multiple Matches / Name Mismatch results before an NJ PWC registration is expired.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[700px] border-collapse text-left">
              <thead className="bg-slate-50">
                <tr>{["Compliance Type", "Enabled", "Mode", "Sync Source", "Test Mode", "Failure Threshold", "Last Sync"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {settings.map((setting) => (
                  <tr key={setting.id}>
                    <td className="border border-slate-200 px-4 py-3 text-sm font-medium">{setting.compliance_name}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      <input type="checkbox" aria-label={`${setting.compliance_name} enabled`} checked={setting.enabled} onChange={(event) => void handleSettingChange(setting, { enabled: event.target.checked })} className="h-4 w-4" />
                    </td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      <select aria-label={`${setting.compliance_name} mode`} value={setting.mode} onChange={(event) => void handleSettingChange(setting, { mode: event.target.value as SyncMode })} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm">
                        {syncModes.map((mode) => <option key={mode.value} value={mode.value} disabled={setting.compliance_name === "NJ BRC" && mode.value === "auto_approve"}>{mode.label}{setting.compliance_name === "NJ BRC" && mode.value === "auto_approve" ? " (Locked)" : ""}</option>)}
                      </select>
                    </td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      <select aria-label={`${setting.compliance_name} sync source`} value={setting.sync_source} onChange={(event) => void handleSettingChange(setting, { sync_source: event.target.value as SyncSource })} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm">
                        {syncSources.map((source) => <option key={source} value={source}>{source}</option>)}
                      </select>
                    </td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      <input type="checkbox" aria-label={`${setting.compliance_name} test mode`} checked={setting.test_mode ?? false} onChange={(event) => void handleSettingChange(setting, { test_mode: event.target.checked })} className="h-4 w-4" />
                    </td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      {setting.compliance_name === "NJ PWC" ? (
                        <input
                          key={`threshold-${setting.id}-${setting.failure_expire_threshold ?? 3}`}
                          type="number"
                          min={1}
                          max={30}
                          aria-label="NJ PWC failure threshold"
                          defaultValue={setting.failure_expire_threshold ?? 3}
                          onBlur={(event) => {
                            const current = setting.failure_expire_threshold ?? 3;
                            const value = Number(event.target.value);
                            if (!Number.isInteger(value) || value < 1 || value > 30) {
                              setError("Failure Threshold must be a whole number between 1 and 30.");
                              event.target.value = String(current);
                              return;
                            }
                            if (value !== current) void handleSettingChange(setting, { failure_expire_threshold: value });
                          }}
                          className="w-20 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm"
                        />
                      ) : "—"}
                    </td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{setting.last_sync_at ? formatDateTime(setting.last_sync_at) : "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {settings.length === 0 && !loading ? <p className="p-5 text-sm text-slate-500">No sync settings configured. Run the compliance sync admin migration.</p> : null}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">RPA Integration (Testing)</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
            Server-side endpoints for the future Microsoft Power Automate Desktop flow. Set the <span className="font-medium text-slate-700">COMPLIANCE_SYNC_RPA_KEY</span> environment variable (server-only), then pass it in the <span className="font-medium text-slate-700">x-subtracker-rpa-key</span> header. The key is never displayed here. See docs/COMPLIANCE_SYNC_RPA.md for full field mapping.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[600px] border-collapse text-left">
              <thead className="bg-slate-50">
                <tr>{["Endpoint", "Method", "Path", ""].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {rpaEndpoints.map((endpoint) => (
                  <tr key={endpoint.label}>
                    <td className="border border-slate-200 px-4 py-3 text-sm font-medium">{endpoint.label}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{endpoint.method}</span></td>
                    <td className="border border-slate-200 px-4 py-3 font-mono text-xs text-slate-600">{endpoint.path}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm"><button type="button" onClick={() => void copyToClipboard(`${origin}${endpoint.path}`)} className="font-medium text-indigo-600">Copy Endpoint</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={testing} onClick={() => void handleTestConnection()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-60">
              {testing ? "Testing..." : "Test Connection"}
            </button>
            <span className="text-xs text-slate-400">Confirms reachability, authentication, and required tables. No website lookup is performed.</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
            <label className="text-sm font-medium text-slate-700">Test NJ BRC Lookup (Testing Only)
              <input type="text" inputMode="numeric" value={testContractorId} onChange={(event) => setTestContractorId(event.target.value)} placeholder="Contractor ID" className="ml-2 w-36 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <button type="button" disabled={testLookupBusy} onClick={() => void handleTestNjBrcLookup()} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-60">
              {testLookupBusy ? "Running..." : "Test NJ BRC Lookup"}
            </button>
            <span className="text-xs text-slate-400">Processes one contractor, creates a test run + review result labeled Testing Only, and never updates Active Compliance Records. Requires NJ BRC Test Mode enabled. First test is attended.</span>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
            <label className="text-sm font-medium text-slate-700">Test NJ PWC Lookup (Testing Only)
              <input type="text" inputMode="numeric" value={testPwcContractorId} onChange={(event) => setTestPwcContractorId(event.target.value)} placeholder="Contractor ID" className="ml-2 w-36 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <button type="button" disabled={testPwcLookupBusy} onClick={() => void handleTestNjPwcLookup()} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-60">
              {testPwcLookupBusy ? "Running..." : "Test NJ PWC Lookup"}
            </button>
            <span className="text-xs text-slate-400">Looks up one contractor on the NJ Public Works Power BI report by Certificate # / Business Name, creates a test run + review result labeled Testing Only, and never updates Active Compliance Records. Requires NJ PWC Test Mode enabled.</span>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-4">
            <label className="text-sm font-medium text-slate-700">Create Test NJ PWC Result (Testing Only)
              <input type="text" inputMode="numeric" value={testResultRequestId} onChange={(event) => setTestResultRequestId(event.target.value)} placeholder="Search Request ID" className="ml-2 w-40 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <select aria-label="Test outcome" value={testResultOutcome} onChange={(event) => setTestResultOutcome(event.target.value as typeof testResultOutcome)} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <option value="Match Found">Match Found</option>
              <option value="No Match Found">No Match Found</option>
              <option value="Multiple Matches">Multiple Matches</option>
              <option value="Failed">Failed</option>
            </select>
            <button type="button" disabled={testResultBusy} onClick={() => void handleCreateTestNjPwcResult()} className="rounded-xl border border-indigo-200 px-4 py-2.5 text-sm font-medium text-indigo-600 hover:bg-indigo-50 disabled:opacity-60">
              {testResultBusy ? "Running..." : "Create Test NJ PWC Result"}
            </button>
            <span className="text-xs text-slate-400">Simulates Power Automate Desktop output for a pending search request (no PAD required). Match Found returns candidate ABCO / Certificate # 123456. Updates the search request only — never Active Compliance Records.</span>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-900">NJ PWC Search Request Endpoints</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">
              <span className="font-medium text-slate-700">Add Contractor → Search NJ PWC</span> creates a search request. Power Automate Desktop retrieves the request, searches the NJ Public Works registry, and submits candidate matches back to SubTracker.
            </p>
            <div className="mt-3 space-y-3">
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-sm font-medium text-slate-800">NJ PWC Search Request Endpoint</p>
                <p className="mt-0.5 text-xs text-slate-500">Used by Power Automate Desktop to retrieve pending NJ PWC search requests.</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">GET /api/integrations/compliance-sync/search-requests?compliance_name=NJ PWC</code>
                  <button type="button" onClick={() => void copyToClipboard(`${origin}/api/integrations/compliance-sync/search-requests?compliance_name=NJ%20PWC`)} className="font-medium text-indigo-600 text-sm">Copy Endpoint</button>
                  <button type="button" disabled={searchEndpointTesting} onClick={() => void handleTestSearchEndpoint()} className="font-medium text-indigo-600 text-sm disabled:opacity-60">{searchEndpointTesting ? "Testing..." : "Test Endpoint"}</button>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-sm font-medium text-slate-800">NJ PWC Search Result Submission</p>
                <p className="mt-0.5 text-xs text-slate-500">Used by Power Automate Desktop to submit candidate matches.</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">POST /api/integrations/compliance-sync/search-requests</code>
                  <button type="button" onClick={() => void copyToClipboard(`${origin}/api/integrations/compliance-sync/search-requests`)} className="font-medium text-indigo-600 text-sm">Copy Endpoint</button>
                  <button type="button" disabled={searchEndpointTesting} onClick={() => void handleTestSearchEndpoint()} className="font-medium text-indigo-600 text-sm disabled:opacity-60">{searchEndpointTesting ? "Testing..." : "Test Endpoint"}</button>
                </div>
              </div>
            </div>
            {searchEndpointResult ? <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700">{searchEndpointResult}</pre> : null}
            <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <div className="rounded-lg border border-slate-200 bg-white p-3"><dt className="text-xs font-semibold text-slate-400">Last Request Received</dt><dd className="mt-1 text-sm text-slate-700">{searchStats?.lastRequestReceived ? formatDateTime(searchStats.lastRequestReceived) : "—"}</dd></div>
              <div className="rounded-lg border border-slate-200 bg-white p-3"><dt className="text-xs font-semibold text-slate-400">Last Result Submitted</dt><dd className="mt-1 text-sm text-slate-700">{searchStats?.lastResultSubmitted ? formatDateTime(searchStats.lastResultSubmitted) : "—"}</dd></div>
              <div className="rounded-lg border border-slate-200 bg-white p-3"><dt className="text-xs font-semibold text-slate-400">Pending Requests</dt><dd className="mt-1 text-sm font-semibold text-amber-700">{searchStats?.pendingCount ?? 0}</dd></div>
              <div className="rounded-lg border border-slate-200 bg-white p-3"><dt className="text-xs font-semibold text-slate-400">Completed Requests</dt><dd className="mt-1 text-sm font-semibold text-emerald-700">{searchStats?.completedCount ?? 0}</dd></div>
              <div className="rounded-lg border border-slate-200 bg-white p-3"><dt className="text-xs font-semibold text-slate-400">Failed Requests</dt><dd className="mt-1 text-sm font-semibold text-red-700">{searchStats?.failedCount ?? 0}</dd></div>
            </dl>
          </div>

          {testResult ? <pre className="mt-3 whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-slate-700">{testResult}</pre> : null}
        </section>

        <section className="overflow-hidden rounded-2xl border border-amber-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-amber-100 px-5 py-4">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Orphaned Requests</h2>
              <p className="mt-1 text-sm text-slate-500">
                NJ BRC claimed or processing requests older than {orphanAgeThresholdMinutes} minutes whose assigned worker instance is no longer registered. Cleanup preserves the request and records an audit entry.
              </p>
            </div>
            <button type="button" disabled={loading} onClick={() => void loadAll()} className="rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-60">
              Refresh
            </button>
          </div>
          {orphanedRequests.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">{loading ? "Checking for orphaned requests…" : "No orphaned NJ BRC requests found."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[900px] border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr>{["Contractor", "Request ID", "Status", "Claimed Time", "Worker Instance ID", "Action"].map((heading) => <th key={heading} className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {orphanedRequests.map((item) => (
                    <tr key={item.request_id}>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm font-medium">{item.contractor}</td>
                      <td className="border-b border-slate-100 px-4 py-3 font-mono text-xs">{item.request_id}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{item.status}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{formatDateTime(item.claimed_at)}</td>
                      <td className="border-b border-slate-100 px-4 py-3 font-mono text-xs">{item.worker_instance_id}</td>
                      <td className="border-b border-slate-100 px-4 py-3">
                        <button
                          type="button"
                          disabled={orphanRecoveryBusy !== null}
                          onClick={() => void handleRecoverOrphanedRequest(item)}
                          className="rounded-lg border border-amber-300 px-3 py-2 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-60"
                        >
                          {orphanRecoveryBusy === item.request_id ? "Updating…" : "Mark as Website Error"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-xl font-semibold text-slate-900">NJ PWC Sync Health</h2>
            {njPwcSyncTestMode ? <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-700">Test Mode (dry run)</span> : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">Daily NJ PWC registry sync status.{njPwcSyncTestMode ? " Exception counts reflect dry-run results; Would Auto Approve and Would Expire show what the automation would do from the latest dry-run classifications. No compliance records are changed while Test Mode is on." : ""}</p>
          {njPwcSyncError ? <p role="alert" className="mt-3 text-sm text-red-700">{njPwcSyncError}</p> : null}
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {njPwcHealthCards.map((card) => (
              <div key={card.label} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                <p className="text-sm text-slate-500">{card.label}</p>
                <p className={`mt-2 text-lg font-semibold ${card.tone}`}>{loading ? "…" : njPwcSyncHealth ? card.value : "Unavailable"}</p>
                {card.hint ? <p className="mt-1 text-xs text-slate-500">{card.hint}</p> : null}
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <h2 className="text-xl font-semibold text-slate-900">NJ PWC Orphaned Requests</h2>
          <p className="mt-1 text-sm text-slate-500">Claims never expire automatically. Recovery requires an inactive owning instance and a claim at least {njPwcOrphanAge} minutes old. Resolve closes the unconfirmed search as failed; it does not mark compliance successful.</p>
          {njPwcOrphanError ? <p role="alert" className="mt-3 text-sm text-red-700">{njPwcOrphanError}</p> : njPwcOrphans.length === 0 ? <p className="mt-3 text-sm text-slate-500">No orphaned NJ PWC requests.</p> : (
            <div className="mt-3 space-y-3">
              {njPwcOrphans.map((item) => (
                <div key={item.request_id} className="rounded-xl border border-slate-200 p-3">
                  <p className="text-sm font-medium">{item.contractor} — Request #{item.request_id} ({item.status})</p>
                  <p className="text-xs text-slate-500">Claimed {formatDateTime(item.claimed_at)} · Owner {item.worker_instance_id}</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {(["fail", "retry", "resolve"] as const).map((action) => (
                      <button key={action} type="button" disabled={njPwcOrphanBusy !== null}
                        onClick={() => void handleRecoverNjPwcOrphan(item, action)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50">
                        {action === "fail" ? "Mark Failed" : action === "retry" ? "Retry Search" : "Resolve"}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-xl font-semibold text-slate-900">NJ PWC Sync Exceptions</h2>
            <p className="mt-1 text-sm text-slate-500">Daily Exception Report. Contractors are not expired after a single failed sync; only consecutive No Match / Multiple Matches / Name Mismatch results count toward the Failure Threshold. Registry outages never count.</p>
          </div>
          {njPwcSyncExceptions.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">{loading ? "Loading NJ PWC sync exceptions…" : "No open NJ PWC sync exceptions."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[1000px] border-collapse text-left">
                <thead className="bg-slate-50">
                  <tr>{["Contractor", "Reason", "Last Successful Sync", "Consecutive Failure Count", "Last Attempt Date", "Actions"].map((heading) => <th key={heading} className="border-b border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
                </thead>
                <tbody>
                  {njPwcSyncExceptions.map((item) => (
                    <tr key={item.id}>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm font-medium">
                        {item.contractor}
                        {item.is_test ? <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-semibold text-sky-700">Test</span> : null}
                        {item.reason === "Name Mismatch" && item.registry_match ? <NjPwcRegistryComparison match={item.registry_match} /> : null}
                      </td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">
                        {item.reason}
                        {item.expired_by_sync ? <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-semibold text-red-700">Expired</span> : null}
                      </td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{item.last_successful_sync_at ? formatDateTime(item.last_successful_sync_at) : "Never"}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{item.consecutive_failure_count}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{formatDateTime(item.last_attempt_at)}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">
                        <div className="flex flex-wrap gap-3">
                          {item.reason === "Name Mismatch" && item.registry_match?.candidate ? (
                            <button type="button" disabled={njPwcExceptionBusy !== null || !item.registry_match.can_accept} onClick={() => void handleCompareNjPwcMatch(item)} className="font-medium text-indigo-700 disabled:opacity-50">Accept Registry Match</button>
                          ) : null}
                          <Link href={`/contractors/${item.contractor_id}`} className="font-medium text-indigo-600 hover:text-indigo-800">Open Contractor</Link>
                          <button type="button" disabled={njPwcExceptionBusy !== null} onClick={() => void handleRetryNjPwcException(item)} className="font-medium text-sky-700 disabled:opacity-50">Run Search Again</button>
                          <button type="button" disabled={njPwcExceptionBusy !== null} onClick={() => void handleResolveNjPwcException(item)} className="font-medium text-emerald-700 disabled:opacity-50">
                            {njPwcExceptionBusy === item.id ? "Updating…" : "Resolve Exception"}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4">
            <h2 className="text-xl font-semibold text-slate-900">Test Data Cleanup</h2>
            <p className="mt-1 text-sm text-slate-500">Administrator-only removal of known NJ PWC simulator test contractors (NJ PWC # 123456, inactive) and their test tracking records. Only records meeting the safety criteria can be deleted.</p>
          </div>
          <div className="p-5">
            {cleanupRows.length === 0 ? (
              <p className="text-sm text-slate-500">No NJ PWC test data found.</p>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <input type="checkbox" checked={cleanupRows.length > 0 && cleanupRows.every((row) => cleanupSelected.has(row.id))} onChange={(event) => setCleanupSelected(event.target.checked ? new Set(cleanupRows.map((row) => row.id)) : new Set())} />
                    Select All Test Records
                  </label>
                  <button type="button" onClick={() => void loadCleanupRows()} className="text-sm font-medium text-indigo-600">Refresh</button>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-[560px] border-collapse text-left">
                    <thead className="bg-slate-50">
                      <tr>{["", "Contractor ID", "Company Name", "NJ PWC #", "Created", "Status"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-2 text-sm font-semibold">{heading}</th>)}</tr>
                    </thead>
                    <tbody>
                      {cleanupRows.map((row) => (
                        <tr key={row.id} className="bg-white">
                          <td className="border border-slate-200 px-4 py-2"><input type="checkbox" aria-label={`Select contractor ${row.id}`} checked={cleanupSelected.has(row.id)} disabled={!row.active === false} onChange={(event) => setCleanupSelected((current) => { const next = new Set(current); if (event.target.checked) next.add(row.id); else next.delete(row.id); return next; })} /></td>
                          <td className="border border-slate-200 px-4 py-2 text-sm">{row.id}</td>
                          <td className="border border-slate-200 px-4 py-2 text-sm font-medium">{row.company_name}</td>
                          <td className="border border-slate-200 px-4 py-2 text-sm">{row.nj_pwc_number ?? "—"}</td>
                          <td className="border border-slate-200 px-4 py-2 text-sm">{formatDateTime(row.created_at)}</td>
                          <td className="border border-slate-200 px-4 py-2 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${row.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{row.active ? "Active" : "Inactive"}</span></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-4">
                  <button type="button" disabled={cleanupBusy || cleanupSelected.size === 0} onClick={() => void handleDeleteTestData()} className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50 disabled:opacity-50">
                    {cleanupBusy ? "Deleting..." : `Delete Selected Test Data (${cleanupSelected.size})`}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
            <h2 className="text-xl font-semibold text-slate-900">Review Queue</h2>
            <div className="flex gap-2">
              {(["pending", "approved", "rejected", "all"] as const).map((filter) => (
                <button key={filter} type="button" onClick={() => setReviewFilter(filter)} className={`rounded-full px-3 py-1.5 text-xs font-semibold ${reviewFilter === filter ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}>
                  {filter === "all" ? "All" : filter.charAt(0).toUpperCase() + filter.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[1600px] border-collapse text-left">
              <thead className="bg-slate-50">
                <tr>{["Contractor", "Type", "BRC Name Control Used", "NJ BRC # at Request", "Matched Company", "Certificate #", "Synced Status", "Existing Reg #", "Proposed Reg #", "Existing Eff. Date", "Proposed Eff. Date", "Existing Exp. Date", "Proposed Exp. Date", "Last Verified", "Last Sync", "Source", "Review Status", "Exception", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {reviewQueue.map((entry) => (
                  <tr key={entry.id}>
                    <td className="border border-slate-200 px-4 py-3 text-sm font-medium"><Link href={`/contractors/${entry.contractor_id}`} className="text-indigo-600 hover:text-indigo-800">{entry.contractor_name || `#${entry.contractor_id}`}</Link></td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.compliance_name}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.brc_name_control_used || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.business_entity_id_used || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.matched_company_name || "—"}{entry.compliance_name === "NJ BRC" ? <NjBrcReviewEvidence reviewId={entry.id} /> : null}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.certificate_number || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.proposed_status || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.current_registration_number || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.proposed_registration_number || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.current_effective_date || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.synced_effective_date_proposed || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.current_expiration_date || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.proposed_expiration_date || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{entry.last_verified ? formatDateTime(entry.last_verified) : "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{formatDateTime(entry.created_at)}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{entry.sync_source}</span></td>
                    <td className="border border-slate-200 px-4 py-3 text-sm"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${reviewStatusStyles[entry.status]}`}>{entry.status}</span></td>
                    <td className="max-w-[220px] truncate border border-slate-200 px-4 py-3 text-sm text-slate-600">{entry.review_reason ? <span className="mr-2 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-700">{entry.review_reason}</span> : null}{entry.exception_message || (entry.review_reason ? "" : "—")}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      {entry.status === "pending" ? (
                        <div className="flex gap-2">
                          <button type="button" disabled={acting === entry.id} onClick={() => void handleReview(entry, "approved")} className="font-medium text-emerald-600 disabled:opacity-50">Approve</button>
                          <button type="button" disabled={acting === entry.id} onClick={() => void handleReview(entry, "rejected")} className="font-medium text-red-600 disabled:opacity-50">Reject</button>
                        </div>
                      ) : (
                        <span className="text-slate-400">{formatDateTime(entry.reviewed_at)}</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {reviewQueue.length === 0 && !loading ? <p className="p-5 text-sm text-slate-500">No review queue entries.</p> : null}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Sync History</h2></div>
          <div className="overflow-x-auto">
            <table className="min-w-[800px] border-collapse text-left">
              <thead className="bg-slate-50">
                <tr>{["Run At", "Source", "Status", "Records Checked", "Changes", "Approved", "Rejected", "Failures"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{formatDateTime(run.run_at)}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.sync_source}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.status}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.records_checked}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.changes_detected}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.records_approved}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.records_rejected}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.failures}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {runs.length === 0 && !loading ? <p className="p-5 text-sm text-slate-500">No sync runs recorded yet.</p> : null}
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Exceptions</h2></div>
          <div className="overflow-x-auto">
            <table className="min-w-[800px] border-collapse text-left">
              <thead className="bg-slate-50">
                <tr>{["Created", "Type", "Compliance", "Message", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {exceptions.map((exception) => (
                  <tr key={exception.id}>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{formatDateTime(exception.created_at)}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{exception.exception_type}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{exception.compliance_name || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{exception.message}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      <button type="button" disabled={acting === exception.id} onClick={() => void handleResolveException(exception)} className="font-medium text-indigo-600 disabled:opacity-50">Resolve</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {exceptions.length === 0 && !loading ? <p className="p-5 text-sm text-slate-500">No unresolved exceptions.</p> : null}
          </div>
        </section>
      </div>
      {njPwcRegistryMatch ? (
        <NjPwcRegistryMatchDialog key={njPwcRegistryMatch.snapshot} match={njPwcRegistryMatch}
          onClose={() => setNjPwcRegistryMatch(null)}
          onAccepted={(message) => {
            setNjPwcRegistryMatch(null);
            setSuccess(message);
            setError(null);
            void loadAll();
          }} />
      ) : null}
    </main>
  );
}
