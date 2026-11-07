import { requireModulePermission } from "@/lib/server-admin";
import { communicationId, CommunicationInputError } from "@/lib/communications";
import { checkDatabaseError, communicationError } from "@/lib/server-communications";

function positiveId(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new CommunicationInputError("Choose a valid contractor or project.");
  }
  return value;
}

export async function POST(request: Request) {
  try {
    const { admin, profile } = await requireModulePermission(request, "communications_content", "add");
    const input: unknown = await request.json();
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new CommunicationInputError("Invalid notice draft.");
    const values = input as Record<string, unknown>;
    if (Object.keys(values).some(key => !["rule_id", "contractor_id", "contact_id", "project_id", "preview", "subject", "body", "is_test"].includes(key))
      || typeof values.rule_id !== "string" || typeof values.contact_id !== "string"
      || !values.preview || typeof values.preview !== "object" || Array.isArray(values.preview)
      || typeof values.subject !== "string" || typeof values.body !== "string" || typeof values.is_test !== "boolean"
      || !values.subject.trim() || values.subject.length > 1000 || !values.body.trim() || values.body.length > 100000) {
      throw new CommunicationInputError("A reviewed notice, subject, body and explicit test designation are required.");
    }
    const { data, error } = await admin.rpc("create_requirement_notice_draft", {
      p_actor: profile.auth_user_id, p_rule: communicationId(values.rule_id), p_contractor: positiveId(values.contractor_id),
      p_contact: communicationId(values.contact_id), p_project: values.project_id == null ? null : positiveId(values.project_id),
      p_preview: values.preview, p_subject: values.subject, p_body: values.body, p_is_test: values.is_test,
    });
    checkDatabaseError(error);
    if (typeof data !== "string") throw new Error("Notice draft creation was not confirmed. Review history before retrying.");
    return Response.json({ id: data, status: "Draft", revision: 1 }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
