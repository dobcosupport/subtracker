import { CommunicationInputError, communicationId } from "@/lib/communications";
import type { AutomationTemplate, RequirementInterval } from "@/types/requirement-notifications";

export function automationTemplateReady(template: AutomationTemplate | undefined): boolean {
  return !!template && template.channel === "email" && template.is_active && !!template.approved_at;
}
export function parseRequirementRule(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommunicationInputError("Invalid requirement rule.");
  const input = value as Record<string, unknown>;
  const keys = ["compliance_type_id", "insurance_item_key", "automatic_enabled", "schedule_type", "sender_contact_id", "internal_contact_id", "revision", "intervals"];
  if (Object.keys(input).some(key => !keys.includes(key)) || typeof input.automatic_enabled !== "boolean"
    || !["expiration", "non_expiring"].includes(String(input.schedule_type))
    || !Number.isSafeInteger(input.revision) || Number(input.revision) < 0 || Number(input.revision) > 2147483647
    || !Array.isArray(input.intervals) || input.intervals.length > 100) throw new CommunicationInputError("Invalid requirement rule.");
  const compliance = input.compliance_type_id;
  const insurance = input.insurance_item_key;
  if ((compliance == null) === (insurance == null) || (compliance != null && (!Number.isSafeInteger(compliance) || Number(compliance) < 1 || Number(compliance) > 2147483647))
    || (insurance != null && !["general_liability", "workers_compensation", "certificate_of_insurance"].includes(String(insurance)))) throw new CommunicationInputError("Choose an existing requirement.");
  const intervals: RequirementInterval[] = input.intervals.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new CommunicationInputError("Invalid interval.");
    const item = value as Record<string, unknown>;
    if (Object.keys(item).some(key => !["days_before_expiration", "enabled", "template_id"].includes(key))
      || !Number.isSafeInteger(item.days_before_expiration) || Number(item.days_before_expiration) < 1 || Number(item.days_before_expiration) > 36500
      || typeof item.enabled !== "boolean") throw new CommunicationInputError("Intervals require unique days from 1 to 36500 and an enabled state.");
    const template = item.template_id == null ? null : communicationId(String(item.template_id));
    if (item.enabled && !template) throw new CommunicationInputError("Enabled intervals require an approved template.");
    return { days_before_expiration: Number(item.days_before_expiration), enabled: item.enabled, template_id: template };
  });
  if (new Set(intervals.map(interval => interval.days_before_expiration)).size !== intervals.length) throw new CommunicationInputError("Interval days must be unique.");
  if (input.schedule_type === "non_expiring" && (input.automatic_enabled || intervals.length)) throw new CommunicationInputError("Non-expiring requirements cannot use expiration intervals.");
  if (input.automatic_enabled && !intervals.some(interval => interval.enabled)) throw new CommunicationInputError("Enable an approved interval first.");
  if (insurance === "certificate_of_insurance" && (input.automatic_enabled || intervals.some(interval => interval.enabled))) throw new CommunicationInputError("Retired COI cannot enable automatic notices.");
  return {
    compliance_type_id: compliance == null ? null : Number(compliance), insurance_item_key: insurance == null ? null : String(insurance),
    automatic_enabled: input.automatic_enabled, schedule_type: input.schedule_type,
    sender_contact_id: input.sender_contact_id == null ? null : communicationId(String(input.sender_contact_id)),
    internal_contact_id: input.internal_contact_id == null ? null : communicationId(String(input.internal_contact_id)),
    revision: Number(input.revision), intervals,
  };
}
