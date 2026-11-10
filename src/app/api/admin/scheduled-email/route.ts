import { requireModulePermission } from "@/lib/server-admin";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { scheduledEmailStatus } from "@/lib/server-scheduled-email-status";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "view");
    const { data, error } = await admin.from("communication_email_worker_settings")
      .select("enabled,batch_size,retry_policy,retry_delay_seconds,maximum_attempts,stale_claim_seconds,last_polled_at,revision")
      .eq("singleton", true).single();
    if (error?.code === "42P01" || error?.code === "PGRST205") {
      return Response.json({ policy: null, notice: "Scheduled delivery migration is pending. No worker is active." },
        { headers: { "Cache-Control": "no-store" } });
    }
    checkDatabaseError(error);
    return Response.json({ policy: data, scheduling: await scheduledEmailStatus(admin) },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}

export async function PATCH(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const input: unknown = await request.json();
    const { error } = await admin.rpc("save_communication_email_worker_settings", { p_actor: profile.auth_user_id, p_input: input });
    checkDatabaseError(error);
    return Response.json({ saved: true }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
