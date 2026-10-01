import { supabase } from "@/lib/supabase";
import type { Project } from "@/types/database";
import type { ProjectAssignment } from "@/types/database";

export async function getProjects(): Promise<{
  data: Project[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.from("projects").select("*");

  return {
    data: (data as Project[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getProjectById(id: number): Promise<{
  data: Project | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  return {
    data: (data as Project | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function createProject(
  project: Omit<Project, "id" | "created_at" | "updated_at">
): Promise<{
  data: Project[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase.from("projects").insert(project);

  return {
    data: (data as Project[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function updateProject(
  id: number,
  updates: Partial<Pick<Project, "project_number" | "project_name" | "status">>
): Promise<{
  data: Project[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("projects")
    .update(updates)
    .eq("id", id);

  return {
    data: (data as Project[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export interface ProjectAssignmentHistoryEntry {
  id: number;
  contractor_id: number;
  project_id: number;
  assigned_date: string;
  removed_date: string | null;
  active: boolean;
  contractors: {
    company_name: string;
    trade: string | null;
    active: boolean;
  } | null;
}

export interface ProjectDocument {
  id: number;
  contractor_id: number;
  document_name: string;
  document_type: string;
  upload_date: string;
  contractors: { company_name: string } | null;
}

export async function getAssignmentHistoryForProject(projectId: number): Promise<{
  data: ProjectAssignmentHistoryEntry[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_projects")
    .select("id, contractor_id, project_id, assigned_date, removed_date, active, contractors(company_name, trade, active)")
    .eq("project_id", projectId)
    .order("assigned_date", { ascending: false });

  return {
    data: (data as ProjectAssignmentHistoryEntry[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getDocumentsForProject(contractorIds: number[]): Promise<{
  data: ProjectDocument[] | null;
  error: { message: string } | null;
}> {
  if (contractorIds.length === 0) {
    return { data: [], error: null };
  }

  const { data, error } = await supabase
    .from("documents")
    .select("id, contractor_id, document_name, document_type, upload_date, contractors(company_name)")
    .in("contractor_id", contractorIds)
    .order("upload_date", { ascending: false });

  return {
    data: (data as unknown as ProjectDocument[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}

export async function getAssignmentsForProject(projectId: number): Promise<{
  data: ProjectAssignment[] | null;
  error: { message: string } | null;
}> {
  const { data, error } = await supabase
    .from("contractor_projects")
    .select("contractors(company_name, trade, active)")
    .eq("project_id", projectId);

  return {
    data: (data as ProjectAssignment[] | null) ?? null,
    error: error ? { message: error.message } : null,
  };
}
