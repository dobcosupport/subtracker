import { requireModulePermission } from "@/lib/server-admin";
import { parseCommunicationDraft } from "@/lib/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { getCommunicationSummaries } from "@/lib/server-communication-history";

export async function GET(request: Request) {
  try {
    return Response.json(await getCommunicationSummaries(request, new URL(request.url).searchParams));
  } catch (error) { return communicationError(error); }
}
export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "communications_content", "add");
    const input = parseCommunicationDraft(await request.json(), false);
    const { data, error } = await admin.rpc("save_communication_draft", { p_actor: profile.auth_user_id, p_id: null, p_input: input });
    checkDatabaseError(error);
    return Response.json({ id: data, status: "Draft", revision: 1 }, { status: 201 });
  } catch (error) { return communicationError(error); }
}
