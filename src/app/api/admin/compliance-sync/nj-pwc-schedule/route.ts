import { AdminApiError, jsonError, requireModulePermission } from "@/lib/server-admin";
import { firstRpcRow, njPwcRpcError, readJsonObject } from "@/lib/server-nj-pwc-sync";

const TIME_ZONE = "America/New_York";

function parseDate(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new AdminApiError("Start Date must be a valid YYYY-MM-DD date.", 400);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new AdminApiError("Start Date must be a valid calendar date.", 400);
  }
  return value;
}

function parseTime(value: unknown): string {
  if (typeof value !== "string") throw new AdminApiError("Start Time must use hh:mm AM/PM.", 400);
  const match = value.trim().match(/^(0?[1-9]|1[0-2]):([0-5]\d)\s*(AM|PM)$/i);
  if (!match) throw new AdminApiError("Start Time must use hh:mm AM/PM.", 400);
  let hour = Number(match[1]) % 12;
  if (match[3].toUpperCase() === "PM") hour += 12;
  return `${String(hour).padStart(2, "0")}:${match[2]}:00`;
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "compliance_sync", "manage");
    const body = await readJsonObject(request, ["daily_sync_enabled", "daily_sync_start_date", "daily_sync_time", "daily_sync_timezone"]);
    if (typeof body.daily_sync_enabled !== "boolean") {
      throw new AdminApiError("daily_sync_enabled must be true or false.", 400);
    }
    const startDate = parseDate(body.daily_sync_start_date);
    const startTime = parseTime(body.daily_sync_time);
    if (body.daily_sync_timezone !== TIME_ZONE) {
      throw new AdminApiError(`Time Zone must be ${TIME_ZONE}.`, 400);
    }
    const { data, error } = await admin.rpc("save_nj_pwc_daily_sync_schedule", {
      p_daily_sync_enabled: body.daily_sync_enabled,
      p_daily_sync_start_date: startDate,
      p_daily_sync_time: startTime,
      p_daily_sync_timezone: TIME_ZONE,
      p_actor_id: profile.auth_user_id,
      p_actor_name: profile.name,
      p_actor_email: profile.email,
    });
    const rpcError = njPwcRpcError(error);
    if (rpcError) throw rpcError;
    return Response.json({ ok: true, ...firstRpcRow<Record<string, unknown>>(data) }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return jsonError(error);
  }
}