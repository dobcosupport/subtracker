import { supabase } from "@/lib/supabase";
import type { ContractorContact, ContractorContactInput } from "@/types/database";

function normalizeContact(input: ContractorContactInput): ContractorContactInput {
  return {
    ...input,
    contact_name: input.contact_name.trim(),
    title_or_role: input.title_or_role?.trim() || null,
    email: input.email?.trim() || null,
    mobile_phone: input.mobile_phone?.trim() || null,
    sms_consent_source_or_note: input.sms_consent_source_or_note?.trim() || null,
    is_primary_contact: input.is_active && input.is_primary_contact,
  };
}

export async function getContractorContacts(contractorId: number): Promise<{
  data: ContractorContact[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_contacts")
    .select("*")
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
    p_values: normalizeContact(input),
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
    p_values: normalizeContact(input),
  });

  if (error) return { data: null, error: { message: error.message } };
  if (!data) return { data: null, error: { message: "Unable to save contact." } };
  return { data: data as ContractorContact, error: null };
}
