import { requireRpaKey, jsonError, isResultStatus } from "@/lib/server-compliance-sync";
import { njBrcError, requireNjBrcWorkerAuth } from "@/lib/server-nj-brc-worker";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = /^[0-9a-f]{64}$/i;
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const id = (value: unknown) => value == null || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
const brcEvents = ["start", "stop", "search", "error", "test", "human_verification_required",
  "human_verification_completed", "request_processed", "no_match", "invalid_input",
  "identity_mismatch", "ambiguous_result", "website_error", "failed"];

export async function POST(request: Request) {
  try {
    const brcAuth = request.headers.has("x-subtracker-brc-key");
    const auth = await (brcAuth ? requireNjBrcWorkerAuth(request) : requireRpaKey(request));
    if (auth instanceof Response) return auth;
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Invalid health report." }, { status: 400 });
    const p = body as Record<string, unknown>;
    if (!(brcAuth ? p.worker_key === "nj-brc" : ["nj-pwc", "ny"].includes(String(p.worker_key))) || !uuid.test(String(p.instance_id))
      || !date(p.started_at) || Date.parse(String(p.started_at)) > Date.now() + 60_000
      || !date(p.file_modified_at) || (p.last_poll_at != null && !date(p.last_poll_at))
      || !hash.test(String(p.loaded_hash)) || !hash.test(String(p.current_hash))
      || typeof p.sequence !== "number" || !Number.isSafeInteger(p.sequence) || p.sequence < 1
      || !(p.worker_key === "nj-brc" ? ["starting", "ready", "busy", "human_verification_required", "website_error", "stopped"] : ["starting", "ready", "busy", "stopped"]).includes(String(p.lifecycle))
      || typeof p.browser_connected !== "boolean" || !id(p.current_request_id) || !id(p.request_id)
      || (p.current_request_key != null && (!brcAuth || !uuid.test(String(p.current_request_key))))
      || (p.request_key != null && (!brcAuth || !uuid.test(String(p.request_key))))
      || (p.test_id != null && !uuid.test(String(p.test_id)))
      || (p.event != null && !(brcAuth ? brcEvents : ["start", "stop", "search", "error", "test"]).includes(String(p.event)))
      || (p.event === "search" && (brcAuth ? p.result_status !== "Successful Certificate" || !p.request_key : !isResultStatus(p.result_status) || !p.request_id))
      || (p.event != null && (typeof p.message !== "string" || !p.message.trim() || p.message.length > 1000))) {
      return Response.json({ error: "Invalid health report fields." }, { status: 400 });
    }
    // Only approved fields are persisted; worker also sanitizes error messages.
    const message = typeof p.message === "string" ? p.message
      .split(process.env.COMPLIANCE_SYNC_RPA_KEY || "\0").join("[REDACTED]")
      .split(process.env.NJ_BRC_WORKER_KEY || "\0").join("[REDACTED]")
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/https?:\/\/\S+/gi, "[URL]") : null;
    const report = {
      worker_key: p.worker_key, instance_id: p.instance_id, started_at: p.started_at,
      sequence: p.sequence, lifecycle: p.lifecycle, browser_connected: p.browser_connected,
      last_poll_at: p.last_poll_at ?? null, file_modified_at: p.file_modified_at,
      loaded_hash: p.loaded_hash, current_hash: p.current_hash,
      current_request_id: p.current_request_id ?? null, request_id: p.request_id ?? null,
      ...(brcAuth ? { current_request_key: p.current_request_key ?? null, request_key: p.request_key ?? null } : {}),
      test_id: p.test_id ?? null, event: p.event ?? null,
      message: brcAuth && message ? message.replace(/\b\d{2}[- ]?\d{7}\b|\b\d{12}\b/g, "[TAX ID REDACTED]") : message,
      result_status: p.result_status ?? null,
    };
    if (brcAuth) {
      const { data, error } = await auth.admin.rpc("report_nj_brc_worker", { p_report: report });
      if (error) return njBrcError(error);
      return Response.json(data, { headers: { "Cache-Control": "no-store" } });
    }
    const { data: accepted, error } = await auth.admin.rpc("report_compliance_worker", { p_report: report });
    if (error) throw error;
    if (p.worker_key === "nj-pwc") {
      const { data: queueAccepted, error: queueError } = await auth.admin.rpc("report_nj_pwc_queue_worker", { p_report: report });
      if (queueError) throw queueError;
      if (!queueAccepted) return Response.json({ error: "Worker instance report rejected or worker disabled." }, { status: 409 });
    } else if (!accepted) {
      return Response.json({ error: "Worker report superseded or worker not enabled." }, { status: 409 });
    }
    const { data: worker, error: readError } = await auth.admin.from("compliance_sync_workers")
      .select("test_id, test_requested_at, test_acknowledged_at").eq("worker_key", p.worker_key).single();
    if (readError) throw readError;
    return Response.json({ ok: true, test_id: worker.test_id && !worker.test_acknowledged_at
      && Date.now() - Date.parse(worker.test_requested_at) < 30_000 ? worker.test_id : null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return jsonError(error); }
}
