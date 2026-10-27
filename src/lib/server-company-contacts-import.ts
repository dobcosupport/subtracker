import "server-only";
import { AdminApiError, requireModulePermission, type AdminContext } from "@/lib/server-admin";

export async function companyContactsContext(request: Request, write = false): Promise<AdminContext> {
  const context = await requireModulePermission(request, "imports", "view");
  if (!context.profile.system_administrator) {
    const { data, error } = await context.admin.from("role_permissions")
      .select("module,can_view,can_manage,can_add,can_edit").eq("role", context.profile.role);
    if (error) throw new AdminApiError(error.message, 503);
    const imports = data?.find((p) => p.module === "imports");
    const settings = data?.find((p) => p.module === "settings");
    if (!settings?.can_view || (write && (!settings.can_manage || !imports?.can_add || !imports.can_edit))) {
      throw new AdminApiError("Company Contacts requires Settings View and, for changes, Settings Manage plus Import Add/Edit permission.", 403);
    }
  }
  return context;
}

export async function companyContactsRpc(context: AdminContext, action: string, data: Record<string, unknown> = {}) {
  const result = await context.admin.rpc("company_contacts_import", {
    p_action: action, p_actor: context.profile.auth_user_id, p_data: data,
  });
  if (result.error) {
    const { code, message } = result.error;
    const missing = ["PGRST202", "42P01", "42703"].includes(code);
    throw new AdminApiError(missing
      ? "Company Contacts import is unavailable. Apply 20261120_company_contacts_import.sql manually before using this feature."
      : message, code === "42501" ? 403 : code === "40001" ? 409 : code === "P0002" ? 404 : code === "22023" ? 400 : 503);
  }
  const value = result.data;
  if (!value || (action === "list" ? !Array.isArray(value.batches) : !value.batch || !Array.isArray(value.rows) || !value.summary || !Array.isArray(value.contacts))) {
    throw new AdminApiError("Company Contacts import returned an invalid result. Reload before continuing.", 503);
  }
  return value;
}
