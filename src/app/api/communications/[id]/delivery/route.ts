import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError, deliveryColumns } from "@/lib/server-communications";
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin } = await requireModulePermission(request, "communications_delivery", "view");
    const id = communicationId((await context.params).id);
    const { data, error } = await admin.from("communication_messages").select(deliveryColumns).eq("id", id).maybeSingle();
    checkDatabaseError(error);
    if (!data) throw new AdminApiError("Communication not found.", 404);
    return Response.json({ delivery: data });
  } catch (error) { return communicationError(error); }
}
