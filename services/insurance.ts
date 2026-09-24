import { supabase } from "@/lib/supabase";
import type { InsuranceTracking, InsuranceVerificationHistory } from "@/types/database";

export async function getInsuranceTracking(contractorId: number): Promise<{
  data: InsuranceTracking | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_insurance")
    .select("*")
    .eq("contractor_id", contractorId)
    .maybeSingle();

  return {
    data: (data as InsuranceTracking | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function saveInsuranceTracking(
  contractorId: number,
  tracking: Pick<InsuranceTracking, "certificate_on_file" | "last_verified_date" | "notes">
): Promise<{
  data: InsuranceTracking | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_insurance")
    .upsert({ contractor_id: contractorId, ...tracking }, { onConflict: "contractor_id" })
    .select()
    .maybeSingle();

  if (error) {
    return { data: null, error: { message: error.message } };
  }

  const { error: historyError } = await supabase
    .from("contractor_insurance_history")
    .insert({
      contractor_id: contractorId,
      coi_on_file: tracking.certificate_on_file,
      verified_date: tracking.last_verified_date,
      notes: tracking.notes,
    });

  return {
    data: (data as InsuranceTracking | null) ?? null,
    error: historyError ? { message: historyError.message } : null,
  };
}

export async function getInsuranceVerificationHistory(contractorId: number): Promise<{
  data: InsuranceVerificationHistory[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_insurance_history")
    .select("id, contractor_id, coi_on_file, verified_date, notes, created_at")
    .eq("contractor_id", contractorId)
    .order("created_at", { ascending: false });

  return {
    data: (data as InsuranceVerificationHistory[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}