import { supabase } from "@/lib/supabase";
import type { Contractor, ContractorInput } from "@/types/database";

export async function getContractors(): Promise<{
  data: Contractor[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.from("contractors").select("*");

  return {
    data: (data as Contractor[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getContractorById(id: number): Promise<{
  data: Contractor | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  return {
    data: (data as Contractor | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createContractor(
  contractor: ContractorInput
): Promise<{
  data: Contractor[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.from("contractors").insert({
    ...contractor,
    address_1: contractor.address_1 ?? null,
    address_2: contractor.address_2 ?? null,
    city: contractor.city ?? null,
    state: contractor.state ?? null,
    zip_code: contractor.zip_code ?? null,
    county: contractor.county ?? null,
    nj_pwc_number: contractor.nj_pwc_number ?? null,
    nj_brc_number: contractor.nj_brc_number ?? null,
    ny_pwc_number: contractor.ny_pwc_number ?? null,
    ny_brc_number: contractor.ny_brc_number ?? null,
    sage_erp_id: contractor.sage_erp_id ?? null,
    brc_name_control: contractor.brc_name_control ?? null,
    brc_name_control_is_manual: contractor.brc_name_control_is_manual ?? false,
    material_vendor_only: contractor.material_vendor_only ?? false,
  }).select();

  return {
    data: (data as Contractor[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function updateContractor(
  id: number,
  updates: Partial<Contractor>
): Promise<{
  data: Contractor[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractors")
    .update(updates)
    .eq("id", id);

  return {
    data: (data as Contractor[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}
