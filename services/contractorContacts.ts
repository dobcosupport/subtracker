import { supabase } from "@/lib/supabase";
import type { ContractorContact, ContractorContactInput } from "@/types/database";

function normalizeContact(input: ContractorContactInput): ContractorContactInput {
  return {
    contact_name: input.contact_name.trim(),
    title_or_role: input.title_or_role?.trim() || null,
    email: input.email?.trim() || null,
    mobile_phone: input.mobile_phone?.trim() || null,
    ...(input.business_phone !== undefined ? { business_phone: input.business_phone?.trim() || null } : {}),
    is_primary_contact: input.is_active && input.is_primary_contact,
    is_compliance_contact: input.is_compliance_contact,
    receives_compliance_email: input.receives_compliance_email,
    is_active: input.is_active,
  };
}

// The installed RPC requires these keys until its separate database cleanup.
const legacyRpcDefaults = {
  receives_compliance_sms: false,
  sms_consent_recorded: false,
  sms_consent_date: null,
  sms_consent_source_or_note: null,
};

const contactColumns = "id,contractor_id,contact_name,title_or_role,email,mobile_phone,business_phone,is_primary_contact,is_compliance_contact,receives_compliance_email,is_active,created_at,updated_at";

export type ContractorPrimaryContact = Pick<ContractorContact,
  "contractor_id" | "contact_name" | "email" | "business_phone" | "mobile_phone">;

export async function getPrimaryContactsForContractors(contractorIds: number[]): Promise<{
  data: Map<number, ContractorPrimaryContact> | null;
  error: { message: string } | null;
}> {
  const ids = [...new Set(contractorIds)];
  const contacts = new Map<number, ContractorPrimaryContact>();
  for (let start = 0; start < ids.length; start += 100) {
    const { data, error } = await supabase.from("contractor_contacts")
      .select("contractor_id,contact_name,email,business_phone,mobile_phone")
      .in("contractor_id", ids.slice(start, start + 100))
      .eq("is_active", true)
      .eq("is_primary_contact", true)
      .order("contractor_id");
    if (error) return { data: null, error: { message: error.message } };
    if (!data) return { data: null, error: { message: "Unable to load primary contacts." } };
    for (const contact of data as ContractorPrimaryContact[]) contacts.set(contact.contractor_id, contact);
  }
  return { data: contacts, error: null };
}

export async function getContractorContacts(contractorId: number): Promise<{
  data: ContractorContact[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_contacts")
    .select(contactColumns)
    .eq("contractor_id", contractorId)
    .order("is_active", { ascending: false })
    .order("contact_name", { ascending: true });

  return {
    data: (data as ContractorContact[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createContractorContact(contractorId: number, input: ContractorContactInput): Promise<{
  data: ContractorContact | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.rpc("save_contractor_contact", {
    p_contractor_id: contractorId,
    p_contact_id: null,
    p_values: { ...normalizeContact(input), ...legacyRpcDefaults },
  });

  if (error) return { data: null, error: { message: error.message } };
  if (!data) return { data: null, error: { message: "Unable to save contact." } };
  return { data: data as ContractorContact, error: null };
}

export async function updateContractorContact(
  contractorId: number,
  contactId: string,
  input: ContractorContactInput
): Promise<{
  data: ContractorContact | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.rpc("save_contractor_contact", {
    p_contractor_id: contractorId,
    p_contact_id: contactId,
    p_values: { ...normalizeContact(input), ...legacyRpcDefaults },
  });

  if (error) return { data: null, error: { message: error.message } };
  if (!data) return { data: null, error: { message: "Unable to save contact." } };
  return { data: data as ContractorContact, error: null };
}
