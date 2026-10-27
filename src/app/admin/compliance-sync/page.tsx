"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import runNowButtonStyles from "./run-now-buttons.module.css";
import { adminFetch } from "@/lib/admin-client";
import WorkerHealthPanel from "@/components/compliance-sync/WorkerHealthPanel";
import RegistrationUnlinkPanel from "@/components/compliance-sync/RegistrationUnlinkPanel";
import { NjBrcReviewEvidence } from "@/components/compliance-sync/NjBrcRequestPanel";
import NjPwcRegistryMatchDialog, { NjPwcRegistryComparison } from "@/components/compliance-sync/NjPwcRegistryMatchDialog";
import type { NjPwcRegistryMatch } from "@/lib/nj-pwc-registry-fields";
import { njPwcExceptionButtonClass } from "@/lib/nj-pwc-registry-fields";
import NjPwcSelectMatchDialog from "@/components/compliance-sync/NjPwcSelectMatchDialog";
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
  saveNjPwcDailySyncSchedule,
  runNjPwcDailySyncNow,
  stopNjPwcDailyRun,
  type ComplianceSyncDashboard,
  type ComplianceSyncException,
  type ComplianceSyncReviewEntry,
  type ComplianceSyncRun,
  type ComplianceSyncSetting,
  type NjPwcActiveRun,
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
const complianceSyncTabs = ["Overview", "Settings", "NJ PWC", "NJ BRC", "Reviews", "Sync History", "Automation"] as const;
type ComplianceSyncTab = typeof complianceSyncTabs[number];

const reviewStatusStyles: Record<ReviewStatus, string> = {
  pending: "bg-amber-100 text-amber-700",
  approved: "bg-emerald-100 text-emerald-700",
  rejected: "bg-red-100 text-red-700",
};

function formatDateTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—";
}

function formatScheduleDate(value: string | null | undefined): string {
  if (!value) return "";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${month}/${day}/${year}`;
}

function formatScheduleTime(value: string | null | undefined): string {
  if (!value) return "02:00 AM";
  const [rawHour, minute] = value.split(":");
  const hour = Number(rawHour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !minute) return "02:00 AM";
  return `${String(hour % 12 || 12).padStart(2, "0")}:${minute.slice(0, 2)} ${hour < 12 ? "AM" : "PM"}`;
}

function formatScheduleDateTime(value: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(value));
}

export default function ComplianceSyncPage() {
  const [dashboard, setDashboard] = useState<ComplianceSyncDashboard | null>(null);
  const [settings, setSettings] = useState<ComplianceSyncSetting[]>([]);
  const [runs, setRuns] = useState<ComplianceSyncRun[]>([]);
  const [reviewQueue, setReviewQueue] = useState<ComplianceSyncReviewEntry[]>([]);
  const [exceptions, setExceptions] = useState<ComplianceSyncException[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewStatus | "all">("pending");
  const [activeTab, setActiveTab] = useState<ComplianceSyncTab>("Overview");
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
  const [njPwcActiveRun, setNjPwcActiveRun] = useState<NjPwcActiveRun | null>(null);
  const [stopRunBusy, setStopRunBusy] = useState(false);
  const [stopRunConfirmOpen, setStopRunConfirmOpen] = useState(false);
  const [njPwcSyncTestMode, setNjPwcSyncTestMode] = useState(false);
  const [njPwcSyncError, setNjPwcSyncError] = useState<string | null>(null);
  const [njPwcExceptionBusy, setNjPwcExceptionBusy] = useState<number | null>(null);
  const [njPwcOrphans, setNjPwcOrphans] = useState<NjPwcOrphanedRequest[]>([]);
  const [njPwcOrphanError, setNjPwcOrphanError] = useState<string | null>(null);
  const [njPwcOrphanBusy, setNjPwcOrphanBusy] = useState<number | null>(null);
  const [njPwcOrphanAge, setNjPwcOrphanAge] = useState(10);
  const [njPwcRegistryMatch, setNjPwcRegistryMatch] = useState<NjPwcRegistryMatch | null>(null);
  const [njPwcSelectException, setNjPwcSelectException] = useState<number | null>(null);
  const [dailySyncDraft, setDailySyncDraft] = useState<{ enabled: boolean; startDate: string; startTime: string } | null>(null);
  const [dailySyncScheduleSaving, setDailySyncScheduleSaving] = useState(false);
  const [runNowConfirmationOpen, setRunNowConfirmationOpen] = useState(false);
  const [runNowBusy, setRunNowBusy] = useState(false);
  const [runNowRequestKey, setRunNowRequestKey] = useState<string | null>(null);

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
    setNjPwcActiveRun(njPwcSyncResult.data?.active_run ?? null);
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

  const refreshNjPwcSyncExceptions = useCallback(async () => {
    const result = await getNjPwcSyncExceptions();
    if (result.error) {
      setNjPwcSyncError(result.error.message);
      return;
    }
    setNjPwcSyncError(null);
    setNjPwcSyncExceptions(result.data?.exceptions ?? []);
    setNjPwcSyncHealth(result.data?.health ?? null);
    setNjPwcSyncTestMode(result.data?.test_mode ?? false);
    setNjPwcActiveRun(result.data?.active_run ?? null);
  }, []);

  const hasActiveNjPwcRetry = njPwcSyncExceptions.some((item) =>
    item.retry_request?.origin === "exception_retry"
      && ["pending", "claimed", "processing"].includes(item.retry_request.status));

  useEffect(() => {
    if (!hasActiveNjPwcRetry) return;
    const timer = window.setInterval(() => void refreshNjPwcSyncExceptions(), 2000);
    return () => window.clearInterval(timer);
  }, [hasActiveNjPwcRetry, refreshNjPwcSyncExceptions]);

  // While an automatic run is active (Running, with or without a stop
  // request), poll sync health so the Stop Run control appears even when the
  // run started after this page loaded. A stop-requested run is recorded as
  // Cancelled only after its in-flight search finishes; when the active run
  // clears, reload so Sync History and the schedule panel show the final state.
  const njPwcRunActive = njPwcActiveRun?.run_status === "Running";
  useEffect(() => {
    if (!njPwcRunActive) return;
    const timer = window.setInterval(() => void refreshNjPwcSyncExceptions(), 3000);
    return () => window.clearInterval(timer);
  }, [njPwcRunActive, refreshNjPwcSyncExceptions]);

  const runActiveRef = useRef(false);
  useEffect(() => {
    if (njPwcRunActive) {
      runActiveRef.current = true;
      return;
    }
    if (runActiveRef.current && !njPwcActiveRun) {
      runActiveRef.current = false;
      void loadAll();
    }
  }, [njPwcRunActive, njPwcActiveRun, loadAll]);

  const handleStopNjPwcRun = async () => {
    if (!njPwcActiveRun || stopRunBusy) return;
    setStopRunBusy(true);
    setError(null);
    setSuccess(null);
    const result = await stopNjPwcDailyRun(njPwcActiveRun.id);
    setStopRunBusy(false);
    setStopRunConfirmOpen(false);
    if (result.error || !result.data) {
      setError(result.error?.message ?? "Unable to stop the NJ PWC run.");
      return;
    }
    if (result.data.finished && result.data.run_status === "Cancelled") {
      setSuccess(`NJ PWC run #${result.data.run_id} had no active search and was recorded as Cancelled.`);
      void loadAll();
      return;
    }
    setSuccess(
      result.data.already_requested
        ? `Stop was already requested for NJ PWC run #${result.data.run_id}. The in-progress search will finish; no new searches will start.`
        : `Stop requested for NJ PWC run #${result.data.run_id}. The in-progress search will finish; no new searches will start.`
    );
    await refreshNjPwcSyncExceptions();
  };

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
    const { data, error: retryError } = await retryNjPwcSyncException(item.id);
    setNjPwcExceptionBusy(null);
    if (retryError) {
      setError(retryError.message);
      return;
    }
    setSuccess(`${item.contractor}: Retry Queued (Request #${data?.search_request_id}).`);
    void refreshNjPwcSyncExceptions();
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

  const handleSaveNjPwcSchedule = async () => {
    const setting = settings.find((entry) => entry.compliance_name === "NJ PWC");
    if (!setting) return;
    const form = dailySyncDraft ?? {
      enabled: setting.daily_sync_enabled ?? false,
      startDate: formatScheduleDate(setting.daily_sync_start_date),
      startTime: formatScheduleTime(setting.daily_sync_time),
    };
    const match = form.startDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) {
      setError("Start Date must use MM/DD/YYYY.");
      return;
    }
    const [, month, day, year] = match;
    const startDate = `${year}-${month}-${day}`;
    const parsedDate = new Date(`${startDate}T00:00:00.000Z`);
    if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== startDate) {
      setError("Start Date must be a valid calendar date.");
      return;
    }
    if (!/^(0?[1-9]|1[0-2]):[0-5]\d\s?(AM|PM)$/i.test(form.startTime.trim())) {
      setError("Start Time must use hh:mm AM/PM.");
      return;
    }
    if (setting.daily_sync_enabled && !form.enabled
      && !window.confirm("Disable the NJ PWC daily schedule? Already queued or in-progress work will continue.")) {
      return;
    }

    setDailySyncScheduleSaving(true);
    setError(null);
    setSuccess(null);
    const result = await saveNjPwcDailySyncSchedule({
      daily_sync_enabled: form.enabled,
      daily_sync_start_date: startDate,
      daily_sync_time: form.startTime.trim().toUpperCase(),
      daily_sync_timezone: "America/New_York",
    });
    setDailySyncScheduleSaving(false);
    if (result.error) {
      setError(result.error.message);
      return;
    }
    setDailySyncDraft(null);
    setSuccess(result.data?.next_sync_at
      ? `NJ PWC daily schedule saved. Next Scheduled Run: ${formatScheduleDateTime(result.data.next_sync_at)}.`
      : "NJ PWC daily schedule disabled.");
    void loadAll();
  };

  const openRunNowConfirmation = () => {
    if (runNowBusy) return;
    setRunNowRequestKey(window.crypto.randomUUID());
    setRunNowConfirmationOpen(true);
  };

  const handleRunNjPwcNow = async () => {
    if (runNowBusy || !runNowRequestKey) return;
    setRunNowBusy(true);
    setError(null);
    setSuccess(null);
    const result = await runNjPwcDailySyncNow(runNowRequestKey);
    setRunNowBusy(false);
    if (result.error || !result.data) {
      setError(result.error?.message ?? "Unable to start the NJ PWC sync.");
      return;
    }
    setRunNowConfirmationOpen(false);
    setRunNowRequestKey(null);
    if (result.data.already_active) {
      setSuccess(`Run Now not started. NJ PWC run #${result.data.run_id} is already active (${result.data.run_status}).`);
    } else if (result.data.created) {
      setSuccess(`NJ PWC Run Now started: run #${result.data.run_id} (${result.data.is_test ? "Test Mode" : "LIVE"}).`);
    } else {
      setSuccess(`NJ PWC Run Now request already handled by run #${result.data.run_id} (${result.data.run_status}).`);
    }
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
    { label: "Last Sync", value: dashboard?.lastSync ? formatDateTime(dashboard.lastSync.run_at) : "Never Synced" },
    { label: "Next Scheduled Sync", value: dashboard?.nextScheduledSync ? formatDateTime(dashboard.nextScheduledSync) : "Not Scheduled" },
    { label: "Records Checked", value: String(dashboard?.recordsChecked ?? 0) },
    { label: "Open Exceptions", value: String(dashboard?.failedVerifications ?? 0) },
    { label: "Pending Review", value: String(dashboard?.pendingReview ?? 0) },
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
  const njPwcSchedule = settings.find((setting) => setting.compliance_name === "NJ PWC");
  const njPwcScheduleForm = njPwcSchedule ? dailySyncDraft ?? {
    enabled: njPwcSchedule.daily_sync_enabled ?? false,
    startDate: formatScheduleDate(njPwcSchedule.daily_sync_start_date),
    startTime: formatScheduleTime(njPwcSchedule.daily_sync_time),
  } : null;
  const lastNjPwcDailyRun = runs.find((run) => run.run_type === "nj_pwc_daily") ?? null;

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <header>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Administration</p>
          <h1 className="mt-1 text-2xl font-semibold text-slate-900">Compliance Sync</h1>
          <p className="mt-1 max-w-3xl text-sm text-slate-500">Monitor compliance sync activity, review results, and manage schedules.</p>
        </header>
        {error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div> : null}
        {success ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div> : null}

        <div role="tablist" aria-label="Compliance Sync sections" className="flex flex-wrap gap-1 border-b border-slate-200">
          {complianceSyncTabs.map((tab) => (
            <button key={tab} type="button" role="tab" aria-selected={activeTab === tab}
              aria-controls={`compliance-sync-${tab.toLowerCase().replace(/\s+/g, "-")}`}
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 px-3 py-2 text-sm font-semibold ${activeTab === tab ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800"}`}>
              {tab}
            </button>
          ))}
        </div>

        <div id="compliance-sync-overview" role="tabpanel" hidden={activeTab !== "Overview"} className="space-y-4">
          <section aria-label="Compliance Sync summary" className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            {summaryCards.map((card) => (
              <div key={card.label} className="min-w-0 rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                <p className="text-xs font-medium text-slate-500">{card.label}</p>
                <p className="mt-1 break-words text-sm font-semibold text-slate-900">{loading ? "…" : card.value}</p>
              </div>
            ))}
          </section>
          {njPwcTestModeOn ? (
            <div role="status" className="rounded-lg border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900">
              <span className="font-semibold">NJ PWC Test Mode is ON.</span> Daily sync searches and classifications run, but compliance records and statuses are not changed.
            </div>
          ) : null}
          <section aria-labelledby="compliance-services-heading" className="overflow-hidden rounded-xl border border-slate-200 bg-white">
            <div className="border-b border-slate-200 px-4 py-3">
              <h2 id="compliance-services-heading" className="text-base font-semibold text-slate-900">Compliance Services</h2>
            </div>
            {settings.length > 0 ? (
              <div>
                {settings.map((setting) => (
                  <div key={setting.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5 last:border-0">
                    <span className="text-sm font-semibold text-slate-800">{setting.compliance_name}</span>
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${setting.enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-700"}`}>{setting.enabled ? "Enabled" : "Disabled"}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{syncModes.find((mode) => mode.value === setting.mode)?.label ?? setting.mode}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">{setting.sync_source}</span>
                      <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${setting.test_mode ? "bg-sky-100 text-sky-800" : "bg-slate-100 text-slate-700"}`}>{setting.test_mode ? "Test" : "Live"}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-4 py-3 text-sm text-slate-500">{loading ? "Loading compliance services…" : "No compliance services configured."}</p>
            )}
          </section>
          <WorkerHealthPanel />
        </div>

        <div hidden={activeTab !== "NJ PWC"}>
        {njPwcTestModeOn ? (
          <div role="status" data-testid="nj-pwc-test-mode-banner" className="rounded-xl border border-sky-300 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            <p className="font-semibold">NJ PWC Daily Sync running in TEST MODE.</p>
            <p>Searches and exception detection are active.</p>
            <p>Compliance records and statuses are NOT being modified.</p>
          </div>
        ) : null}
        </div>

        <section id="compliance-sync-settings" role="tabpanel" hidden={activeTab !== "Settings"} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Compliance Sync Settings</h2>
            <details className="text-sm text-slate-600">
              <summary className="cursor-pointer font-medium text-indigo-700">Mode and Test Mode details</summary>
              <p className="mt-2 max-w-4xl text-sm leading-5 text-slate-600">Per-type approval mode and sync source. For NJ PWC, Mode is the master switch: Review Required routes imports and daily-sync results to the Review Queue; Auto Approve applies user-selected imports and high-confidence daily-sync matches automatically (low-confidence results always require review). NJ PWC Test Mode is the daily-sync shadow mode: searches, classification, exceptions, failure counts, and statistics run, but compliance records and statuses are not modified (user-selected imports still follow Mode). Failure Threshold is the number of consecutive No Match / Multiple Matches / Name Mismatch results before an NJ PWC registration is expired.</p>
            </details>
          </div>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-[700px] border-collapse text-left [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_td]:px-3 [&_td]:py-2">
              <thead className="bg-slate-50">
                <tr>{["Compliance Type", "Enabled", "Mode", "Sync Source", "Test Mode", "Last Sync"].map((heading) => <th key={heading} className="border border-slate-200 font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {settings.map((setting) => (
                  <tr key={setting.id}>
                    <td className="border border-slate-200 px-3 py-2 text-sm font-medium">{setting.compliance_name}</td>
                    <td className="border border-slate-200 px-3 py-2 text-sm">
                      <input type="checkbox" aria-label={`${setting.compliance_name} enabled`} checked={setting.enabled} onChange={(event) => void handleSettingChange(setting, { enabled: event.target.checked })} className="h-4 w-4" />
                    </td>
                    <td className="border border-slate-200 px-3 py-2 text-sm">
                      <select aria-label={`${setting.compliance_name} mode`} value={setting.mode} onChange={(event) => void handleSettingChange(setting, { mode: event.target.value as SyncMode })} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm">
                        {syncModes.map((mode) => <option key={mode.value} value={mode.value} disabled={setting.compliance_name === "NJ BRC" && mode.value === "auto_approve"}>{mode.label}{setting.compliance_name === "NJ BRC" && mode.value === "auto_approve" ? " (Locked)" : ""}</option>)}
                      </select>
                    </td>
                    <td className="border border-slate-200 px-3 py-2 text-sm">
                      <select aria-label={`${setting.compliance_name} sync source`} value={setting.sync_source} onChange={(event) => void handleSettingChange(setting, { sync_source: event.target.value as SyncSource })} className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm">
                        {syncSources.map((source) => <option key={source} value={source}>{source}</option>)}
                      </select>
                    </td>
                    <td className="border border-slate-200 px-3 py-2 text-sm">
                      <input type="checkbox" aria-label={`${setting.compliance_name} test mode`} checked={setting.test_mode ?? false} onChange={(event) => void handleSettingChange(setting, { test_mode: event.target.checked })} className="h-4 w-4" />
                    </td>
                    <td className="border border-slate-200 px-3 py-2 text-sm">{setting.last_sync_at ? formatDateTime(setting.last_sync_at) : "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {settings.length === 0 && !loading ? <p className="p-5 text-sm text-slate-500">No sync settings configured. Run the compliance sync admin migration.</p> : null}
          </div>
          {njPwcSchedule ? (
            <div className="border-t border-slate-200 px-4 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold text-slate-900">NJ PWC Daily Sync Schedule</h3>
                  <p className="mt-1 text-xs text-slate-500">The server creates each scheduled date once. Worker polling and Test Mode do not change the recurring schedule.</p>
                </div>
                <div className="flex gap-2">
                  <button type="button" disabled={!njPwcSchedule.enabled || runNowBusy} onClick={openRunNowConfirmation}
                    className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.runNowPrimary}`}>
                    Run Now
                  </button>
                  {njPwcActiveRun ? (
                    njPwcActiveRun.stop_requested_at ? (
                      <button type="button" disabled
                        className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.runNowCancel}`}>
                        Stop Requested…
                      </button>
                    ) : (
                      <button type="button" disabled={stopRunBusy} onClick={() => setStopRunConfirmOpen(true)}
                        className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.destructivePrimary}`}>
                        Stop Run
                      </button>
                    )
                  ) : null}
                  <button type="button" disabled={dailySyncScheduleSaving} onClick={() => void handleSaveNjPwcSchedule()}
                    className={`rounded-lg px-4 py-2 text-sm font-semibold ${runNowButtonStyles.runNowPrimary}`}>
                    {dailySyncScheduleSaving ? "Saving…" : "Save Schedule"}
                  </button>
                </div>
              </div>
              <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="flex items-center gap-3 text-sm font-medium text-slate-700">
                  <input type="checkbox" aria-label="Daily Sync Enabled" checked={njPwcScheduleForm?.enabled ?? false}
                    onChange={(event) => setDailySyncDraft({ ...njPwcScheduleForm!, enabled: event.target.checked })} className="h-4 w-4" />
                  Daily Sync: {njPwcScheduleForm?.enabled ? "Enabled" : "Disabled"}
                </label>
                <label className="text-sm font-medium text-slate-700">Schedule Type
                  <input aria-label="Schedule Type" disabled value="Daily" className="mt-1 block w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600" />
                </label>
                <label className="text-sm font-medium text-slate-700">Start Date
                  <input aria-label="Daily Sync Start Date" value={njPwcScheduleForm?.startDate ?? ""} placeholder="MM/DD/YYYY"
                    onChange={(event) => setDailySyncDraft({ ...njPwcScheduleForm!, startDate: event.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
                </label>
                <label className="text-sm font-medium text-slate-700">Start Time
                  <input aria-label="Daily Sync Start Time" value={njPwcScheduleForm?.startTime ?? ""} placeholder="hh:mm AM/PM"
                    onChange={(event) => setDailySyncDraft({ ...njPwcScheduleForm!, startTime: event.target.value })} className="mt-1 block w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
                </label>
                <label className="text-sm font-medium text-slate-700">Time Zone
                  <input aria-label="Daily Sync Time Zone" disabled value="America/New_York" className="mt-1 block w-full rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm text-slate-600" />
                </label>
                <label className="text-sm font-medium text-slate-700">Failure Threshold
                  <input key={`threshold-${njPwcSchedule.id}-${njPwcSchedule.failure_expire_threshold ?? 3}`}
                    type="number" min={1} max={30} aria-label="NJ PWC failure threshold"
                    defaultValue={njPwcSchedule.failure_expire_threshold ?? 3}
                    onBlur={(event) => {
                      const current = njPwcSchedule.failure_expire_threshold ?? 3;
                      const value = Number(event.target.value);
                      if (!Number.isInteger(value) || value < 1 || value > 30) {
                        setError("Failure Threshold must be a whole number between 1 and 30.");
                        event.target.value = String(current);
                        return;
                      }
                      if (value !== current) void handleSettingChange(njPwcSchedule, { failure_expire_threshold: value });
                    }} className="mt-1 block w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
                </label>
              </div>
              <div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
                <p>Next Scheduled Run: {njPwcScheduleForm?.enabled && njPwcSchedule.next_sync_at ? formatScheduleDateTime(njPwcSchedule.next_sync_at) : "Not scheduled"}</p>
                <p>Last Daily Run: {lastNjPwcDailyRun
                  ? `${formatScheduleDateTime(lastNjPwcDailyRun.completed_at ?? lastNjPwcDailyRun.run_at)} · ${lastNjPwcDailyRun.run_status ?? lastNjPwcDailyRun.status}`
                  : "Never"}</p>
                {njPwcActiveRun ? (
                  <p>Active Run: #{njPwcActiveRun.id} · {njPwcActiveRun.stop_requested_at ? "Stop Requested" : "Running"}{njPwcActiveRun.is_test ? " (Test Mode)" : ""}</p>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        <section id="compliance-sync-automation" role="tabpanel" hidden={activeTab !== "Automation"} className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-semibold text-slate-900">RPA Integration (Testing)</h2>
          <p className="mt-1 max-w-3xl text-sm leading-5 text-slate-500">
            Server-side endpoints for the future Microsoft Power Automate Desktop flow. Set the <span className="font-medium text-slate-700">COMPLIANCE_SYNC_RPA_KEY</span> environment variable (server-only), then pass it in the <span className="font-medium text-slate-700">x-subtracker-rpa-key</span> header. The key is never displayed here. See docs/COMPLIANCE_SYNC_RPA.md for full field mapping.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="min-w-[600px] border-collapse text-left [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_td]:px-3 [&_td]:py-2">
              <thead className="bg-slate-50">
                <tr>{["Endpoint", "Method", "Path", ""].map((heading) => <th key={heading} className="border border-slate-200 font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {rpaEndpoints.map((endpoint) => (
                  <tr key={endpoint.label}>
                    <td className="border border-slate-200 px-4 py-3 text-sm font-medium">{endpoint.label}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm"><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{endpoint.method}</span></td>
                    <td className="border border-slate-200 px-4 py-3 font-mono text-xs text-slate-600">{endpoint.path}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm"><button type="button" onClick={() => void copyToClipboard(`${origin}${endpoint.path}`)} className="font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">Copy Endpoint</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" disabled={testing} onClick={() => void handleTestConnection()} className={`rounded-xl px-4 py-2.5 text-sm font-semibold ${runNowButtonStyles.solidSlatePrimary}`}>
              {testing ? "Testing..." : "Test Connection"}
            </button>
            <span className="text-xs text-slate-400">Confirms reachability, authentication, and required tables. No website lookup is performed.</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
            <label className="text-sm font-medium text-slate-700">Test NJ BRC Lookup (Testing Only)
              <input type="text" inputMode="numeric" value={testContractorId} onChange={(event) => setTestContractorId(event.target.value)} placeholder="Contractor ID" className="ml-2 w-36 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <button type="button" disabled={testLookupBusy} onClick={() => void handleTestNjBrcLookup()} className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.runNowCancel}`}>
              {testLookupBusy ? "Running..." : "Test NJ BRC Lookup"}
            </button>
            <span className="text-xs text-slate-400">Processes one contractor, creates a test run + review result labeled Testing Only, and never updates Active Compliance Records. Requires NJ BRC Test Mode enabled. First test is attended.</span>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
            <label className="text-sm font-medium text-slate-700">Test NJ PWC Lookup (Testing Only)
              <input type="text" inputMode="numeric" value={testPwcContractorId} onChange={(event) => setTestPwcContractorId(event.target.value)} placeholder="Contractor ID" className="ml-2 w-36 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <button type="button" disabled={testPwcLookupBusy} onClick={() => void handleTestNjPwcLookup()} className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.runNowCancel}`}>
              {testPwcLookupBusy ? "Running..." : "Test NJ PWC Lookup"}
            </button>
            <span className="text-xs text-slate-400">Looks up one contractor on the NJ Public Works Power BI report by Certificate # / Business Name, creates a test run + review result labeled Testing Only, and never updates Active Compliance Records. Requires NJ PWC Test Mode enabled.</span>
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-3 border-t border-slate-200 pt-3">
            <label className="text-sm font-medium text-slate-700">Create Test NJ PWC Result (Testing Only)
              <input type="text" inputMode="numeric" value={testResultRequestId} onChange={(event) => setTestResultRequestId(event.target.value)} placeholder="Search Request ID" className="ml-2 w-40 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm" />
            </label>
            <select aria-label="Test outcome" value={testResultOutcome} onChange={(event) => setTestResultOutcome(event.target.value as typeof testResultOutcome)} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
              <option value="Match Found">Match Found</option>
              <option value="No Match Found">No Match Found</option>
              <option value="Multiple Matches">Multiple Matches</option>
              <option value="Failed">Failed</option>
            </select>
            <button type="button" disabled={testResultBusy} onClick={() => void handleCreateTestNjPwcResult()} className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.runNowCancel}`}>
              {testResultBusy ? "Running..." : "Create Test NJ PWC Result"}
            </button>
            <span className="text-xs text-slate-400">Simulates Power Automate Desktop output for a pending search request (no PAD required). Match Found returns candidate ABCO / Certificate # 123456. Updates the search request only — never Active Compliance Records.</span>
          </div>

          <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
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
                  <button type="button" onClick={() => void copyToClipboard(`${origin}/api/integrations/compliance-sync/search-requests?compliance_name=NJ%20PWC`)} className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">Copy Endpoint</button>
                  <button type="button" disabled={searchEndpointTesting} onClick={() => void handleTestSearchEndpoint()} className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-600 disabled:opacity-100">{searchEndpointTesting ? "Testing..." : "Test Endpoint"}</button>
                </div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-3">
                <p className="text-sm font-medium text-slate-800">NJ PWC Search Result Submission</p>
                <p className="mt-0.5 text-xs text-slate-500">Used by Power Automate Desktop to submit candidate matches.</p>
                <div className="mt-2 flex flex-wrap items-center gap-3">
                  <code className="rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-700">POST /api/integrations/compliance-sync/search-requests</code>
                  <button type="button" onClick={() => void copyToClipboard(`${origin}/api/integrations/compliance-sync/search-requests`)} className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">Copy Endpoint</button>
                  <button type="button" disabled={searchEndpointTesting} onClick={() => void handleTestSearchEndpoint()} className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:text-slate-600 disabled:opacity-100">{searchEndpointTesting ? "Testing..." : "Test Endpoint"}</button>
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

        <section hidden={activeTab !== "Automation"} className="overflow-hidden rounded-xl border border-amber-200 bg-white">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-amber-100 px-4 py-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Orphaned Requests</h2>
              <p className="mt-1 text-sm text-slate-500">
                NJ BRC claimed or processing requests older than {orphanAgeThresholdMinutes} minutes whose assigned worker instance is no longer registered. Cleanup preserves the request and records an audit entry.
              </p>
            </div>
            <button type="button" disabled={loading} onClick={() => void loadAll()} className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-50 disabled:text-slate-600 disabled:opacity-100">
              Refresh
            </button>
          </div>
          {orphanedRequests.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">{loading ? "Checking for orphaned requests…" : "No orphaned NJ BRC requests found."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[900px] border-collapse text-left [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_td]:px-3 [&_td]:py-2">
                <thead className="bg-slate-50">
                  <tr>{["Contractor", "Request ID", "Status", "Claimed Time", "Worker Instance ID", "Action"].map((heading) => <th key={heading} className="border-b border-slate-200 font-semibold">{heading}</th>)}</tr>
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
                          className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.solidSlatePrimary}`}
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

        {activeTab === "NJ PWC" || activeTab === "NJ BRC" ? <div id={activeTab === "NJ BRC" ? "compliance-sync-nj-brc" : undefined} role={activeTab === "NJ BRC" ? "tabpanel" : undefined}>
          <RegistrationUnlinkPanel key={activeTab} compliance={activeTab} />
        </div> : null}
        <section id="compliance-sync-nj-pwc" role="tabpanel" hidden={activeTab !== "NJ PWC"} className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="text-lg font-semibold text-slate-900">NJ PWC Sync Health</h2>
            {njPwcSyncTestMode ? <span className="rounded-full bg-sky-100 px-2.5 py-1 text-xs font-semibold text-sky-700">Test Mode (dry run)</span> : null}
          </div>
          <p className="mt-1 text-sm text-slate-500">Daily NJ PWC registry sync status.{njPwcSyncTestMode ? " Exception counts reflect dry-run results; Would Auto Approve and Would Expire show what the automation would do from the latest dry-run classifications. No compliance records are changed while Test Mode is on." : ""}</p>
          {njPwcSyncError ? <p role="alert" className="mt-3 text-sm text-red-700">{njPwcSyncError}</p> : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {njPwcHealthCards.map((card) => (
              <div key={card.label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="text-xs text-slate-500">{card.label}</p>
                <p className={`mt-1 text-base font-semibold ${card.tone}`}>{loading ? "…" : njPwcSyncHealth ? card.value : "Unavailable"}</p>
                {card.hint ? <p className="mt-1 text-xs text-slate-500">{card.hint}</p> : null}
              </div>
            ))}
          </div>
        </section>

        <section hidden={activeTab !== "NJ PWC"} className="rounded-xl border border-slate-200 bg-white p-4">
          <h2 className="text-lg font-semibold text-slate-900">NJ PWC Orphaned Requests</h2>
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
                        className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${runNowButtonStyles.runNowCancel}`}>
                        {action === "fail" ? "Mark Failed" : action === "retry" ? "Retry Search" : "Resolve"}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section hidden={activeTab !== "NJ PWC"} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-slate-900">NJ PWC Sync Exceptions</h2>
            <p className="mt-1 text-sm text-slate-500">Daily Exception Report. Contractors are not expired after a single failed sync; only consecutive No Match / Multiple Matches / Name Mismatch results count toward the Failure Threshold. Registry outages never count.</p>
          </div>
          {njPwcSyncExceptions.length === 0 ? (
            <p className="px-5 py-4 text-sm text-slate-500">{loading ? "Loading NJ PWC sync exceptions…" : "No open NJ PWC sync exceptions."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-[1000px] border-collapse text-left [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_td]:px-3 [&_td]:py-2">
                <thead className="bg-slate-50">
                  <tr>{["Contractor", "Reason", "Last Successful Sync", "Consecutive Failure Count", "Last Attempt Date", "Actions"].map((heading) => <th key={heading} className="border-b border-slate-200 font-semibold">{heading}</th>)}</tr>
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
                        {item.retry_request ? (
                          <p className="mt-1 text-xs text-sky-700">
                            Retry {item.retry_request.status} · Request #{item.retry_request.id}
                            {item.retry_request.result_status ? ` · ${item.retry_request.result_status}` : ""}
                          </p>
                        ) : null}
                      </td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{item.last_successful_sync_at ? formatDateTime(item.last_successful_sync_at) : "Never"}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{item.consecutive_failure_count}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">{formatDateTime(item.last_attempt_at)}</td>
                      <td className="border-b border-slate-100 px-4 py-3 text-sm">
                        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap" aria-label={`NJ PWC exception actions for ${item.contractor}`}>
                          {item.reason === "Multiple Matches" && item.can_select_match ? (
                            <button type="button" disabled={njPwcExceptionBusy !== null} onClick={() => setNjPwcSelectException(item.id)}
                              className={`${njPwcExceptionButtonClass} ${runNowButtonStyles.approvePrimary}`}>Select Match</button>
                          ) : null}
                          {item.reason === "Name Mismatch" && item.registry_match?.candidate ? (
                            <button type="button" disabled={njPwcExceptionBusy !== null || !item.registry_match.can_accept} onClick={() => void handleCompareNjPwcMatch(item)} className={`${njPwcExceptionButtonClass} ${runNowButtonStyles.approvePrimary}`}>Accept Registry Match</button>
                          ) : null}
                          <Link href={`/contractors/${item.contractor_id}`} className={`${njPwcExceptionButtonClass} border-indigo-200 text-indigo-700 hover:bg-indigo-50`}>Open Contractor</Link>
                          <button type="button" disabled={njPwcExceptionBusy !== null || (item.retry_request?.origin === "exception_retry" && ["pending", "claimed", "processing"].includes(item.retry_request.status))} onClick={() => void handleRetryNjPwcException(item)} className={`${njPwcExceptionButtonClass} ${runNowButtonStyles.runNowPrimary}`}>Run Search Again</button>
                          <button type="button" disabled={njPwcExceptionBusy !== null} onClick={() => void handleResolveNjPwcException(item)} className={`${njPwcExceptionButtonClass} ${runNowButtonStyles.runNowCancel}`}>
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

        <section hidden={activeTab !== "NJ PWC"} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-slate-900">Test Data Cleanup</h2>
            <p className="mt-1 text-sm text-slate-500">Administrator-only removal of known NJ PWC simulator test contractors (NJ PWC # 123456, inactive) and their test tracking records. Only records meeting the safety criteria can be deleted.</p>
          </div>
          <div className="p-4">
            {cleanupRows.length === 0 ? (
              <p className="text-sm text-slate-500">No NJ PWC test data found.</p>
            ) : (
              <>
                <div className="mb-3 flex items-center gap-3">
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700">
                    <input type="checkbox" checked={cleanupRows.length > 0 && cleanupRows.every((row) => cleanupSelected.has(row.id))} onChange={(event) => setCleanupSelected(event.target.checked ? new Set(cleanupRows.map((row) => row.id)) : new Set())} />
                    Select All Test Records
                  </label>
                  <button type="button" onClick={() => void loadCleanupRows()} className="text-sm font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">Refresh</button>
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
                <div className="mt-3">
                  <button type="button" disabled={cleanupBusy || cleanupSelected.size === 0} onClick={() => void handleDeleteTestData()} className={`rounded-lg px-3 py-2 text-sm font-semibold ${runNowButtonStyles.destructivePrimary}`}>
                    {cleanupBusy ? "Deleting..." : `Delete Selected Test Data (${cleanupSelected.size})`}
                  </button>
                </div>
              </>
            )}
          </div>
        </section>

        <section id="compliance-sync-reviews" role="tabpanel" hidden={activeTab !== "Reviews"} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3">
            <h2 className="text-lg font-semibold text-slate-900">Review Queue</h2>
            <div className="flex gap-2">
              {(["pending", "approved", "rejected", "all"] as const).map((filter) => (
                <button key={filter} type="button" onClick={() => setReviewFilter(filter)} className={`rounded-full px-3 py-1.5 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 ${reviewFilter === filter ? "bg-slate-900 text-white" : "bg-slate-100 text-slate-700 hover:bg-slate-200"}`}>
                  {filter === "all" ? "All" : filter.charAt(0).toUpperCase() + filter.slice(1)}
                </button>
              ))}
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-[1600px] border-collapse text-left [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_td]:px-3 [&_td]:py-2">
              <thead className="bg-slate-50">
                <tr>{["Contractor", "Type", "BRC Name Control Used", "NJ BRC # at Request", "Matched Company", "Certificate #", "Synced Status", "Existing Reg #", "Proposed Reg #", "Existing Eff. Date", "Proposed Eff. Date", "Existing Exp. Date", "Proposed Exp. Date", "Last Verified", "Last Sync", "Source", "Review Status", "Exception", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {reviewQueue.map((entry) => (
                  <tr key={entry.id}>
                    <td className="border border-slate-200 px-4 py-3 text-sm font-medium"><Link href={`/contractors/${entry.contractor_id}`} className="text-indigo-700 underline-offset-2 hover:text-indigo-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">{entry.contractor_name || `#${entry.contractor_id}`}</Link></td>
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
                          <button type="button" disabled={acting === entry.id} onClick={() => void handleReview(entry, "approved")} className={`rounded-lg px-3 py-1.5 font-semibold ${runNowButtonStyles.approvePrimary}`}>Approve</button>
                          <button type="button" disabled={acting === entry.id} onClick={() => void handleReview(entry, "rejected")} className={`rounded-lg px-3 py-1.5 font-semibold ${runNowButtonStyles.destructivePrimary}`}>Reject</button>
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

        <section id="compliance-sync-history" role="tabpanel" hidden={activeTab !== "Sync History"} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-lg font-semibold text-slate-900">Sync History</h2></div>
          <div className="overflow-x-auto">
            <table className="min-w-[800px] border-collapse text-left [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_td]:px-3 [&_td]:py-2">
              <thead className="bg-slate-50">
                <tr>{["Run At", "Source", "Status", "Records Checked", "Changes", "Approved", "Rejected", "Failures"].map((heading) => <th key={heading} className="border border-slate-200 font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{formatDateTime(run.run_at)}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.sync_source}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{run.run_status === "Running" && run.stop_requested_at ? "Stop Requested" : run.run_status ?? run.status}</td>
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

        <section hidden={activeTab !== "Reviews"} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3"><h2 className="text-lg font-semibold text-slate-900">Exceptions</h2></div>
          <div className="overflow-x-auto">
            <table className="min-w-[800px] border-collapse text-left [&_th]:px-3 [&_th]:py-2 [&_th]:text-xs [&_td]:px-3 [&_td]:py-2">
              <thead className="bg-slate-50">
                <tr>{["Created", "Type", "Compliance", "Message", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 font-semibold">{heading}</th>)}</tr>
              </thead>
              <tbody>
                {exceptions.map((exception) => (
                  <tr key={exception.id}>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{formatDateTime(exception.created_at)}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{exception.exception_type}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">{exception.compliance_name || "—"}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{exception.message}</td>
                    <td className="border border-slate-200 px-4 py-3 text-sm">
                      <button type="button" disabled={acting === exception.id} onClick={() => void handleResolveException(exception)} className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${runNowButtonStyles.runNowCancel}`}>Resolve</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {exceptions.length === 0 && !loading ? <p className="p-5 text-sm text-slate-500">No unresolved exceptions.</p> : null}
          </div>
        </section>
      </div>
      {runNowConfirmationOpen && njPwcSchedule ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 px-4">
          <div role="dialog" aria-modal="true" aria-labelledby="nj-pwc-run-now-title" className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <h2 id="nj-pwc-run-now-title" className="text-xl font-semibold text-slate-900">Run NJ PWC Sync Now?</h2>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="font-medium text-slate-600">Mode:</dt>
              <dd>{njPwcSchedule.mode === "auto_approve" ? "Auto Approve" : "Review Required"}</dd>
              <dt className="font-medium text-slate-600">Test Mode:</dt>
              <dd>{njPwcSchedule.test_mode ? "ON" : "OFF"}</dd>
            </dl>
            {njPwcSchedule.test_mode ? (
              <p className="mt-4 rounded-lg bg-sky-50 p-3 text-sm text-sky-900">This run will search and classify NJ PWC records but will not make live compliance-record changes.</p>
            ) : (
              <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">This is a LIVE NJ PWC sync. Eligible results may update compliance records according to the current Mode.</p>
            )}
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" disabled={runNowBusy} onClick={() => {
                setRunNowConfirmationOpen(false);
                setRunNowRequestKey(null);
              }} className={`rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline-none ${runNowButtonStyles.runNowCancel}`}>Cancel</button>
              <button type="button" disabled={runNowBusy} onClick={() => void handleRunNjPwcNow()}
                className={`rounded-lg px-4 py-2 text-sm font-bold shadow-sm focus-visible:outline-none ${runNowButtonStyles.runNowPrimary}`}>
                {runNowBusy ? "Starting…" : njPwcSchedule.test_mode ? "Run Test Sync Now" : "Run Live Sync Now"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {stopRunConfirmOpen && njPwcActiveRun ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/40 px-4">
          <div role="dialog" aria-modal="true" aria-labelledby="nj-pwc-stop-run-title" className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <h2 id="nj-pwc-stop-run-title" className="text-xl font-semibold text-slate-900">Stop NJ PWC Run #{njPwcActiveRun.id}?</h2>
            <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="font-medium text-slate-600">Run:</dt>
              <dd>#{njPwcActiveRun.id}{njPwcActiveRun.manual_run ? " (Run Now)" : " (Scheduled)"}{njPwcActiveRun.is_test ? " · Test Mode" : ""}</dd>
              <dt className="font-medium text-slate-600">Started:</dt>
              <dd>{njPwcActiveRun.started_at ? formatDateTime(njPwcActiveRun.started_at) : "—"}</dd>
            </dl>
            <p className="mt-4 rounded-lg bg-slate-50 p-3 text-sm text-slate-700">
              This is a graceful stop. No new contractor searches will start for this run; the search currently in progress will finish and its result will be kept. The worker and the recurring Daily Sync Schedule stay enabled. The run is recorded as Cancelled once its active search has finished.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button type="button" disabled={stopRunBusy} onClick={() => setStopRunConfirmOpen(false)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold focus-visible:outline-none ${runNowButtonStyles.runNowCancel}`}>Cancel</button>
              <button type="button" disabled={stopRunBusy} onClick={() => void handleStopNjPwcRun()}
                className={`rounded-lg px-4 py-2 text-sm font-bold shadow-sm focus-visible:outline-none ${runNowButtonStyles.destructivePrimary}`}>
                {stopRunBusy ? "Stopping…" : "Stop Run"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
      {njPwcSelectException !== null ? <NjPwcSelectMatchDialog key={njPwcSelectException} exceptionId={njPwcSelectException}
        onClose={() => setNjPwcSelectException(null)} onAccepted={message => {
          setNjPwcSelectException(null); setSuccess(message); setError(null); void loadAll();
        }} /> : null}
    </main>
  );
}
