import { supabase } from "@/lib/supabase";
import { readJson } from "@/lib/communication-compose-client";
import type { FollowupEmailOrigin } from "@/lib/followup-email";
import type { ContractorFollowup, FollowupMethod, FollowupStatus } from "@/types/database";

export type DashboardFollowup = Pick<ContractorFollowup,
  "id" | "contractor_id" | "followup_date" | "subject" | "notes" | "status" | "created_at" | "email_origin"
> & { contractor: { company_name: string } };

async function withEmailOrigins<T extends { id: number }>(rows: T[]) {
  try {
    const enriched: (T & { email_origin: FollowupEmailOrigin | null })[] = [];
    for (let start = 0; start < rows.length; start += 200) {
      const batch = rows.slice(start, start + 200);
      const { origins } = await readJson<{ origins: Record<number, FollowupEmailOrigin | null> }>(
        `/api/followups/email-origins?${new URLSearchParams({ ids: batch.map(row => row.id).join(",") })}`);
      if (!origins || batch.some(row => !Object.hasOwn(origins, row.id))) throw new Error("Follow-Up Email Sent could not be verified. Refresh to reload.");
      enriched.push(...batch.map(row => ({ ...row, email_origin: origins[row.id] })));
    }
    return { data: enriched, error: null };
  } catch (error) {
    return { data: null, error: { message: error instanceof Error ? error.message : "Unable to load Follow-Up Email Sent." } };
  }
}

export async function getOpenFollowups(): Promise<{
  data: DashboardFollowup[] | null;
  error: { message: string } | null;
}> {
  const followups: DashboardFollowup[] = [];
  for (let start = 0; ; start += 500) {
    const { data, error } = await supabase
      .from("contractor_followups")
      .select("id,contractor_id,followup_date,subject,notes,status,created_at,contractor:contractors!inner(company_name)")
      .in("status", ["Open", "Waiting Response"])
      .order("followup_date", { ascending: true, nullsFirst: false })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(start, start + 499)
      .returns<DashboardFollowup[]>();
    if (error) return { data: null, error: { message: error.message } };
    if (!data) return { data: null, error: { message: "Unable to load open follow-ups." } };
    followups.push(...data);
    if (data.length < 500) return withEmailOrigins(followups);
  }
}

export async function getFollowups(): Promise<{
  data: ContractorFollowup[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_followups")
    .select("*, related_type:compliance_types(compliance_name)")
    .order("followup_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (error || !data) return { data: null, error: { message: error?.message ?? "Unable to load follow-ups." } };
  return withEmailOrigins(data as ContractorFollowup[]);
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

  if (error || !data) return { data: null, error: { message: error?.message ?? "Unable to load contractor follow-ups." } };
  return withEmailOrigins(data as ContractorFollowup[]);
}

export async function createFollowup(
  followup: Omit<ContractorFollowup, "id" | "created_at" | "updated_at" | "related_type" | "email_origin">
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