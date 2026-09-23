import { supabase } from "@/lib/supabase";
import type { Project } from "@/types/database";

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
