import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError, deliveryColumns } from "@/lib/server-communications";
import { emailRecipientRoles, storedEmailRole } from "@/lib/server-email-workspace";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin } = await requireModulePermission(request, "communications_delivery", "view");
    const id = communicationId((await context.params).id);
    const { data, error } = await admin.from("communication_messages").select(deliveryColumns).eq("id", id).maybeSingle();
    checkDatabaseError(error);
    if (!data) throw new AdminApiError("Communication not found.", 404);
    const roles = await emailRecipientRoles(admin, [id]);
    return Response.json({ delivery: { ...data, communication_recipients: data.communication_recipients.map(r => ({
      ...r, recipient_role: storedEmailRole(roles, r.id),
    })) }, recipient_roles_available: roles.available });
  } catch (error) { return communicationError(error); }
}
