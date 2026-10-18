import type { CommunicationChannel } from "@/types/communications";

export interface ReminderRuleInput {
  days_before_expiration: number;
  email_enabled: boolean;
  sms_enabled: boolean;
  template_reference: string | null;
  email_template_id?: string | null;
  sms_template_id?: string | null;
}
export interface ReminderRule extends ReminderRuleInput {
  id: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface NotificationAutomation {
  email: { automated_enabled: boolean; revision: number };
  sms: { automated_enabled: boolean; revision: number };
}
export interface NotificationsConfiguration {
  automation: NotificationAutomation;
  rules: ReminderRule[];
  execution_enabled: false;
}
export type ReminderChannel = CommunicationChannel;
