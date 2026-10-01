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
    .order("created_at", { ascending: false })
    .limit(10);

  return {
    data: (data as ActivityLog[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getActivityForProject(projectId: number): Promise<{
  data: ActivityLog[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("activity_log")
    .select("*")
    .eq("project_id", projectId)
    .order("activity_date", { ascending: false })
    .order("created_at", { ascending: false });

  return {
    data: (data as ActivityLog[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function logProjectStatusChange(
  projectId: number,
  projectName: string,
  previousStatus: string,
  newStatus: string
): Promise<{
  error: { message: string } | null;
}> {
  const { data: userData } = await supabase.auth.getUser();
  const changedBy = userData.user?.email ?? "Unknown user";

  const { error } = await supabase.from("activity_log").insert({
    contractor_id: null,
    project_id: projectId,
    activity_date: new Date().toISOString().slice(0, 10),
    activity_type: "Status Change",
    notes: `${projectName} | Previous: ${previousStatus} | New: ${newStatus} | Changed by: ${changedBy}`,
    follow_up_date: null,
    created_by: changedBy,
  });

  return { error: error ? { message: error.message } : null };
}

export async function logProjectEvent(
  projectId: number,
  eventType: string,
  notes: string
): Promise<{
  error: { message: string } | null;
}> {
  const { data: userData } = await supabase.auth.getUser();
  const changedBy = userData.user?.email ?? "Unknown user";

  const { error } = await supabase.from("activity_log").insert({
    contractor_id: null,
    project_id: projectId,
    activity_date: new Date().toISOString().slice(0, 10),
    activity_type: eventType,
    notes,
    follow_up_date: null,
    created_by: changedBy,
  });

  return { error: error ? { message: error.message } : null };
}

export async function logContractorStatusChange(
  contractorId: number,
  companyName: string,
  previousStatus: "Active" | "Inactive",
  newStatus: "Active" | "Inactive"
): Promise<{
  error: { message: string } | null;
}> {
  const { data: userData } = await supabase.auth.getUser();
  const changedBy = userData.user?.email ?? "Unknown user";

  const { error } = await supabase.from("activity_log").insert({
    contractor_id: contractorId,
    project_id: null,
    activity_date: new Date().toISOString().slice(0, 10),
    activity_type: "Status Change",
    notes: `${companyName} status changed from ${previousStatus} to ${newStatus}.`,
    follow_up_date: null,
    created_by: changedBy,
  });

  return { error: error ? { message: error.message } : null };
}