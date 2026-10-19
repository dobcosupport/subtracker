import type { ChannelSettingsInput, CommunicationChannel, CommunicationDraft, ConfigurationStatus, RecipientSnapshot } from "@/types/communications";
import { SMS_VERIFICATION_STATUSES } from "@/types/communications";

export class CommunicationInputError extends Error {}
const invalid = (message: string): never => { throw new CommunicationInputError(message); };
export function communicationId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid("Invalid communication ID.");
  return value;
}
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid("Expected an object.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) invalid("Unsupported field.");
  return input;
}
function text(value: unknown, label: string, max = 500): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || value.length > max) return invalid(`${label} must be text of at most ${max} characters.`);
  return value.trim() || null;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") return invalid(`${label} must be true or false.`);
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) return invalid("Expected a positive integer ID or revision.");
  return value;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 100) return invalid("Expected an array with at most 100 items.");
  return value;
}
function ids(value: unknown): number[] {
  const result = array(value).map(integer);
  if (new Set(result).size !== result.length) invalid("Duplicate relationship IDs are not allowed.");
  return result;
}
function email(value: unknown): string | null {
  const result = text(value, "Email", 254);
  if (result && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) invalid("Enter a valid email address.");
  return result;
}
function phone(value: unknown): string | null {
  const result = text(value, "Phone", 50);
  if (result && (!/^\+?[0-9 ().-]+$/.test(result) || result.replace(/\D/g, "").length < 7)) invalid("Enter a valid phone number.");
  return result;
}
export function parseChannelSettings(channel: CommunicationChannel, value: unknown): ChannelSettingsInput {
  const fields = channel === "email" ? ["from_name", "from_address", "reply_to_address", "sending_domain", "microsoft_tenant_id", "microsoft_client_id"] : ["sending_phone_number", "incoming_enabled", "two_way_enabled", "sms_verification_status"];
  const input = object(value, ["provider", "enabled", "automated_enabled", "revision", ...fields]);
  if (input.provider !== null && input.provider !== "azure_communication_services" && !(channel === "sms" && input.provider === "twilio") && !(channel === "email" && input.provider === "microsoft_365")) invalid("Choose a supported provider or leave it unconfigured.");
  const common: ChannelSettingsInput = {
    provider: input.provider as ChannelSettingsInput["provider"],
    enabled: boolean(input.enabled, "Enabled"),
    automated_enabled: boolean(input.automated_enabled, "Automated enabled"),
    revision: integer(input.revision),
  };
  if (channel === "sms") {
    const verification = input.sms_verification_status;
    if (verification !== undefined && !SMS_VERIFICATION_STATUSES.some((status) => status === verification)) invalid("Choose a supported SMS verification status.");
    return { ...common, sending_phone_number: phone(input.sending_phone_number), incoming_enabled: boolean(input.incoming_enabled, "Incoming enabled"), two_way_enabled: boolean(input.two_way_enabled, "Two-way enabled"),
      ...(verification === undefined ? {} : { sms_verification_status: verification as ChannelSettingsInput["sms_verification_status"] }) };
  }
  const domain = text(input.sending_domain, "Sending domain", 253);
  if (domain && !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) invalid("Enter a domain name without a URL or path.");
  const microsoftFields = Object.fromEntries((["microsoft_tenant_id", "microsoft_client_id"] as const).filter((key) => Object.hasOwn(input, key)).map((key) => {
    const value = text(input[key], key === "microsoft_tenant_id" ? "Tenant ID" : "Client ID", 36);
    if (value && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) invalid("Microsoft Tenant ID and Client ID must be UUIDs or blank.");
    return [key, value];
  }));
  return { ...common, from_name: text(input.from_name, "From name"), from_address: email(input.from_address), reply_to_address: email(input.reply_to_address),
    ...(Object.hasOwn(input, "sending_domain") ? { sending_domain: domain } : {}), ...microsoftFields };
}
export function configurationStatus(settings: ChannelSettingsInput, channel: CommunicationChannel): ConfigurationStatus {
  const configured = settings.provider || settings.enabled || settings.automated_enabled
    || (channel === "email" ? settings.from_name || settings.from_address || settings.reply_to_address || settings.sending_domain || settings.microsoft_tenant_id || settings.microsoft_client_id
      : settings.sending_phone_number || settings.incoming_enabled || settings.two_way_enabled);
  // Non-secret configuration alone cannot establish credential or connection readiness.
  return configured ? "Configuration Incomplete" : "Not Configured";
}
export function parseCommunicationDraft(value: unknown, editing: boolean): CommunicationDraft {
  const input = object(value, ["channel", "subject", "body", "recipients", "contractor_ids", "project_ids", "compliance_record_ids", "mycoi_policy_ids", "insurance_items", "template_id", ...(editing ? ["revision"] : [])]);
  if (input.channel !== "email" && input.channel !== "sms") invalid("Choose email or sms.");
  if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 100000) invalid("Message body is required (maximum 100000 characters).");
  const channel = input.channel as CommunicationChannel;
  const recipients = array(input.recipients).map((value): RecipientSnapshot => {
    const r = object(value, ["recipient_type", "recipient_name", "email", "mobile_phone", "contractor_contact_id", "dobco_contact_id"]);
    if (!["contractor_contact", "dobco_contact", "external"].includes(String(r.recipient_type))) invalid("Invalid recipient type.");
    const name = text(r.recipient_name, "Recipient name");
    if (!name) invalid("Recipient name is required.");
    const contractor = r.contractor_contact_id == null ? null : communicationId(String(r.contractor_contact_id));
    const dobco = r.dobco_contact_id == null ? null : communicationId(String(r.dobco_contact_id));
    if ((r.recipient_type === "external" && (contractor || dobco))
      || (r.recipient_type === "contractor_contact" && (!contractor || dobco))
      || (r.recipient_type === "dobco_contact" && (!dobco || contractor))) invalid("Recipient type and contact reference do not agree.");
    const destinationEmail = email(r.email), mobile = phone(r.mobile_phone);
    if (channel === "email" ? !destinationEmail : !mobile) invalid("Each recipient needs a destination for the selected channel.");
    return { recipient_type: r.recipient_type as RecipientSnapshot["recipient_type"], recipient_name: name!, email: destinationEmail, mobile_phone: mobile, contractor_contact_id: contractor, dobco_contact_id: dobco };
  });
  if (!recipients.length) invalid("At least one recipient snapshot is required.");
  const insurance = array(input.insurance_items).map((value) => {
    const item = object(value, ["contractor_id", "item_key"]);
    if (!["certificate_of_insurance", "general_liability", "workers_compensation"].includes(String(item.item_key))) invalid("Invalid insurance item.");
    return { contractor_id: integer(item.contractor_id), item_key: item.item_key as CommunicationDraft["insurance_items"][number]["item_key"] };
  });
  const subject = text(input.subject, "Subject", 1000);
  if (channel === "sms" && subject) invalid("SMS drafts do not have subjects.");
  const keys = recipients.map((r) => `${r.recipient_type}:${r.contractor_contact_id ?? r.dobco_contact_id ?? (channel === "email" ? r.email?.toLowerCase() : r.mobile_phone?.replace(/\D/g, ""))}`);
  if (new Set(keys).size !== keys.length) invalid("Duplicate recipients are not allowed.");
  return { channel, subject, body: input.body as string, recipients,
    ...(Object.hasOwn(input, "template_id") ? { template_id: input.template_id == null ? null : communicationId(String(input.template_id)) } : {}),
    contractor_ids: ids(input.contractor_ids), project_ids: ids(input.project_ids), compliance_record_ids: ids(input.compliance_record_ids),
    mycoi_policy_ids: ids(input.mycoi_policy_ids), insurance_items: insurance, ...(editing ? { revision: integer(input.revision) } : {}) };
}
