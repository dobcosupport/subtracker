import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, optionalText, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";
import type { NjPwcRegistryMatch } from "@/lib/nj-pwc-registry-fields";

// =====================================================================
// NJ PWC Sync Exceptions (Daily Exception Report) + Sync Health
//
// GET  : open exceptions with contractor + sync state, and health counts.
//        Health counts follow the current Test Mode setting so a dry run
//        reports dry-run results without mixing in live state.
// POST : { action: "retry", exception_id }
//        { action: "resolve", exception_id, confirmed: true, reset_failure_count?, note? }
//        Both run in SECURITY DEFINER transactions and are audited.
// =====================================================================

type ExceptionRow = {
  id: number;
  contractor_id: number;
  is_test: boolean;
  reason: string;
  kind: string;
  consecutive_failure_count: number;
  occurrences: number;
  expired_by_sync: boolean;
  first_detected_at: string;
  last_attempt_at: string;
  review_queue_id: number | null;
  last_search_request_id: number | null;
  contractors?: { company_name: string } | { company_name: string }[] | null;
};

type StateRow = {
  contractor_id: number;
  is_test: boolean;
  consecutive_failure_count: number;
  last_successful_sync_at: string | null;
  last_attempt_at: string | null;
};

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "compliance_sync", "view");

    const { data: settings, error: settingsError } = await admin.from("compliance_sync_settings")
      .select("test_mode").eq("compliance_name", "NJ PWC").maybeSingle();
    if (settingsError) throw new AdminApiError(settingsError.message, 500);
    const testMode = settings?.test_mode === true;

    const { data: exceptionData, error: exceptionError } = await admin.from("nj_pwc_sync_exceptions")
      .select("id, contractor_id, is_test, reason, kind, consecutive_failure_count, occurrences, expired_by_sync, first_detected_at, last_attempt_at, review_queue_id, last_search_request_id, contractors(company_name)")
      .eq("status", "open")
      .order("last_attempt_at", { ascending: false })
      .limit(500);
    if (exceptionError) throw new AdminApiError(exceptionError.message, 500);
    const exceptions = (exceptionData ?? []) as ExceptionRow[];
    const comparisons = new Map<number, NjPwcRegistryMatch>();
    const mismatchIds = exceptions.filter((row) => row.reason === "Name Mismatch").map((row) => row.id);
    if (mismatchIds.length) {
      const { data, error } = await admin.rpc("get_nj_pwc_registry_matches", { p_exception_ids: mismatchIds });
      const rpcError = njPwcRpcError(error);
      if (rpcError) throw rpcError;
      if (!Array.isArray(data)) throw new AdminApiError("Invalid registry comparisons response.", 500);
      for (const row of data as { exception_id: number; comparison: NjPwcRegistryMatch }[]) {
        comparisons.set(row.exception_id, row.comparison);
      }
    }

    const contractorIds = [...new Set(exceptions.map((row) => row.contractor_id))];
    const states = new Map<string, StateRow>();
    if (contractorIds.length > 0) {
      const { data: stateData, error: stateError } = await admin.from("nj_pwc_sync_state")
        .select("contractor_id, is_test, consecutive_failure_count, last_successful_sync_at, last_attempt_at")
        .in("contractor_id", contractorIds);
      if (stateError) throw new AdminApiError(stateError.message, 500);
      for (const row of (stateData ?? []) as StateRow[]) states.set(`${row.contractor_id}:${row.is_test}`, row);
    }

    const dryRunCount = (action: string) => admin.from("nj_pwc_sync_state")
      .select("contractor_id", { count: "exact", head: true }).eq("is_test", true).eq("dry_run_action", action);

    const [openCount, unavailableCount, expiredCount, reviewCount, lastRun, wouldApprove, wouldReview, wouldExpire, wouldPropose] = await Promise.all([
      admin.from("nj_pwc_sync_exceptions").select("id", { count: "exact", head: true }).eq("status", "open").eq("is_test", testMode),
      admin.from("nj_pwc_sync_exceptions").select("id", { count: "exact", head: true }).eq("status", "open").eq("is_test", testMode).eq("reason", "Registry Unavailable"),
      // Expired by Sync always reports actual (live) expirations; dry-run
      // expirations are reported separately as "Would Expire".
      admin.from("nj_pwc_sync_state").select("contractor_id", { count: "exact", head: true }).eq("state", "Expired").eq("is_test", false),
      admin.from("compliance_sync_review_queue").select("id", { count: "exact", head: true }).eq("compliance_name", "NJ PWC").eq("status", "pending").eq("is_test", false),
      admin.from("compliance_sync_runs").select("id, run_date, completed_at, run_status, is_test")
        .eq("run_type", "nj_pwc_daily").eq("is_test", testMode).in("run_status", ["Completed", "Completed With Errors"])
        .order("completed_at", { ascending: false }).limit(1),
      dryRunCount("would_auto_approve"),
      dryRunCount("would_request_review"),
      dryRunCount("would_expire"),
      dryRunCount("would_propose_expiration"),
    ]);
    const healthError = openCount.error || unavailableCount.error || expiredCount.error || reviewCount.error || lastRun.error
      || wouldApprove.error || wouldReview.error || wouldExpire.error || wouldPropose.error;
    if (healthError) throw new AdminApiError(healthError.message, 500);

    return Response.json({
      test_mode: testMode,
      health: {
        open_exceptions: openCount.count ?? 0,
        review_required: reviewCount.count ?? 0,
        expired_by_sync: expiredCount.count ?? 0,
        registry_unavailable: unavailableCount.count ?? 0,
        // Dry-run classifications are only meaningful while Test Mode is on.
        would_auto_approve: testMode ? wouldApprove.count ?? 0 : null,
        would_expire: testMode ? wouldExpire.count ?? 0 : null,
        would_request_review: testMode ? wouldReview.count ?? 0 : null,
        would_propose_expiration: testMode ? wouldPropose.count ?? 0 : null,
        last_successful_daily_run: lastRun.data?.[0] ?? null,
      },
      exceptions: exceptions.map((row) => {
        const contractor = Array.isArray(row.contractors) ? row.contractors[0] : row.contractors;
        const state = states.get(`${row.contractor_id}:${row.is_test}`);
        return {
          id: row.id,
          contractor_id: row.contractor_id,
          contractor: contractor?.company_name ?? `Contractor #${row.contractor_id}`,
          is_test: row.is_test,
          reason: row.reason,
          kind: row.kind,
          expired_by_sync: row.expired_by_sync,
          review_queue_id: row.review_queue_id,
          first_detected_at: row.first_detected_at,
          last_attempt_at: state?.last_attempt_at ?? row.last_attempt_at,
          last_successful_sync_at: state?.last_successful_sync_at ?? null,
          consecutive_failure_count: state?.consecutive_failure_count ?? row.consecutive_failure_count,
          registry_match: comparisons.get(row.id) ?? null,
        };
      }),
    });
  } catch (error) {
    return jsonError(error);
  }
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const payload = await readJsonObject(request, ["action", "exception_id", "confirmed", "reset_failure_count", "note"]);
    const exceptionId = positiveInt(payload.exception_id);
    if (!exceptionId) throw new AdminApiError("exception_id must be a positive integer.", 400);
    const actor = { p_actor_id: profile.auth_user_id, p_actor_name: profile.name, p_actor_email: profile.email };

    if (payload.action === "retry") {
      const { data, error } = await admin.rpc("retry_nj_pwc_sync_exception", { p_exception_id: exceptionId, ...actor });
      const rpcError = njPwcRpcError(error);
      if (rpcError) throw rpcError;
      return Response.json({ ok: true, ...firstRpcRow<Record<string, unknown>>(data) });
    }

    if (payload.action === "resolve") {
      if (payload.confirmed !== true) throw new AdminApiError("Resolving an exception requires confirmation.", 400);
      if (payload.reset_failure_count !== undefined && typeof payload.reset_failure_count !== "boolean") {
        throw new AdminApiError("reset_failure_count must be true or false.", 400);
      }
      const note = optionalText(payload.note, "note");
      const { data, error } = await admin.rpc("resolve_nj_pwc_sync_exception", {
        p_exception_id: exceptionId,
        p_reset_failure_count: payload.reset_failure_count === true,
        p_note: note,
        ...actor,
      });
      const rpcError = njPwcRpcError(error);
      if (rpcError) throw rpcError;
      return Response.json({ ok: true, ...firstRpcRow<Record<string, unknown>>(data) });
    }

    throw new AdminApiError("action must be retry or resolve.", 400);
  } catch (error) {
    return jsonError(error);
  }
}