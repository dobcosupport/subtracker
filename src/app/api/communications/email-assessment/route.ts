import { AdminApiError } from "@/lib/server-admin";
import { requireCompose } from "@/lib/server-communication-compose";
import { emailWorkspaceControls } from "@/lib/server-email-workspace";
import { parseCommunicationDraft } from "@/lib/communications";
import { renderTemplateContent, resolveTemplateContext } from "@/lib/server-template-rendering";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";

export async function POST(request: Request) {
  try {
    const context = await requireCompose(request);
    const { admin, profile } = context;
    const payload = await request.json();
    const input = parseCommunicationDraft(payload, payload?.revision !== undefined);
    if (input.channel !== "email") throw new AdminApiError("Email composition is required.", 400);
    const controls = await emailWorkspaceControls(context);
    if (!controls.available) throw new AdminApiError(controls.notice, 409);
    const { data: exclusions, error } = await admin.rpc("communication_email_eligibility", {
      p_actor: profile.auth_user_id, p_recipients: input.recipients,
    });
    checkDatabaseError(error);
    if (!Array.isArray(exclusions) || exclusions.length !== input.recipients.length
      || input.recipients.some((r, i) => exclusions[i]?.email !== r.email
        || exclusions[i]?.recipient_role !== (r.recipient_role ?? "to")
        || (exclusions[i]?.reason !== null && typeof exclusions[i]?.reason !== "string"))) {
      throw new AdminApiError("Recipient eligibility could not be verified.", 503);
    }
    const renderContext = await resolveTemplateContext(context, input);
    const rendered = renderTemplateContent(input.subject ?? "", input.body, renderContext);
    if (!rendered.subject.trim()) throw new AdminApiError("A subject is required.", 400);
    return Response.json({ draft: { ...input, subject: rendered.subject, body: rendered.body, followup: renderContext.followup }, exclusions,
      followup: renderContext.followup.enabled ? { ...renderContext.followup, subject: rendered.followup_subject,
        related_item: input.compliance_record_ids.length === 1 ? "originating_compliance_record" : "contractor",
        related_label: input.compliance_record_ids.length === 1
          ? [renderContext.values.compliance_type, renderContext.values.registration_number].filter(Boolean).join(" / ")
          : renderContext.values.contractor_name } : null },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
