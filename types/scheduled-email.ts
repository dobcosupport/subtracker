export type ScheduledEmailStatus = {
  available: boolean;
  execution_enabled: boolean;
  automatic_delivery_enabled: boolean;
  notice: string;
};
export type ScheduledEmailPolicy = {
  enabled: boolean;
  batch_size: number;
  retry_policy: "none" | "pre_dispatch_only";
  retry_delay_seconds: number;
  maximum_attempts: number;
  stale_claim_seconds: number;
  last_polled_at: string | null;
  revision: number;
};
