-- =====================================================================
-- NJ BRC RPA — Test Mode + review decision fields (Phase 1)
-- Date: 2026-10-02
--
-- Non-destructive: ADD COLUMN IF NOT EXISTS only.
--
-- =====================================================================
-- COMPLIANCE LOGIC LOCK
-- =====================================================================
-- Active Compliance Records remain the sole authoritative source for
-- dashboard counts, 90/60/30 Day, Expired, Missing Information,
-- contractor status, reports, and reminders. Nothing below writes to or
-- affects Active Compliance Records. Approving a review item stores the
-- decision only; it does not copy values into Active Compliance Records.
-- =====================================================================

BEGIN;

-- Per-type Test Mode flag: when true, only a single selected contractor
-- is processed and all generated records are labeled Testing Only.
ALTER TABLE public.compliance_sync_settings
    ADD COLUMN IF NOT EXISTS test_mode BOOLEAN NOT NULL DEFAULT FALSE;

-- Mark sync runs created during Test Mode
ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Review decision detail (reject reason + explicit approve/reject actors)
ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Label exceptions generated during Test Mode
ALTER TABLE public.compliance_sync_exceptions
    ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
