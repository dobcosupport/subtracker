import { supabase } from "@/lib/supabase";
import { adminFetch } from "@/lib/admin-client";
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
  contractor: ContractorInput,
  options: { njPwcMatchNumber?: string | null } = {}
): Promise<{
  data: Contractor[] | null;
  error: { message: string } | null;
}> {
  // Created through the server route so duplicate protection (NJ PWC number
  // first, then normalized company name) is enforced before insert.
  try {
    const response = await adminFetch("/api/contractors", {
      method: "POST",
      body: JSON.stringify({ contractor, nj_pwc_match_number: options.njPwcMatchNumber ?? null }),
    });
    const body = await response.json().catch(() => ({})) as { data?: Contractor[]; error?: string };
    if (!response.ok) {
      return { data: null, error: { message: body.error ?? "Unable to save contractor." } };
    }
    return { data: body.data ?? null, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : "Unable to save contractor." } };
  }
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
