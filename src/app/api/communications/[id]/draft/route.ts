import { AdminApiError, requireModulePermission } from "@/lib/server-admin";
import { communicationId } from "@/lib/communications";
import { checkDatabaseError, communicationError, contentColumns } from "@/lib/server-communications";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { admin } = await requireModulePermission(request, "communications_content", "edit");
    const id = communicationId((await context.params).id);
    const { data, error } = await admin.from("communication_messages").select(`${contentColumns},provider,template_id,contractor_labels:communication_contractors(contractor_id,contractors(company_name)),project_labels:communication_projects(project_id,projects(project_number,project_name))`)
      .eq("id", id).eq("status", "Draft").eq("source", "manual").eq("direction", "outbound").maybeSingle();
    checkDatabaseError(error);
    if (!data) throw new AdminApiError("Editable manual Draft not found.", 404);
    return Response.json({ draft: { id: data.id, channel: data.channel, subject: data.subject, body: data.body, revision: data.revision,
      template_id: data.template_id, provider: data.provider, sender_name: data.sender_name, sender_address: data.sender_address,
      related_contractors: data.contractor_labels.map((link) => {
        const contractor = Array.isArray(link.contractors) ? link.contractors[0] : link.contractors;
        return { id: link.contractor_id, company_name: contractor?.company_name ?? `Contractor #${link.contractor_id}` };
      }),
      related_projects: data.project_labels.map((link) => {
        const project = Array.isArray(link.projects) ? link.projects[0] : link.projects;
        return { id: link.project_id, project_number: project?.project_number ?? String(link.project_id), project_name: project?.project_name ?? "Unavailable" };
      }),
      recipients: data.communication_recipients.map(({ recipient_type, recipient_name, email, mobile_phone, contractor_contact_id, dobco_contact_id }) =>
        ({ recipient_type, recipient_name, email, mobile_phone, contractor_contact_id, dobco_contact_id })),
      contractor_ids: data.communication_contractors.map((r) => r.contractor_id), project_ids: data.communication_projects.map((r) => r.project_id),
      compliance_record_ids: data.communication_compliance_items.map((r) => r.compliance_record_id), mycoi_policy_ids: data.communication_mycoi_items.map((r) => r.policy_id),
      insurance_items: data.communication_insurance_items.map(({ contractor_id, item_key }) => ({ contractor_id, item_key })),
    } });
  } catch (error) { return communicationError(error); }
}
