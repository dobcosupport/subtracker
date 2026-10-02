import { jsonError, requireRpaKey } from "@/lib/server-compliance-sync";

const ALLOWED_SOURCES = ["RPA", "Manual", "API"] as const;

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

    const { sync_source, initiated_by_name, bot_version } = (body ?? {}) as Record<string, unknown>;

    if (typeof sync_source !== "string" || !(ALLOWED_SOURCES as readonly string[]).includes(sync_source)) {
      return Response.json({ error: `sync_source must be one of: ${ALLOWED_SOURCES.join(", ")}.` }, { status: 400 });
    }
    if (initiated_by_name !== undefined && typeof initiated_by_name !== "string") {
      return Response.json({ error: "initiated_by_name must be a string." }, { status: 400 });
    }
    if (bot_version !== undefined && typeof bot_version !== "string") {
      return Response.json({ error: "bot_version must be a string." }, { status: 400 });
    }

    const now = new Date().toISOString();
    const { data, error } = await admin
      .from("compliance_sync_runs")
      .insert({
        run_at: now,
        started_at: now,
        sync_source,
        run_status: "Running",
        status: "completed", // legacy flag retained; run_status is authoritative
        records_checked: 0,
        changes_detected: 0,
        records_failed: 0,
        failures: 0,
        initiated_by: initiated_by_name ?? null,
        triggered_by: initiated_by_name ?? null,
        bot_version: bot_version ?? null,
      })
      .select("id, started_at")
      .single();
    if (error) throw error;

    return Response.json({ sync_run_id: data.id, started_at: data.started_at });
  } catch (error) {
    return jsonError(error);
  }
}
