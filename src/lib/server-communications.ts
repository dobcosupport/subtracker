import "server-only";
import { AdminApiError, jsonError } from "@/lib/server-admin";
import { CommunicationInputError } from "@/lib/communications";

export const settingsColumns = "channel,provider,enabled,automated_enabled,from_name,from_address,reply_to_address,sending_domain,microsoft_tenant_id,microsoft_client_id,sending_phone_number,incoming_enabled,two_way_enabled,revision";
export const contentColumns = "id,channel,direction,source,status,subject,body,sender_name,sender_address,created_by,created_at,updated_at,revision,communication_recipients(id,recipient_type,recipient_name,email,mobile_phone,contractor_contact_id,dobco_contact_id),communication_contractors(contractor_id),communication_projects(project_id),communication_compliance_items(compliance_record_id),communication_mycoi_items(policy_id),communication_insurance_items(contractor_id,item_key)";
export const deliveryColumns = "id,status,provider,provider_message_id,queued_at,sent_at,delivered_at,failed_at,cancelled_at,failure_reason,sent_by,communication_recipients(id,status,provider_recipient_id,failure_reason,queued_at,sent_at,delivered_at,failed_at,cancelled_at)";
export const summaryColumns = "id,channel,direction,source,status,created_at,communication_recipients(count),communication_contractors(contractor_id,contractors(company_name)),communication_projects(project_id,projects(project_number,project_name))";

export function communicationError(error: unknown): Response {
  if (error instanceof CommunicationInputError || error instanceof SyntaxError) return jsonError(new AdminApiError(error.message, 400));
  return jsonError(error);
}
export function checkDatabaseError(error: { code?: string; message: string } | null): void {
  if (!error) return;
  const status = error.code === "42501" ? 403 : error.code === "P0002" ? 404
    : error.code === "40001" ? 409 : ["22023", "22P02", "23503", "23505", "23514", "23502"].includes(error.code ?? "") ? 400 : 500;
  throw new AdminApiError(error.message, status);
}
