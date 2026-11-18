import type { CommunicationChannel, CommunicationDraft, EmailImportance } from "@/types/communications";
import type { ScheduledEmailStatus } from "@/types/scheduled-email";

export const TEMPLATE_CATEGORIES = ["Expiration Reminder", "Out of Compliance", "Compliance Restored", "General Contractor Communication", "Internal Alert"] as const;
export interface TemplateOperations {
  default_importance: EmailImportance;
  purpose: string;
  followup_enabled: boolean;
  followup_status: "Open" | "Waiting Response" | "Resolved" | "Closed";
  followup_delay_days: number;
  followup_subject: string;
  followup_related_item: "contractor" | "originating_compliance_record";
}
export const TEMPLATE_OPERATION_DEFAULTS: TemplateOperations = {
  default_importance: "normal",
  purpose: "", followup_enabled: false, followup_status: "Open", followup_delay_days: 30,
  followup_subject: "", followup_related_item: "originating_compliance_record",
};
export interface MessageTemplateInput {
  default_importance?: EmailImportance;
  name: string;
  category: (typeof TEMPLATE_CATEGORIES)[number];
  channel: CommunicationChannel;
  subject: string | null;
  body: string;
  is_active: boolean;
  purpose?: TemplateOperations["purpose"];
  followup_enabled?: TemplateOperations["followup_enabled"];
  followup_status?: TemplateOperations["followup_status"];
  followup_delay_days?: TemplateOperations["followup_delay_days"];
  followup_subject?: TemplateOperations["followup_subject"];
  followup_related_item?: TemplateOperations["followup_related_item"];
}
export interface MessageTemplate extends MessageTemplateInput {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
interface ComposeContactBase {
  id: string;
  contractor_id: number | null;
  contact_name: string;
  email: string | null;
  mobile_phone: string | null;
  is_active: boolean;
  receives_email: boolean;
}
export type ComposeContact = ComposeContactBase & (
  { type: "contractor_contact" }
  | { type: "dobco_contact"; receives_sms: boolean; sms_consent_recorded: boolean }
);
export interface ComposeOptions {
  scheduling?: ScheduledEmailStatus;
  email_controls?: { available: boolean; enabled?: boolean; contractor_email_enabled?: boolean; internal_email_enabled?: boolean; notice?: string };
  contractors: { id: number; company_name: string; dba_name?: string | null }[];
  projects: { id: number; project_number: string; project_name: string }[];
  contacts: ComposeContact[];
  templates: MessageTemplate[];
  installation: { organization_name: string | null; application_name: string | null };
  channels: { channel: CommunicationChannel; provider: string | null; from_name: string | null; from_address: string | null; sending_phone_number: string | null; manual_send_ready: boolean }[];
}
export interface ComposeCompliance {
  contractor_id: number;
  compliance_record_id: number;
  compliance_name: string;
  registration_number?: string | null;
  calculated_status: string;
  expiration_date: string | null;
  days_remaining: number | null;
}
export interface EditableDraft extends CommunicationDraft {
  id: string;
  revision: number;
  provider: string | null;
  sender_name: string | null;
  sender_address: string | null;
  related_contractors: ComposeOptions["contractors"];
  related_projects: ComposeOptions["projects"];
}
