import { getRequestContext, AdminApiError } from "@/lib/server-admin";
import { workspacePermission, emailRecipientRoles, storedEmailRole } from "@/lib/server-email-workspace";
import { getCommunicationSummaries } from "@/lib/server-communication-history";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const folder = params.get("folder") ?? "Drafts";
    if (!["Drafts", "Scheduled", "Sent"].includes(folder)) throw new AdminApiError("Unknown email folder.", 400);
    const query = new URLSearchParams({ channel: "email", offset: params.get("offset") ?? "0" });
    if (folder === "Drafts") query.set("status", "Draft");
    else if (folder === "Sent" && params.get("status")) {
      const status = params.get("status")!;
      if (!["Failed", "Cancelled", "Skipped"].includes(status)) throw new AdminApiError("Invalid delivery status filter.", 400);
      query.set("status", status);
    } else query.set("view", folder);
    const history = await getCommunicationSummaries(request, query);
    const context = await getRequestContext(request);
    const contentAllowed = await workspacePermission(context, "communications_content");
    if (!contentAllowed || !history.messages.length) return Response.json(history, { headers: { "Cache-Control": "no-store" } });
    const { data, error } = await context.admin.from("communication_messages")
      .select("id,subject,communication_recipients(id,recipient_type,recipient_name,email,mobile_phone,contractor_contact_id,dobco_contact_id)")
      .in("id", history.messages.map(m => m.id));
    checkDatabaseError(error);
    const roles = await emailRecipientRoles(context.admin, history.messages.map(m => m.id));
    return Response.json({ ...history, messages: history.messages.map(m => {
      const detail = data?.find(d => d.id === m.id);
      return { ...m, subject: detail?.subject, recipients: detail?.communication_recipients.map(r => ({
        ...r, recipient_role: storedEmailRole(roles, r.id),
      })) };
    }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
