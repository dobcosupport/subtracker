import { supabase } from "@/lib/supabase";
import type { ProjectLifecycleAction, ProjectLifecycleReview } from "@/types/project-lifecycle";

export async function loadProjectLifecycle(id: number, action?: ProjectLifecycleAction): Promise<ProjectLifecycleReview> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  if (!data.session) throw new Error("Sign in to review project lifecycle.");
  const response = await fetch(`/api/projects/${id}/lifecycle`, {
    method: action ? "POST" : "GET",
    headers: { Authorization: `Bearer ${data.session.access_token}`, ...(action ? { "Content-Type": "application/json" } : {}) },
    cache: "no-store",
    ...(action ? { body: JSON.stringify(action) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Unable to load project lifecycle.");
  return result;
}
