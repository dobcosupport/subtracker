import type { ActivityLog, ContractorFollowup } from "@/types/database";
import type { CommunicationSummary } from "@/types/communications";

export interface ContractorActivityOption {
  id: number;
  company_name: string;
}
export interface TimelineOffsets {
  activity: number;
  followup: number;
  communication: number;
}
export type FollowupSummary = Pick<ContractorFollowup, "id" | "contractor_id" | "followup_date" | "followup_method" | "subject" | "status" | "created_at"> & { related_item: string };
export type ContractorTimelineEntry =
  | { source: "activity"; date: string; created_at: string; record: ActivityLog }
  | { source: "followup"; date: string; created_at: string; record: FollowupSummary }
  | { source: "communication"; date: string; created_at: string; record: CommunicationSummary };
export interface ContractorTimeline {
  contractor: ContractorActivityOption;
  entries: ContractorTimelineEntry[];
  next: TimelineOffsets | null;
  sources: { activity: true; followups: boolean; communications: boolean };
}
