import { requireModulePermission } from "@/lib/server-admin";
import { communicationId, CommunicationInputError } from "@/lib/communications";
import { renderMessage } from "@/lib/communication-templates";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";
import { requireCompose } from "@/lib/server-communication-compose";

type PreviewData = {
  rule_id: string; rule_revision: number; contractor_id: number; company_name: string; dba_name: string | null;
  contact_id: string; contact_name: string; contact_email: string; requirement_name: string;
  expiration_date: string; days_remaining: number; project_id: number | null; project_number: string | null; project_name: string | null;
  template_id: string; template_revision: number; template_subject: string | null; template_body: string;
  sender_name: string | null; sender_address: string | null; organization_name: string | null; application_name: string | null;
  duplicate: boolean; other_recipient_sent: boolean;
};

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new CommunicationInputError("Choose a valid contractor or project.");
  }
  return value;
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "settings", "view");
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
    const context = {
      contractor_name: preview.company_name, contractor_dba: preview.dba_name,
      contact_name: preview.contact_name, contact_first_name: null, contact_email: preview.contact_email,
      compliance_type: preview.requirement_name, expiration_date: preview.expiration_date,
      days_until_expiration: String(preview.days_remaining), project_number: preview.project_number, project_name: preview.project_name,
      sender_name: preview.sender_name, sender_email: preview.sender_address,
      organization_name: preview.organization_name, application_name: preview.application_name,
    };
    const subject = renderMessage(preview.template_subject ?? "", context), body = renderMessage(preview.template_body, context);
    const { duplicate, other_recipient_sent, ...snapshot } = preview;
    return Response.json({ preview: { ...preview, subject: subject.text, body: body.text, snapshot,
      duplicate, other_recipient_sent, unresolved: [...new Set([...subject.unresolved, ...body.unresolved])] }, execution_enabled: false },
    { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
