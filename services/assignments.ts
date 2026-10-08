import { supabase } from "@/lib/supabase";
import type { Assignment, ContractorProject } from "@/types/database";

const assignmentSelect =
  "id, contractor_id, project_id, assigned_date, removed_date, active, created_at, contractors(company_name), projects(project_number, project_name, status, inactivated_by, inactivated_at)";

// Sort assignments by project number in ascending numeric order.
// Numeric collation makes "24-101" sort after "24-015" (natural sort).
export function sortAssignmentsByProjectNumber(assignments: Assignment[]): Assignment[] {
  return [...assignments].sort((left, right) =>
    (left.projects?.project_number ?? "").localeCompare(right.projects?.project_number ?? "", undefined, { numeric: true, sensitivity: "base" })
  );
}

type AssignmentInput = Omit<ContractorProject, "id" | "created_at" | "removed_date"> & {
  removed_date?: string | null;
};

export async function getAssignments(): Promise<{
  data: Assignment[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_projects")
    .select(assignmentSelect)
    .eq("active", true)
    .order("assigned_date", { ascending: false });

  return {
    data: (data as Assignment[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createAssignment(
  assignment: AssignmentInput
): Promise<{
  data: ContractorProject[] | null;
  error: { message: string } | null;
}> {
  const { data: existing, error: duplicateCheckError } = await supabase
    .from("contractor_projects")
    .select("id")
    .eq("contractor_id", assignment.contractor_id)
    .eq("project_id", assignment.project_id)
    .eq("active", true)
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
    .select(assignmentSelect)
    .eq("contractor_id", contractorId)
    .eq("active", true)
    .order("assigned_date", { ascending: false });

  return {
    data: sortAssignmentsByProjectNumber((data as Assignment[] | null) ?? []),
    error: error ? { message: error.message } : null,
  };
}

export async function getAssignmentsForContractors(contractorIds: number[]): Promise<{
  data: Assignment[] | null;
  error: { message: string } | null;
}> {
  const ids = [...new Set(contractorIds)];
  const assignments: Assignment[] = [];
  for (let start = 0; start < ids.length; start += 100) {
    const batch = ids.slice(start, start + 100);
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await supabase
        .from("contractor_projects")
        .select(assignmentSelect)
        .in("contractor_id", batch)
        .eq("active", true)
        .order("id")
        .range(offset, offset + 999)
        .returns<Assignment[]>();
      if (error) return { data: null, error: { message: error.message } };
      const rows = data ?? [];
      assignments.push(...rows);
      if (rows.length < 1000) break;
    }
  }
  return { data: sortAssignmentsByProjectNumber(assignments), error: null };
}

export async function getAssignmentHistoryForContractor(contractorId: number): Promise<{
  data: Assignment[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_projects")
    .select(assignmentSelect)
    .eq("contractor_id", contractorId)
    .order("assigned_date", { ascending: false });

  return {
    data: sortAssignmentsByProjectNumber((data as Assignment[] | null) ?? []),
    error: error ? { message: error.message } : null,
  };
}

export async function deactivateAssignment(id: number): Promise<{
  error: { message: string } | null;
}> {
  const { error } = await supabase
    .from("contractor_projects")
    .update({ active: false, removed_date: new Date().toISOString().slice(0, 10) })
    .eq("id", id)
    .eq("active", true);

  return { error: error ? { message: error.message } : null };
}