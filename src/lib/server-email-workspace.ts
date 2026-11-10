import "server-only";
import { AdminApiError, type AdminContext } from "@/lib/server-admin";
import { checkDatabaseError } from "@/lib/server-communications";

export async function emailWorkspaceControls({ admin, profile }: AdminContext) {
  const { data, error } = await admin.rpc("communication_email_workspace_controls", { p_actor: profile.auth_user_id });
  if (error?.code === "PGRST202" && error.message.includes("communication_email_workspace_controls")) {
    return { available: false as const, notice: "Email workspace migration is pending. Sending, saving and scheduling here are unavailable until it is applied." };
  }
  checkDatabaseError(error);
  if (!data || typeof data.enabled !== "boolean" || typeof data.contractor_email_enabled !== "boolean" || typeof data.internal_email_enabled !== "boolean") {
    throw new AdminApiError("Email controls could not be verified.", 503);
  }
  return { available: true as const, enabled: data.enabled as boolean,
    contractor_email_enabled: data.contractor_email_enabled as boolean, internal_email_enabled: data.internal_email_enabled as boolean };
}

export async function workspacePermission(context: AdminContext, module: string, action = "view"): Promise<boolean> {
  if (context.profile.system_administrator) return true;
  const { data, error } = await context.admin.from("role_permissions").select("can_view,can_add,can_edit,can_manage")
    .eq("role", context.profile.role).eq("module", module).maybeSingle();
  checkDatabaseError(error);
  if (!data) return false;
  return action === "view" ? data.can_view : action === "add" ? data.can_add : action === "edit" ? data.can_edit : data.can_manage;
}

export async function emailRecipientRoles(admin: AdminContext["admin"], messageIds: string[]) {
  const { data, error } = await admin.from("communication_recipients").select("id,recipient_role").in("message_id", messageIds);
  if (error?.code === "42703" && error.message.includes("recipient_role")) {
    return { available: false, roles: new Map<string, "to" | "cc" | "bcc">() };
  }
  checkDatabaseError(error);
  const roles = new Map<string, "to" | "cc" | "bcc">();
  for (const row of data ?? []) {
    if (row.recipient_role !== "to" && row.recipient_role !== "cc" && row.recipient_role !== "bcc") {
      throw new AdminApiError("Stored recipient role is invalid.", 503);
    }
    roles.set(row.id, row.recipient_role);
  }
  return { available: true, roles };
}

export function storedEmailRole(snapshot: Awaited<ReturnType<typeof emailRecipientRoles>>, id: string) {
  if (!snapshot.available) return "to" as const;
  const role = snapshot.roles.get(id);
  if (!role) throw new AdminApiError("Recipient details changed. Reload this communication.", 409);
  return role;
}
