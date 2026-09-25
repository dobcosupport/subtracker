import { supabase } from "@/lib/supabase";
import type { ContractorFollowup, FollowupMethod, FollowupStatus } from "@/types/database";

export async function getFollowupsForContractor(contractorId: number): Promise<{
  data: ContractorFollowup[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_followups")
    .select("*")
    .eq("contractor_id", contractorId)
    .order("followup_date", { ascending: false })
    .order("created_at", { ascending: false });

  return {
    data: (data as ContractorFollowup[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createFollowup(
  followup: Omit<ContractorFollowup, "id" | "created_at" | "updated_at">
): Promise<{
  data: ContractorFollowup[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_followups")
    .insert(followup)
    .select();

  return {
    data: (data as ContractorFollowup[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function updateFollowup(
  id: number,
  updates: Pick<ContractorFollowup, "followup_date" | "followup_method" | "compliance_record_id" | "subject" | "notes" | "status">
): Promise<{
  data: ContractorFollowup[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_followups")
    .update(updates)
    .eq("id", id)
    .select();

  return {
    data: (data as ContractorFollowup[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export const followupMethods: FollowupMethod[] = ["Email", "Phone", "Meeting", "Text", "Other"];
export const followupStatuses: FollowupStatus[] = ["Open", "Waiting Response", "Resolved", "Closed"];