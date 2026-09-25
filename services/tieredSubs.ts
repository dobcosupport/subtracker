import { supabase } from "@/lib/supabase";
import type { Contractor, TieredSubRecord } from "@/types/database";

const tieredSubSelect =
  "id, contractor_id, tiered_sub_contractor_id, active, assigned_date, removed_date, created_at, updated_at, tiered_sub_contractor:contractors!fk_contractor_tiered_subs_tiered_sub_contractor(company_name)";

export async function getTieredSubsForContractor(contractorId: number): Promise<{
  data: TieredSubRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_tiered_subs")
    .select(tieredSubSelect)
    .eq("contractor_id", contractorId)
    .eq("active", true)
    .order("assigned_date", { ascending: false });

  return {
    data: (data as unknown as TieredSubRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getTieredSubHistoryForContractor(contractorId: number): Promise<{
  data: TieredSubRecord[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_tiered_subs")
    .select(tieredSubSelect)
    .eq("contractor_id", contractorId)
    .order("assigned_date", { ascending: false });

  return {
    data: (data as unknown as TieredSubRecord[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getAvailableTieredSubContractors(contractorId: number): Promise<{
  data: Contractor[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractors")
    .select("*")
    .eq("active", true)
    .neq("id", contractorId)
    .order("company_name", { ascending: true });

  return {
    data: (data as Contractor[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function reactivateTieredSub(relationshipId: number): Promise<{
  error: { message: string } | null;
}> {
  const { error } = await supabase
    .from("contractor_tiered_subs")
    .update({ active: true, assigned_date: new Date().toISOString().slice(0, 10), removed_date: null })
    .eq("id", relationshipId)
    .eq("active", false);

  return { error: error ? { message: error.message } : null };
}

export async function assignTieredSub(
  contractorId: number,
  tieredSubContractorId: number
): Promise<{
  error: { message: string } | null;
}> {
  if (contractorId === tieredSubContractorId) {
    return { error: { message: "A contractor cannot be linked to itself." } };
  }

  const { data: existing, error: lookupError } = await supabase
    .from("contractor_tiered_subs")
    .select("id, active")
    .eq("contractor_id", contractorId)
    .eq("tiered_sub_contractor_id", tieredSubContractorId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    return { error: { message: lookupError.message } };
  }

  if (existing?.active) {
    return { error: { message: "This company is already assigned as a Tiered Sub." } };
  }

  if (existing) {
    return reactivateTieredSub(existing.id);
  }

  const { error: insertError } = await supabase
    .from("contractor_tiered_subs")
    .insert({ contractor_id: contractorId, tiered_sub_contractor_id: tieredSubContractorId, active: true });

  return { error: insertError ? { message: insertError.message } : null };
}

export async function deactivateTieredSub(relationshipId: number): Promise<{
  error: { message: string } | null;
}> {
  const { error } = await supabase
    .from("contractor_tiered_subs")
    .update({ active: false, removed_date: new Date().toISOString().slice(0, 10) })
    .eq("id", relationshipId)
    .eq("active", true);

  return { error: error ? { message: error.message } : null };
}
