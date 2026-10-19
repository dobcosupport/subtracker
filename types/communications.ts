export const COMMUNICATION_STATUSES = ["Draft", "Queued", "Sending", "Sent", "Delivered", "Failed", "Cancelled"] as const;
export type CommunicationStatus = (typeof COMMUNICATION_STATUSES)[number];
export type CommunicationChannel = "email" | "sms";
export type EmailProvider = "microsoft_365" | "azure_communication_services";
export type CredentialProvider = EmailProvider;
export type EmailConnectionStatus = "Not Configured" | "Ready for Testing" | "Verified" | "Test Failed";
export type ConfigurationStatus = "Not Configured" | "Configuration Incomplete" | "Ready for Connection Testing";
export const SMS_VERIFICATION_STATUSES = ["not_recorded", "not_submitted", "under_review", "approved", "rejected"] as const;
export type SmsVerificationStatus = (typeof SMS_VERIFICATION_STATUSES)[number];

export interface ChannelSettingsInput {
  provider: EmailProvider | "twilio" | null;
  enabled: boolean;
  automated_enabled: boolean;
  from_name?: string | null;
  from_address?: string | null;
  reply_to_address?: string | null;
  sending_domain?: string | null;
  microsoft_tenant_id?: string | null;
  microsoft_client_id?: string | null;
  sending_phone_number?: string | null;
  sms_verification_status?: SmsVerificationStatus;
  incoming_enabled?: boolean;
  two_way_enabled?: boolean;
  revision: number;
}
export interface ChannelSettings extends ChannelSettingsInput {
  channel: CommunicationChannel;
  configuration_status: ConfigurationStatus;
}
export interface RecipientSnapshot {
  recipient_type: "contractor_contact" | "dobco_contact" | "external";
  recipient_name: string;
  email: string | null;
  mobile_phone: string | null;
  contractor_contact_id: string | null;
  dobco_contact_id: string | null;
}
export interface CommunicationDraft {
  template_id?: string | null;
  channel: CommunicationChannel;
  subject: string | null;
  body: string;
  recipients: RecipientSnapshot[];
  contractor_ids: number[];
  project_ids: number[];
  compliance_record_ids: number[];
  mycoi_policy_ids: number[];
  insurance_items: { contractor_id: number; item_key: "certificate_of_insurance" | "general_liability" | "workers_compensation" }[];
  revision?: number;
}
export interface CommunicationSummary {
  id: string;
  channel: CommunicationChannel;
  direction: "inbound" | "outbound";
  source: "manual" | "automated";
  status: CommunicationStatus;
  created_at: string;
  recipient_count: number;
  description: string;
  contractors: { contractor_id: number; contractors: { company_name: string } | null }[];
  projects: { project_id: number; projects: { project_number: string; project_name: string } | null }[];
}
