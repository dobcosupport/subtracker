import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId, parseCommunicationDraft } from "@/lib/communications";
import { checkDatabaseError, communicationError, contentColumns } from "@/lib/server-communications";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { admin } = await requireModulePermission(request, "communications_content", "view");
    const id = communicationId((await context.params).id);
    const { data, error } = await admin.from("communication_messages").select(contentColumns).eq("id", id).maybeSingle();
    checkDatabaseError(error);
    if (!data) throw new AdminApiError("Communication not found.", 404);
    return Response.json({ communication: data });
  } catch (error) { return communicationError(error); }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const { admin, profile } = await requireModulePermission(request, "communications_content", "edit");
    const id = communicationId((await context.params).id);
    const input = parseCommunicationDraft(await request.json(), true);
    const { data, error } = await admin.rpc("save_communication_draft", { p_actor: profile.auth_user_id, p_id: id, p_input: input });
    checkDatabaseError(error);
    return Response.json({ id: data, status: "Draft", revision: input.revision! + 1 });
  } catch (error) { return communicationError(error); }
}
