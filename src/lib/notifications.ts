import { communicationId, CommunicationInputError } from "@/lib/communications";
import type { NotificationAutomation, ReminderChannel, ReminderRuleInput } from "@/types/notifications";

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommunicationInputError("Expected notification configuration.");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !keys.includes(key))) throw new CommunicationInputError("Unsupported notification configuration field.");
  return input;
}
function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 2147483647) throw new CommunicationInputError(`${label} must be a positive integer (maximum 2147483647).`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new CommunicationInputError(`${label} must be true or false.`);
  return value;
}
export function parseReminderRule(value: unknown, editing: boolean): ReminderRuleInput & { revision?: number } {
  const input = object(value, ["days_before_expiration", "email_enabled", "sms_enabled", "template_reference", "email_template_id", "sms_template_id", ...(editing ? ["revision"] : [])]);
  if (input.template_reference !== null && (typeof input.template_reference !== "string" || input.template_reference.length > 500)) throw new CommunicationInputError("Template reference must be non-secret text of at most 500 characters, or null.");
  return {
    days_before_expiration: positiveInteger(input.days_before_expiration, "Days Before Expiration"),
    email_enabled: boolean(input.email_enabled, "Email"),
    sms_enabled: boolean(input.sms_enabled, "SMS"),
    template_reference: typeof input.template_reference === "string" ? input.template_reference.trim() || null : null,
    ...Object.fromEntries(["email_template_id", "sms_template_id"].filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key] === null ? null : communicationId(String(input[key]))])),
    ...(editing ? { revision: positiveInteger(input.revision, "Revision") } : {}),
  };
}
export function parseReminderRemoval(value: unknown): number {
  const input = object(value, ["revision"]);
  return positiveInteger(input.revision, "Revision");
}
export function parseNotificationAutomation(value: unknown): NotificationAutomation {
  const input = object(value, ["email", "sms"]);
  const channel = (key: "email" | "sms") => {
    const settings = object(input[key], ["automated_enabled", "revision"]);
    return { automated_enabled: boolean(settings.automated_enabled, `Automated ${key}`), revision: positiveInteger(settings.revision, "Revision") };
  };
  return { email: channel("email"), sms: channel("sms") };
}
export function reminderIsActive(rule: ReminderRuleInput): boolean {
  return rule.email_enabled || rule.sms_enabled;
}
// Configuration eligibility only; provider, recipient, consent and message validation are still required.
export function reminderChannelConfigured(rule: ReminderRuleInput, automation: NotificationAutomation, channel: ReminderChannel): boolean {
  return (channel === "email" ? rule.email_enabled : rule.sms_enabled) && automation[channel].automated_enabled;
}
