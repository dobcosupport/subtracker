export interface NjBrcWorkerLease {
  instance_id: string;
  expires_at: string;
}

export interface NjBrcOrphanCandidate {
  id: string;
  contractor_id: number;
  company_name: string;
  status: "claimed" | "processing" | "human_verification_required";
  worker_instance_id: string | null;
  claimed_at: string | null;
  created_at: string;
}

export function orphanAgeThresholdMinutes(value: string | undefined): number {
  if (value === undefined || value === "") return 10;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error("NJ_BRC_ORPHANED_REQUEST_AGE_MINUTES must be a positive integer.");
  }
  const minutes = Number(value);
  if (!Number.isSafeInteger(minutes) || minutes > 1440) {
    throw new Error("NJ_BRC_ORPHANED_REQUEST_AGE_MINUTES must be between 1 and 1440.");
  }
  return minutes;
}

export function isOrphanedNjBrcRequest(
  request: NjBrcOrphanCandidate,
  lease: NjBrcWorkerLease | null,
  ageThresholdMinutes: number,
  now = Date.now(),
): boolean {
  if (!["claimed", "processing", "human_verification_required"].includes(request.status)) return false;
  if (!request.worker_instance_id) return false;
  if (request.worker_instance_id === lease?.instance_id && Date.parse(lease.expires_at) > now) return false;
  if (!request.claimed_at || !Number.isFinite(Date.parse(request.claimed_at))) return false;
  if (!Number.isInteger(ageThresholdMinutes) || ageThresholdMinutes < 1 || ageThresholdMinutes > 1440) return false;
  const age = now - Date.parse(request.claimed_at);
  return age >= ageThresholdMinutes * 60_000;
}
