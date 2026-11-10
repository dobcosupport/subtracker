import { AdminApiError } from "@/lib/server-admin";
import { requireCompose } from "@/lib/server-communication-compose";
import { emailWorkspaceControls, workspacePermission } from "@/lib/server-email-workspace";
import { parseCommunicationDraft } from "@/lib/communications";
import { renderMessage, type MergeValues } from "@/lib/communication-templates";
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
    // Saving validates source permissions and relationships again. This read-only assessment never writes.
    const [{ data: settings, error: settingsError }, { data: installation, error: installationError }] = await Promise.all([
      admin.from("communication_channel_settings").select("from_name,from_address").eq("channel", "email").single(),
      admin.from("user_invitation_email_settings").select("organization_name,application_name").single(),
    ]);
    checkDatabaseError(settingsError); checkDatabaseError(installationError);
    const values: MergeValues = { ...installation, sender_name: settings?.from_name, sender_email: settings?.from_address };
    if (input.recipients.length === 1) {
      const r = input.recipients[0];
      values.contact_name = r.recipient_name; values.contact_first_name = r.recipient_name.split(/\s+/)[0];
      values.contact_email = r.email; values.contact_mobile = r.mobile_phone;
    }
    // Merge values never come from arbitrary client context.
    const permission = async (module: "contractors" | "projects" | "compliance") => {
      if (!await workspacePermission(context, module)) throw new AdminApiError(`${module} View permission is required.`, 403);
    };
    if (input.contractor_ids.length) await permission("contractors");
    if (input.contractor_ids.length === 1) {
      const { data, error } = await admin.from("contractors").select("company_name,dba_name").eq("id", input.contractor_ids[0]).single();
      checkDatabaseError(error); values.contractor_name = data?.company_name; values.contractor_dba = data?.dba_name;
    }
    if (input.project_ids.length) await permission("projects");
    if (input.project_ids.length === 1) {
      const { data, error } = await admin.from("projects").select("project_number,project_name").eq("id", input.project_ids[0]).single();
      checkDatabaseError(error); values.project_number = data?.project_number; values.project_name = data?.project_name;
    }
    if (input.compliance_record_ids.length) { await permission("contractors"); await permission("compliance"); }
    if (input.compliance_record_ids.length === 1) {
      const { data, error } = await admin.from("contractor_compliance_status")
        .select("compliance_name,calculated_status,expiration_date,days_remaining")
        .eq("compliance_record_id", input.compliance_record_ids[0]).single();
      checkDatabaseError(error);
      values.compliance_type = data?.compliance_name; values.compliance_status = data?.calculated_status;
      values.expiration_date = data?.expiration_date; values.days_until_expiration = data?.days_remaining == null ? null : String(data.days_remaining);
    }
    const subject = renderMessage(input.subject ?? "", values), body = renderMessage(input.body, values);
    const unresolved = [...new Set([...subject.unresolved, ...body.unresolved])];
    if (unresolved.length) throw new AdminApiError(`Complete the context for these template fields: ${unresolved.join(", ")}.`, 400);
    if (!subject.text.trim()) throw new AdminApiError("A subject is required.", 400);
    return Response.json({ draft: { ...input, subject: subject.text, body: body.text }, exclusions },
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return communicationError(error); }
}
