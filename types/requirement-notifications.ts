export interface RequirementInterval {
  days_before_expiration: number;
  enabled: boolean;
  template_id: string | null;
}
export interface RequirementRule {
  id: string | null;
  compliance_type_id: number | null;
  insurance_item_key: string | null;
  name: string;
  retired: boolean;
  expiration_allowed: boolean;
  automatic_enabled: boolean;
  configuration_ready: boolean;
  eligibility_authority: "current_requirement" | "nj_pwc_monitoring";
  schedule_type: "expiration" | "non_expiring";
  sender_contact_id: string | null;
  internal_contact_id: string | null;
  revision: number;
  intervals: RequirementInterval[];
}
export interface AutomationTemplate {
  id: string;
  name: string;
  channel: string;
  revision: number;
  is_active: boolean;
  subject: string | null;
  body: string;
  approved_by: string | null;
  approved_at: string | null;
}
export interface RequirementNotificationConfiguration {
  rules: RequirementRule[];
  templates: AutomationTemplate[];
  contacts: { id: string; contact_name: string; is_active: boolean }[];
  execution_enabled: false;
}
