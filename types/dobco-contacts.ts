export interface DobcoContact {
  id: string;
  contact_name: string;
  email: string | null;
  mobile_phone: string | null;
  is_active: boolean;
  receives_internal_email: boolean;
  receives_internal_sms: boolean;
  sms_consent_recorded: boolean;
  sms_consent_date: string | null;
  sms_consent_source_or_note: string | null;
  user_profile_id: string | null;
  created_at: string;
  updated_at: string;
}

export type DobcoContactInput = Omit<DobcoContact, "id" | "created_at" | "updated_at">;
export type DobcoUserOption = { auth_user_id: string; name: string; email: string };

export const dobcoContactFields = [
  "contact_name", "email", "mobile_phone", "is_active",
  "receives_internal_email", "receives_internal_sms", "sms_consent_recorded",
  "sms_consent_date", "sms_consent_source_or_note", "user_profile_id",
] as const;

export const dobcoContactColumns = "id,contact_name,email,mobile_phone,is_active,receives_internal_email,receives_internal_sms,sms_consent_recorded,sms_consent_date,sms_consent_source_or_note,user_profile_id,created_at,updated_at";
