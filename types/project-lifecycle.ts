import type { Project } from "./database";

export interface LifecycleAssignment {
  id: number;
  contractor_id: number;
  contractor_name: string;
  contractor_trade: string | null;
  active: boolean;
  assigned_date: string;
  removed_date: string | null;
  ownership_sources: string[];
  original_sources: string[];
  ended_at: string | null;
  ended_by: string | null;
  end_reason: string | null;
  detached_designations: Record<string, { at: string; by: string; name: string }>;
}

export interface ProjectLifecycleReview {
  project: Project & { completed_at: string | null; completed_by: string | null };
  token: string;
  canManage: boolean;
  assignments: LifecycleAssignment[];
  counts: Record<string, number>;
  contacts: { id: string; contractor_id: number; contact_name: string; title_or_role: string | null; is_active: boolean }[];
  followups: { id: number; contractor_id: number; subject: string; status: string; followup_date: string }[];
  procore: { id: number; contractor_id: number; import_run_id: string; import_history_id: number; source_row: number; imported_at: string }[];
  mycoi: { id: number; raw_division_name: string; active: boolean }[];
  events: { id: number; assignment_id: number | null; action: string; actor_name: string; occurred_at: string; details: { source?: string; reason?: string } }[];
}

export type ProjectLifecycleAction =
  | { action: "complete"; token: string }
  | { action: "cancel"; token: string }
  | { action: "end"; token: string; assignment: number; reason: string }
  | { action: "detach"; token: string; assignment: number; source: "PROCORE" | "MYCOI" };
