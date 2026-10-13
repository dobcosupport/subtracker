import { isValidDateString, jsonError, requireRpaKey } from "@/lib/server-compliance-sync";
import { AdminApiError } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, positiveInt, readJsonObject } from "@/lib/server-nj-pwc-sync";

// =====================================================================
// NJ PWC daily registry sync — worker trigger (RPA key)
//
// POST { action: "enqueue", run_date?: "YYYY-MM-DD" }
//   Creates (once per day per Test Mode setting) the daily run and queues
//   one search per in-scope contractor. Safe to call repeatedly.
// POST { action: "finalize", run_id?: number, force?: boolean }
//   Finalizes the given run (or every running daily run) once all of its
//   searches are processed; applies the expiration threshold.
// =====================================================================

function newYorkDate(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

export async function POST(request: Request) {
  try {
    const auth = await requireRpaKey(request);
    if (auth instanceof Response) return auth;
    const { admin } = auth;
    const payload = await readJsonObject(request, ["action", "run_date", "run_id", "force"]);

    if (payload.action === "enqueue") {
      if (payload.run_date !== undefined && payload.run_date !== null && !isValidDateString(payload.run_date)) {
        throw new AdminApiError("run_date must be YYYY-MM-DD.", 400);
      }
      const runDate = typeof payload.run_date === "string" ? payload.run_date.slice(0, 10) : newYorkDate();
      const { data, error } = await admin.rpc("enqueue_nj_pwc_daily_sync", { p_run_date: runDate, p_triggered_by: "NJ PWC Worker" });
      const rpcError = njPwcRpcError(error);
      if (rpcError) throw rpcError;
      return Response.json({ ok: true, run_date: runDate, ...firstRpcRow<Record<string, unknown>>(data) });
    }

    if (payload.action === "finalize") {
      if (payload.force !== undefined && typeof payload.force !== "boolean") throw new AdminApiError("force must be true or false.", 400);
      let runIds: number[];
      if (payload.run_id !== undefined && payload.run_id !== null) {
        const runId = positiveInt(payload.run_id);
        if (!runId) throw new AdminApiError("run_id must be a positive integer.", 400);
        runIds = [runId];
      } else {
        const { data, error } = await admin.from("compliance_sync_runs").select("id")
          .eq("run_type", "nj_pwc_daily").eq("run_status", "Running").order("id", { ascending: true }).limit(10);
        if (error) throw new AdminApiError(error.message, 500);
        runIds = (data ?? []).map((row: { id: number }) => row.id);
      }
      const runs: Record<string, unknown>[] = [];
      for (const runId of runIds) {
        const { data, error } = await admin.rpc("finalize_nj_pwc_daily_run", { p_run_id: runId, p_force: payload.force === true });
        const rpcError = njPwcRpcError(error);
        if (rpcError) throw rpcError;
        const row = firstRpcRow<Record<string, unknown>>(data);
        runs.push(row);
      }
      return Response.json({ ok: true, runs });
    }

    throw new AdminApiError("action must be enqueue or finalize.", 400);
  } catch (error) {
    return jsonError(error);
  }
}