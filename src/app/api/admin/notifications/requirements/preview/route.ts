import { requireModulePermission } from "@/lib/server-admin";
import { communicationId, CommunicationInputError } from "@/lib/communications";
import { renderTemplateContent, resolveTemplateContext } from "@/lib/server-template-rendering";
import type { CommunicationDraft } from "@/types/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { requireCompose } from "@/lib/server-communication-compose";

type PreviewData = {
  rule_id: string; rule_revision: number; contractor_id: number; company_name: string; dba_name: string | null;
  contact_id: string; contact_name: string; contact_email: string; requirement_name: string;
  expiration_date: string; days_remaining: number; project_id: number | null; project_number: string | null; project_name: string | null;
  template_id: string; template_revision: number; template_subject: string | null; template_body: string;
  sender_name: string | null; sender_address: string | null; organization_name: string | null; application_name: string | null;
  duplicate: boolean; other_recipient_sent: boolean;
  compliance_record_id: number | null;
  policy_id: number | null;
};

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new CommunicationInputError("Choose a valid contractor or project.");
  }
  return value;
}

export async function POST(request: Request) {
  try {
    const context = await requireModulePermission(request, "settings", "view");
    const { admin, profile } = context;
    await requireCompose(request);
    await requireModulePermission(request, "communications_delivery", "view");
    const input: unknown = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CommunicationInputError("Invalid notice preview request.");
    const values = input as Record<string, unknown>;
    if (Object.keys(values).some(key => !["rule_id", "contractor_id", "contact_id", "project_id"].includes(key))
      || typeof values.rule_id !== "string" || typeof values.contact_id !== "string") {
      throw new CommunicationInputError("Choose a requirement rule, contractor and contact.");
    }
    const { data, error } = await admin.rpc("preview_requirement_notice", {
      p_actor: profile.auth_user_id, p_rule: communicationId(values.rule_id), p_contractor: positiveId(values.contractor_id),
      p_contact: communicationId(values.contact_id), p_project: values.project_id == null ? null : positiveId(values.project_id),
    });
    checkDatabaseError(error);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("The notice preview was not returned.");
    const preview = data as PreviewData;
    if (typeof preview.template_body !== "string" || typeof preview.contact_email !== "string"
      || typeof preview.company_name !== "string" || typeof preview.requirement_name !== "string"
      || typeof preview.days_remaining !== "number" || typeof preview.duplicate !== "boolean"
      || typeof preview.other_recipient_sent !== "boolean") throw new Error("The notice preview returned invalid data.");
    const draft: CommunicationDraft = { channel: "email", subject: preview.template_subject, body: preview.template_body,
      template_id: preview.template_id, template_revision: preview.template_revision, contractor_ids: [preview.contractor_id],
      compliance_record_ids: preview.compliance_record_id == null ? [] : [preview.compliance_record_id],
      project_ids: preview.project_id == null ? [] : [preview.project_id],
      mycoi_policy_ids: preview.policy_id == null ? [] : [preview.policy_id], insurance_items: [],
      recipients: [{ recipient_type: "contractor_contact", contractor_contact_id: preview.contact_id, dobco_contact_id: null,
        recipient_name: preview.contact_name, email: preview.contact_email, mobile_phone: null }] };
    const resolved = await resolveTemplateContext(context, draft);
    const rendered = renderTemplateContent(draft.subject ?? "", draft.body, resolved);
    const { duplicate, other_recipient_sent, ...snapshot } = preview;
    return Response.json({ preview: { ...preview, subject: rendered.subject, body: rendered.body, snapshot,
      duplicate, other_recipient_sent, unresolved: [], followup_subject: rendered.followup_subject }, execution_enabled: false },
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
