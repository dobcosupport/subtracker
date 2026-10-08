import { supabase } from "@/lib/supabase";
import type { ContractorFollowup, FollowupMethod, FollowupStatus } from "@/types/database";

export async function getFollowups(): Promise<{
  data: ContractorFollowup[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_followups")
    .select("*, related_type:compliance_types(compliance_name)")
    .order("followup_date", { ascending: false })
    .order("created_at", { ascending: false });

  return {
    data: (data as ContractorFollowup[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getFollowupsForContractor(contractorId: number): Promise<{
  data: ContractorFollowup[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_followups")
    .select("*, related_type:compliance_types(compliance_name)")
    .eq("contractor_id", contractorId)
    .order("followup_date", { ascending: false })
    .order("created_at", { ascending: false });

  return {
    data: (data as ContractorFollowup[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createFollowup(
  followup: Omit<ContractorFollowup, "id" | "created_at" | "updated_at" | "related_type">
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
  updates: Pick<ContractorFollowup, "followup_date" | "followup_method" | "compliance_record_id" | "compliance_type_id" | "insurance_item_key" | "subject" | "notes" | "status">
): Promise<{
  data: ContractorFollowup[] | null;
  error: { message: string } | null;
}> {
  const { data, error, count } = await supabase
    .from("contractor_followups")
    .update(updates, { count: "exact" })
    .eq("id", id)
    .select();

  if (!error && count === 0) {
    return { data: null, error: { message: "Follow-up was not updated. It may no longer exist or you may not have permission to edit it." } };
  }

  return {
    data: (data as ContractorFollowup[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export const followupMethods: FollowupMethod[] = ["Email", "Phone", "Meeting", "Text", "Other"];
export const followupStatuses: FollowupStatus[] = ["Open", "Waiting Response", "Resolved", "Closed"];