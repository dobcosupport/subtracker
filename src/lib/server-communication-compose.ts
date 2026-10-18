import "server-only";
import { AdminApiError, getRequestContext } from "@/lib/server-admin";

export async function requireCompose(request: Request) {
  const context = await getRequestContext(request);
  if (!context.profile.system_administrator) {
    const { data, error } = await context.admin.from("role_permissions").select("can_add,can_edit")
      .eq("role", context.profile.role).eq("module", "communications_content").maybeSingle();
    if (error) throw new AdminApiError("Unable to verify composition permissions.", 503);
    if (!data?.can_add && !data?.can_edit) throw new AdminApiError("Communications Content Add or Edit permission is required.", 403);
  }
  return context;
}
export const templateColumns = "id,name,category,channel,subject,body,is_active,revision,created_at,updated_at";
