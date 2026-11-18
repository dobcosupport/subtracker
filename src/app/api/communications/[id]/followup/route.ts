import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { processCommunicationFollowup } from "@/lib/server-communication-followup";

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const { admin } = await requireModulePermission(request, "communications_delivery", "view");
    const id = communicationId((await context.params).id);
    const { data, error } = await admin.from("communication_followup_actions")
      .select("state,followup_id,attempts,last_error").eq("message_id", id).maybeSingle();
    checkDatabaseError(error);
    return Response.json({ followup: data ?? { state: "not_configured" } }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
export async function POST(request: Request, context: Context) {
  try {
    const { admin } = await requireModulePermission(request, "communications_delivery", "manage");
    const id = communicationId((await context.params).id);
    if (request.headers.get("content-length") && request.headers.get("content-length") !== "0") {
      throw new AdminApiError("Follow-Up recovery takes no input and never sends email.", 400);
    }
    return Response.json({ followup: await processCommunicationFollowup(admin, id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
