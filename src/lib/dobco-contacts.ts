import { dobcoContactFields, type DobcoContactInput } from "@/types/dobco-contacts";

export function isContactUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function parseDobcoContact(value: unknown): DobcoContactInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Contact data must be an object.");
  }
  const fields: Record<string, unknown> = { ...value };
  if (Object.keys(fields).length !== dobcoContactFields.length
      || dobcoContactFields.some((key) => !Object.hasOwn(fields, key))
      || Object.keys(fields).some((key) => !dobcoContactFields.some((allowed) => allowed === key))) {
    throw new Error("Provide only the Dobco contact fields. IDs and account settings cannot be changed here.");
  }
  const optionalText = (key: string): string | null => {
    const text = fields[key];
    if (text !== null && typeof text !== "string") throw new Error(`${key} must be text or null.`);
    return text?.trim() || null;
  };
  const boolean = (key: string): boolean => {
    const checked = fields[key];
    if (typeof checked !== "boolean") throw new Error(`${key} must be true or false.`);
    return checked;
  };
  const name = optionalText("contact_name");
  if (!name) throw new Error("Contact Name is required.");
  const email = optionalText("email");
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address or leave it blank.");
  const userProfileId = optionalText("user_profile_id");
  if (userProfileId && !isContactUuid(userProfileId)) throw new Error("Choose an existing optional SubTracker user.");
  const date = optionalText("sms_consent_date");
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date)
      || date < "0001-01-01"
      || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) {
    throw new Error("SMS Consent Date must be a valid date (YYYY-MM-DD).");
  }
  return {
    contact_name: name,
    email,
    mobile_phone: optionalText("mobile_phone"),
    is_active: boolean("is_active"),
    receives_internal_email: boolean("receives_internal_email"),
    receives_internal_sms: boolean("receives_internal_sms"),
    sms_consent_recorded: boolean("sms_consent_recorded"),
    sms_consent_date: date,
    sms_consent_source_or_note: optionalText("sms_consent_source_or_note"),
    user_profile_id: userProfileId,
  };
}

export function dobcoRecipientEligibility(contact: DobcoContactInput) {
  return {
    email: contact.is_active && Boolean(contact.email?.trim()) && contact.receives_internal_email,
    sms: contact.is_active && Boolean(contact.mobile_phone?.trim())
      && contact.receives_internal_sms && contact.sms_consent_recorded,
  };
}
