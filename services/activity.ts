import { supabase } from "@/lib/supabase";
import type { ActivityLog } from "@/types/database";

export async function getActivityForContractor(contractorId: number): Promise<{
  data: ActivityLog[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("contractor_id", contractorId)
    .order("activity_date", { ascending: false })
    .limit(10);

  return {
    data: (data as ActivityLog[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}