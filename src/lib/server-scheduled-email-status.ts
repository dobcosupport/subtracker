import "server-only";
import { AdminApiError, type AdminContext } from "@/lib/server-admin";
import { checkDatabaseError } from "@/lib/server-communications";
import type { ScheduledEmailStatus } from "@/types/scheduled-email";

export async function scheduledEmailStatus(admin: AdminContext["admin"]): Promise<ScheduledEmailStatus> {
  const { data, error } = await admin.rpc("communication_scheduled_email_status");
  if (error?.code === "PGRST202" && error.message.includes("communication_scheduled_email_status")) {
    return { available: false, execution_enabled: false, automatic_delivery_enabled: false,
      notice: "Automatic delivery is not available; the scheduled delivery migration is pending. This message will not send itself." };
  }
  checkDatabaseError(error);
  if (!data || ["enabled", "healthy", "automatic_delivery_enabled", "global_email_enabled"].some(key => typeof data[key] !== "boolean")) {
    throw new AdminApiError("Scheduled Email availability could not be verified.", 503);
  }
  return {
    available: true, execution_enabled: data.enabled && data.healthy, automatic_delivery_enabled: data.automatic_delivery_enabled,
    notice: !data.automatic_delivery_enabled ? "Automatic Delivery is disabled in Email Settings. Messages remain Scheduled."
      : !data.global_email_enabled ? "Global Email is disabled in Email Settings. Messages remain Scheduled."
        : !data.enabled ? "Scheduled delivery worker is not activated. Messages will not send automatically."
          : !data.healthy ? "Scheduled delivery worker has not checked in recently. Messages remain Scheduled until it resumes."
            : "Scheduled messages are delivered when due, subject to current Email Settings and recipient eligibility.",
  };
}
