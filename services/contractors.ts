import { supabase } from "@/lib/supabase";
import type { Contractor } from "@/types/database";

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
  contractor: Omit<Contractor, "id" | "created_at" | "updated_at">
): Promise<{
  data: Contractor[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.from("contractors").insert(contractor);

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
