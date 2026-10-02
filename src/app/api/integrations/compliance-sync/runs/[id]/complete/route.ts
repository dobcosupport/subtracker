import { jsonError, requireRpaKey } from "@/lib/server-compliance-sync";

function toNonNegativeInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return null;
  return parsed;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireRpaKey(request);
    if (auth instanceof Response) return auth;
    const { admin } = auth;

    const { id } = await params;
    const runId = Number(id);
    if (!Number.isInteger(runId) || runId <= 0) return Response.json({ error: "Invalid sync run id." }, { status: 400 });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    }
    const { records_checked, changes_detected, records_failed, error_message } = (body ?? {}) as Record<string, unknown>;

    const recordsChecked = toNonNegativeInt(records_checked);
    const changesDetected = toNonNegativeInt(changes_detected);
    const recordsFailed = toNonNegativeInt(records_failed);
    if (recordsChecked === null || changesDetected === null || recordsFailed === null) {
      return Response.json({ error: "records_checked, changes_detected, and records_failed must be non-negative integers." }, { status: 400 });
    }

    // Confirm the run exists
    const { data: run, error: runError } = await admin.from("compliance_sync_runs").select("id, run_status").eq("id", runId).maybeSingle();
    if (runError) throw runError;
    if (!run) return Response.json({ error: "Sync run not found." }, { status: 404 });

    // Run status rules
    const overallFailed = typeof error_message === "string" && error_message.trim() !== "" && recordsChecked === 0;
    const runStatus = overallFailed ? "Failed" : recordsFailed > 0 ? "Completed With Errors" : "Completed";
    const legacyStatus = runStatus === "Completed" ? "completed" : runStatus === "Completed With Errors" ? "completed_with_errors" : "failed";

    const { data, error } = await admin
      .from("compliance_sync_runs")
      .update({
        completed_at: new Date().toISOString(),
        records_checked: recordsChecked,
        changes_detected: changesDetected,
        records_failed: recordsFailed,
        failures: recordsFailed,
        run_status: runStatus,
        status: legacyStatus,
        error_message: typeof error_message === "string" && error_message.trim() !== "" ? error_message : null,
      })
      .eq("id", runId)
      .select("id, run_status, completed_at")
      .single();
    if (error) throw error;

    return Response.json({ sync_run_id: data.id, run_status: data.run_status, completed_at: data.completed_at });
  } catch (error) {
    return jsonError(error);
  }
}
