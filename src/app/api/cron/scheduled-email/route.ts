import { timingSafeEqual } from "node:crypto";
import { AdminApiError, createAdminClient } from "@/lib/server-admin";
import { communicationError } from "@/lib/server-communications";
import { processScheduledEmail } from "@/lib/server-scheduled-email";
import { scheduledEmailStatus } from "@/lib/server-scheduled-email-status";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    if (!secret) throw new AdminApiError("Scheduled Email trigger authentication is not configured.", 503);
    const expected = Buffer.from(`Bearer ${secret}`);
    const actual = Buffer.from(request.headers.get("authorization") ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new AdminApiError("Unauthorized scheduled Email trigger.", 401);
    }
    const admin = createAdminClient();
    const result = await processScheduledEmail(admin);
    return Response.json({ ...result, scheduling: await scheduledEmailStatus(admin) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = communicationError(error);
    response.headers.set("Cache-Control", "no-store");
    return response;
  }
}
