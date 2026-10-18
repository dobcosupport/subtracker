import { requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { parseMessageTemplate } from "@/lib/communication-templates";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const id = communicationId((await context.params).id);
    const input = parseMessageTemplate(await request.json(), true);
    const { error } = await admin.rpc("save_communication_template", { p_actor: profile.auth_user_id, p_id: id, p_input: input });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "COMMUNICATION_TEMPLATE_UPDATED", "communication_template", id, input.name, { changed_fields: Object.keys(input).filter((key) => key !== "revision") });
    return Response.json({ id, revision: input.revision! + 1 });
  } catch (error) { return communicationError(error); }
}
