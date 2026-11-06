import { AdminApiError, requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { CommunicationInputError, communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    if (!profile.system_administrator && profile.role !== "Administrator") throw new AdminApiError("Administrator approval is required.", 403);
    const id = communicationId((await context.params).id);
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => key !== "revision")
      || !Number.isSafeInteger((value as Record<string, unknown>).revision) || Number((value as Record<string, unknown>).revision) < 1
      || Number((value as Record<string, unknown>).revision) > 2147483647) throw new CommunicationInputError("A valid template revision is required.");
    const revision = Number((value as Record<string, unknown>).revision);
    const { error } = await admin.rpc("approve_communication_template_automation", { p_actor: profile.auth_user_id, p_template: id, p_revision: revision });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "COMMUNICATION_TEMPLATE_AUTOMATION_APPROVED", "communication_template", id, "Template automation approval", { revision });
    return Response.json({ id, revision, approved: true });
  } catch (error) { return communicationError(error); }
}
