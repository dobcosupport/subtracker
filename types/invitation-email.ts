export type InvitationDeliveryMode = "supabase_auth" | "application_email_provider";

export interface InvitationEmailSettingsInput {
  enabled: boolean;
  delivery_mode: InvitationDeliveryMode;
  organization_name: string | null;
  application_name: string | null;
  subject: string | null;
  application_base_url: string | null;
  invitation_path: string | null;
  template_reference: string | null;
  template_content: string | null;
  sender_reference: string | null;
  reply_to_reference: string | null;
  revision: number;
}

export interface InvitationDeliveryPlan {
  configured_adapter: InvitationDeliveryMode;
  connector_status: "Externally Managed" | "Not Implemented";
  active_delivery_mode: "supabase_auth";
  configuration_only: true;
}
