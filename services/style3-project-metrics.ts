import { supabase } from "@/lib/supabase";

export type ProjectWorkType = "Public Works" | "Non-Public Works" | "Unspecified";

export interface ActiveProjectMetricRow {
  id: number;
  status: string;
  public_works: boolean | null;
}

export interface ProjectWorkTypeCount {
  type: ProjectWorkType;
  count: number;
}

export function countActiveProjectsByWorkType(projects: ActiveProjectMetricRow[]): ProjectWorkTypeCount[] {
  const counts: Record<ProjectWorkType, number> = {
    "Public Works": 0,
    "Non-Public Works": 0,
    Unspecified: 0,
  };
  for (const project of projects) {
    if (project.status !== "Active") continue;
    const type = project.public_works === true ? "Public Works"
      : project.public_works === false ? "Non-Public Works" : "Unspecified";
    counts[type]++;
  }
  return (Object.keys(counts) as ProjectWorkType[]).map((type) => ({ type, count: counts[type] }));
}

export async function getActiveProjectWorkTypes(): Promise<{
  data: ProjectWorkTypeCount[] | null;
  error: { message: string } | null;
}> {
  const projects: ActiveProjectMetricRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from("projects")
      .select("id,status,public_works")
      .eq("status", "Active")
      .order("id")
      .range(offset, offset + 499)
      .returns<ActiveProjectMetricRow[]>();
    if (error) return { data: null, error: { message: `Unable to load active projects: ${error.message}` } };
    if (!data) return { data: null, error: { message: "Unable to load active projects." } };
    projects.push(...data);
    if (data.length < 500) return { data: countActiveProjectsByWorkType(projects), error: null };
  }
}
