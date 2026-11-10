import type { CommunicationDraft, CommunicationSummary, RecipientSnapshot } from "./communications";
import type { ComposeOptions } from "./communication-compose";

export type RecipientRole = "to" | "cc" | "bcc";
export type EmailChoice = {
  key: string;
  kind: "contact" | "company" | "project";
  label: string;
  detail: string;
  recipient?: RecipientSnapshot;
  contractor_id?: number;
  company_name?: string;
  project_id?: number;
  exclusion_reason?: string | null;
};
export type EmailConfiguration = Pick<ComposeOptions, "channels" | "installation" | "email_controls" | "scheduling">;
export type EmailAssessment = {
  draft: CommunicationDraft;
  exclusions: { email: string; recipient_role: RecipientRole; reason: string | null }[];
};
export type EmailListRow = CommunicationSummary & {
  subject?: string | null;
  recipients?: RecipientSnapshot[];
};
