import { supabase } from "@/lib/supabase";
import type { Assignment, ContractorProject } from "@/types/database";

export async function getAssignments(): Promise<{
  data: Assignment[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_projects")
    .select(
      "id, contractor_id, project_id, assigned_date, active, created_at, contractors(company_name), projects(project_number, project_name, status)"
    )
    .order("assigned_date", { ascending: false });

  return {
    data: (data as Assignment[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createAssignment(
  assignment: Omit<ContractorProject, "id" | "created_at">
): Promise<{
  data: ContractorProject[] | null;
  error: { message: string } | null;
}> {
  const { data: existing, error: duplicateCheckError } = await supabase
    .from("contractor_projects")
    .select("id")
    .eq("contractor_id", assignment.contractor_id)
    .eq("project_id", assignment.project_id)
    .maybeSingle();

  if (duplicateCheckError) {
    return { data: null, error: { message: duplicateCheckError.message } };
  }

  if (existing) {
    return {
      data: null,
      error: { message: "This contractor is already assigned to the project." },
    };
  }

  const { data, error } = await supabase
    .from("contractor_projects")
    .insert(assignment);

  return {
    data: (data as ContractorProject[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getAssignmentsForContractor(contractorId: number): Promise<{
  data: Assignment[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_projects")
    .select(
      "id, contractor_id, project_id, assigned_date, active, created_at, contractors(company_name), projects(project_number, project_name, status)"
    )
    .eq("contractor_id", contractorId)
    .order("assigned_date", { ascending: false });

  return {
    data: (data as Assignment[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function deactivateAssignment(id: number): Promise<{
  error: { message: string } | null;
}> {
  const { error } = await supabase
    .from("contractor_projects")
    .update({ active: false })
    .eq("id", id);

  return { error: error ? { message: error.message } : null };
}