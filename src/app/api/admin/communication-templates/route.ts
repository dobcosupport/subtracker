import { requireModulePermission, writeAdministrationAudit } from "@/lib/server-admin";
import { parseMessageTemplate } from "@/lib/communication-templates";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { templateColumns } from "@/lib/server-communication-compose";

export async function GET(request: Request) {
  try {
    const { admin } = await requireModulePermission(request, "settings", "view");
    const offset = new URL(request.url).searchParams.get("offset") ?? "0";
    if (!/^\d{1,7}$/.test(offset)) throw new SyntaxError("Invalid template offset.");
    const { data, error } = await admin.from("communication_templates").select(templateColumns).order("name").order("id").range(Number(offset), Number(offset) + 49);
    checkDatabaseError(error);
    return Response.json({ templates: data ?? [], next_offset: data?.length === 50 ? Number(offset) + 50 : null });
  } catch (error) { return communicationError(error); }
}
export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "manage");
    const input = parseMessageTemplate(await request.json(), false);
    const { data, error } = await admin.rpc("save_communication_template", { p_actor: profile.auth_user_id, p_id: null, p_input: input });
    checkDatabaseError(error);
    await writeAdministrationAudit(admin, profile, "COMMUNICATION_TEMPLATE_CREATED", "communication_template", String(data), input.name, { changed_fields: Object.keys(input) });
    return Response.json({ id: data, revision: 1 }, { status: 201 });
  } catch (error) { return communicationError(error); }
}
