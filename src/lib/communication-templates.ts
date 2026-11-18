import { CommunicationInputError, parseEmailImportance } from "@/lib/communications";
import { TEMPLATE_CATEGORIES, TEMPLATE_OPERATION_DEFAULTS, type ComposeContact, type MessageTemplateInput } from "@/types/communication-compose";
import { COMMUNICATION_FOLLOWUP_DEFAULTS, type CommunicationChannel, type CommunicationFollowup } from "@/types/communications";

export function templateFollowupDefaults(template: MessageTemplateInput | null): CommunicationFollowup {
  return { ...COMMUNICATION_FOLLOWUP_DEFAULTS, enabled: template?.followup_enabled ?? false,
    status: template?.followup_status ?? "Open", delay_days: template?.followup_delay_days ?? 30,
    subject: template?.followup_subject ?? "" };
}

export const MERGE_FIELDS = ["contact_name", "contact_email", "contact_mobile", "contractor_name", "project_number", "project_name",
  "contact_first_name", "contractor_dba", "sender_name", "sender_email",
  "compliance_type", "registration_number", "compliance_status", "expiration_date", "days_until_expiration", "organization_name", "application_name"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export const INSERTABLE_MERGE_FIELDS: MergeField[] = ["contractor_name", "compliance_type", "registration_number", "expiration_date",
  ...MERGE_FIELDS.filter(field => !["contractor_name", "compliance_type", "registration_number", "expiration_date", "contact_first_name"].includes(field))];
export type MergeValues = Partial<Record<MergeField, string | null>>;
export const MERGE_FIELD_LABELS: Record<MergeField, string> = {
  contractor_name: "Company Name", compliance_type: "Compliance Type", registration_number: "Registration Number",
  expiration_date: "Expiration Date", contact_name: "Contact Name", contact_email: "Contact Email",
  contact_mobile: "Contact Mobile", project_number: "Project Number", project_name: "Project Name",
  contact_first_name: "Contact First Name", contractor_dba: "Company DBA", sender_name: "Sender Name",
  sender_email: "Sender Email", compliance_status: "Compliance Status", days_until_expiration: "Days Until Expiration",
  organization_name: "Organization Name", application_name: "Application Name",
};

function legacyFields(text: string): MergeField[] {
  return MERGE_FIELDS.filter(field => text.toLowerCase().includes(`[${MERGE_FIELD_LABELS[field].toLowerCase()}]`));
}

export function unresolvedMergeMessage(fields: string[]): string {
  const labels = fields.map(field => Object.hasOwn(MERGE_FIELD_LABELS, field) ? MERGE_FIELD_LABELS[field as MergeField] : field);
  return `Cannot send: ${labels.join(", ")} could not be resolved for this recipient. Select the required records and use supported {{field_name}} merge fields.`;
}

export function renderMessage(text: string, values: MergeValues) {
  const unresolved = new Set<string>();
  const resolved = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (placeholder, key: string) => {
    const field = key.trim();
    const value = Object.hasOwn(values, field) ? values[field as MergeField] : null;
    if (typeof value !== "string" || !value.trim()) { unresolved.add(field); return placeholder; }
    return value;
  });
  resolved.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (placeholder, key: string) => {
    unresolved.add(key.trim());
    return placeholder;
  });
  if (/\{\{|\}\}/.test(resolved.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, ""))) unresolved.add("Malformed merge field");
  for (const field of legacyFields(resolved)) unresolved.add(field);
  return { text: resolved, unresolved: [...unresolved] };
}

export function composeEligibility(contact: ComposeContact, channel: CommunicationChannel): boolean {
  return contact.is_active && (channel === "email"
    ? Boolean(contact.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) && contact.receives_email
    : contact.type === "dobco_contact" && Boolean(contact.mobile_phone && /^\+?[0-9 ().-]+$/.test(contact.mobile_phone) && contact.mobile_phone.replace(/\D/g, "").length >= 7)
      && contact.receives_sms && contact.sms_consent_recorded);
}

export function parseMessageTemplate(value: unknown, editing: boolean): MessageTemplateInput & { revision?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommunicationInputError("Expected template configuration.");
  const input = value as Record<string, unknown>;
  const keys = ["name", "category", "channel", "subject", "body", "is_active", ...Object.keys(TEMPLATE_OPERATION_DEFAULTS), ...(editing ? ["revision"] : [])];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new CommunicationInputError("Unsupported template field.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new CommunicationInputError("Template name is required (maximum 200 characters).");
  if (!TEMPLATE_CATEGORIES.some((category) => category === input.category)) throw new CommunicationInputError("Choose a template category.");
  if (input.channel !== "email" && input.channel !== "sms") throw new CommunicationInputError("Choose a template channel.");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 100000) throw new CommunicationInputError("Template body is required (maximum 100000 characters).");
  if (input.subject !== null && (typeof input.subject !== "string" || input.subject.length > 1000)) throw new CommunicationInputError("Invalid template subject.");
  if (input.channel === "sms" && input.subject) throw new CommunicationInputError("SMS templates do not have subjects.");
  if (typeof input.is_active !== "boolean") throw new CommunicationInputError("Template Active must be boolean.");
  if (editing && (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1 || input.revision > 2147483647)) throw new CommunicationInputError("A valid template revision is required.");
  const config = Object.fromEntries(Object.entries(TEMPLATE_OPERATION_DEFAULTS).map(([key, defaultValue]) => [key, Object.hasOwn(input, key) ? input[key] : defaultValue]));
  config.default_importance = parseEmailImportance(config.default_importance);
  if (typeof config.purpose !== "string" || config.purpose.length > 200) throw new CommunicationInputError("Reminder Stage / Purpose must be at most 200 characters.");
  if (typeof config.followup_enabled !== "boolean") throw new CommunicationInputError("Create Follow-Up must be boolean.");
  if (!["Open", "Waiting Response", "Resolved", "Closed"].includes(String(config.followup_status))) throw new CommunicationInputError("Choose a Follow-Up status.");
  if (typeof config.followup_delay_days !== "number" || !Number.isInteger(config.followup_delay_days) || config.followup_delay_days < 0 || config.followup_delay_days > 36500) throw new CommunicationInputError("Follow-Up delay must be 0–36500 days.");
  if (typeof config.followup_subject !== "string" || config.followup_subject.length > 200) throw new CommunicationInputError("Follow-Up Subject must be at most 200 characters.");
  if (!["contractor", "originating_compliance_record"].includes(String(config.followup_related_item))) throw new CommunicationInputError("Choose the Follow-Up related item.");
  if (config.followup_enabled && (input.channel !== "email" || !config.followup_subject.trim())) throw new CommunicationInputError("Email and a Follow-Up Subject are required to create a Follow-Up.");
  for (const text of [input.body, input.subject ?? "", config.followup_subject]) {
    if (legacyFields(String(text)).length) throw new CommunicationInputError("Square-bracket merge fields are not supported. Use Insert Field or {{field_name}} syntax.");
    const fields = renderMessage(String(text), {});
    if (fields.unresolved.some((field) => !MERGE_FIELDS.some((allowed) => allowed === field))) throw new CommunicationInputError("Use only supported merge fields with {{field_name}} syntax.");
  }
  return { name: input.name.trim(), category: input.category as MessageTemplateInput["category"], channel: input.channel,
    subject: input.channel === "email" ? input.subject as string | null : null, body: input.body, is_active: input.is_active,
    ...config, ...(editing ? { revision: input.revision as number } : {}) };
}
