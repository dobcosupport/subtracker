import { CommunicationInputError } from "@/lib/communications";
import { TEMPLATE_CATEGORIES, type ComposeContact, type MessageTemplateInput } from "@/types/communication-compose";
import type { CommunicationChannel } from "@/types/communications";

export const MERGE_FIELDS = ["contact_name", "contact_email", "contact_mobile", "contractor_name", "project_number", "project_name",
  "compliance_type", "compliance_status", "expiration_date", "days_until_expiration", "organization_name", "application_name"] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];
export type MergeValues = Partial<Record<MergeField, string | null>>;

export function renderMessage(text: string, values: MergeValues) {
  const unresolved = new Set<string>();
  const resolved = text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (placeholder, key: string) => {
    const field = key.trim();
    const value = Object.hasOwn(values, field) ? values[field as MergeField] : null;
    if (typeof value !== "string" || !value.trim()) { unresolved.add(field); return placeholder; }
    return value;
  });
  if (/\{\{|\}\}/.test(text.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, ""))) unresolved.add("Malformed merge field");
  return { text: resolved, unresolved: [...unresolved] };
}

export function composeEligibility(contact: ComposeContact, channel: CommunicationChannel): boolean {
  return contact.is_active && (channel === "email"
    ? Boolean(contact.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) && contact.receives_email
    : Boolean(contact.mobile_phone && /^\+?[0-9 ().-]+$/.test(contact.mobile_phone) && contact.mobile_phone.replace(/\D/g, "").length >= 7)
      && contact.receives_sms && contact.sms_consent_recorded);
}

export function parseMessageTemplate(value: unknown, editing: boolean): MessageTemplateInput & { revision?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommunicationInputError("Expected template configuration.");
  const input = value as Record<string, unknown>;
  const keys = ["name", "category", "channel", "subject", "body", "is_active", ...(editing ? ["revision"] : [])];
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new CommunicationInputError("Unsupported template field.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new CommunicationInputError("Template name is required (maximum 200 characters).");
  if (!TEMPLATE_CATEGORIES.some((category) => category === input.category)) throw new CommunicationInputError("Choose a template category.");
  if (input.channel !== "email" && input.channel !== "sms") throw new CommunicationInputError("Choose a template channel.");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 100000) throw new CommunicationInputError("Template body is required (maximum 100000 characters).");
  if (input.subject !== null && (typeof input.subject !== "string" || input.subject.length > 1000)) throw new CommunicationInputError("Invalid template subject.");
  if (input.channel === "sms" && input.subject) throw new CommunicationInputError("SMS templates do not have subjects.");
  if (typeof input.is_active !== "boolean") throw new CommunicationInputError("Template Active must be boolean.");
  if (editing && (typeof input.revision !== "number" || !Number.isInteger(input.revision) || input.revision < 1 || input.revision > 2147483647)) throw new CommunicationInputError("A valid template revision is required.");
  for (const text of [input.body, input.subject ?? ""]) {
    const fields = renderMessage(String(text), {});
    if (fields.unresolved.some((field) => !MERGE_FIELDS.some((allowed) => allowed === field))) throw new CommunicationInputError("Use only supported merge fields with {{field_name}} syntax.");
  }
  return { name: input.name.trim(), category: input.category as MessageTemplateInput["category"], channel: input.channel,
    subject: input.channel === "email" ? input.subject as string | null : null, body: input.body, is_active: input.is_active,
    ...(editing ? { revision: input.revision as number } : {}) };
}
