-- =====================================================================
-- NJ PWC Schema Alignment
-- Date: 2026-10-06
--
-- Purpose: bring NEW environments into alignment with the validated
-- NJ PWC workflow. Every column the validated SubTracker code reads or
-- writes on compliance_sync_runs and compliance_sync_review_queue is
-- (re)asserted here so a fresh database — or one where earlier
-- migrations were skipped, reordered, or partially applied — converges
-- on the validated schema.
--
-- 100% IDEMPOTENT & NON-DESTRUCTIVE:
--   * ALTER TABLE ... ADD COLUMN IF NOT EXISTS only
--   * No data changes. No deletes. No updates. No drops.
--   * Safe to run multiple times and on already-aligned environments.
--
-- Column inventory source: validated code paths
--   src/app/api/integrations/compliance-sync/runs/route.ts
--   src/app/api/integrations/compliance-sync/runs/[id]/complete/route.ts
--   src/app/api/integrations/compliance-sync/results/route.ts
--   src/app/api/contractors/nj-pwc-import/route.ts
-- =====================================================================
-- COMPLIANCE LOGIC LOCK
-- =====================================================================
-- These tables support the Compliance Sync / RPA pipeline ONLY. Nothing
-- here writes to or affects Active Compliance Records, dashboard counts,
-- Missing Information, 90/60/30 Day, Expired, contractor status,
-- reports, or reminders. Active Compliance Records remain the sole
-- authoritative source. Approving a review entry records a decision
-- only; auto write-through stays disabled.
-- =====================================================================

BEGIN;

-- =====================================================================
-- compliance_sync_runs
-- =====================================================================
-- Base columns (from 20261002_compliance_sync_admin.sql) re-asserted so
-- the table is complete even if that migration was not applied.
-- NOTE: if the table itself does not exist yet, run
-- 20261002_compliance_sync_admin.sql first; this migration only aligns
-- columns on an existing table.
-- ---------------------------------------------------------------------

-- Base columns
ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS sync_source VARCHAR(10) NOT NULL DEFAULT 'Manual',
    ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'completed',
    ADD COLUMN IF NOT EXISTS records_checked INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS changes_detected INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS records_approved INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS records_rejected INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failures INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS triggered_by VARCHAR(200),
    ADD COLUMN IF NOT EXISTS notes TEXT;

-- RPA run lifecycle columns (from 20261002_compliance_sync_rpa.sql)
ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS run_status VARCHAR(30),
    ADD COLUMN IF NOT EXISTS records_failed INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(200),
    ADD COLUMN IF NOT EXISTS bot_version VARCHAR(50),
    ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Test Mode label (from 20261002_nj_brc_test_mode.sql)
ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Indexes + constraints (idempotent)
CREATE INDEX IF NOT EXISTS idx_compliance_sync_runs_run_at
    ON public.compliance_sync_runs (run_at DESC);

ALTER TABLE public.compliance_sync_runs DROP CONSTRAINT IF EXISTS chk_compliance_sync_runs_run_status;
ALTER TABLE public.compliance_sync_runs ADD CONSTRAINT chk_compliance_sync_runs_run_status
    CHECK (run_status IS NULL OR run_status IN ('Running', 'Completed', 'Completed With Errors', 'Failed'));

-- =====================================================================
-- compliance_sync_review_queue
-- =====================================================================
-- Base columns re-asserted, then every RPA / NJ BRC / NJ PWC column the
-- validated results + import routes insert or read.
-- ---------------------------------------------------------------------

-- Base columns (from 20261002_compliance_sync_admin.sql)
ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS sync_run_id INTEGER,
    ADD COLUMN IF NOT EXISTS compliance_record_id INTEGER,
    ADD COLUMN IF NOT EXISTS proposed_registration_number VARCHAR(200),
    ADD COLUMN IF NOT EXISTS proposed_status VARCHAR(100),
    ADD COLUMN IF NOT EXISTS proposed_expiration_date DATE,
    ADD COLUMN IF NOT EXISTS current_registration_number VARCHAR(200),
    ADD COLUMN IF NOT EXISTS current_expiration_date DATE,
    ADD COLUMN IF NOT EXISTS reviewed_by VARCHAR(200),
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_notes TEXT;

-- RPA result + idempotency + approval lock (from 20261002_compliance_sync_rpa.sql)
ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS result_key VARCHAR(300),
    ADD COLUMN IF NOT EXISTS searched_registration_number VARCHAR(200),
    ADD COLUMN IF NOT EXISTS matched_registration_number VARCHAR(200),
    ADD COLUMN IF NOT EXISTS matched_company_name VARCHAR(200),
    ADD COLUMN IF NOT EXISTS synced_effective_date DATE,
    ADD COLUMN IF NOT EXISTS last_verified TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS source_url TEXT,
    ADD COLUMN IF NOT EXISTS result_status VARCHAR(30),
    ADD COLUMN IF NOT EXISTS raw_result_summary TEXT,
    ADD COLUMN IF NOT EXISTS approval_source VARCHAR(50);

-- NJ BRC lookup + proposed/current detail (from 20261002_nj_brc_rpa_mapping.sql)
ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS brc_name_control_used VARCHAR(4),
    ADD COLUMN IF NOT EXISTS business_entity_id_used VARCHAR(100),
    ADD COLUMN IF NOT EXISTS certificate_number VARCHAR(100),
    ADD COLUMN IF NOT EXISTS synced_effective_date_proposed DATE,
    ADD COLUMN IF NOT EXISTS current_effective_date DATE,
    ADD COLUMN IF NOT EXISTS exception_message TEXT;

-- Review decision detail + Test Mode label (from 20261002_nj_brc_test_mode.sql)
ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS rejection_reason TEXT,
    ADD COLUMN IF NOT EXISTS is_test BOOLEAN NOT NULL DEFAULT FALSE;

-- Constraints + idempotency index (idempotent)
ALTER TABLE public.compliance_sync_review_queue DROP CONSTRAINT IF EXISTS chk_compliance_sync_review_queue_result_status;
ALTER TABLE public.compliance_sync_review_queue ADD CONSTRAINT chk_compliance_sync_review_queue_result_status
    CHECK (result_status IS NULL OR result_status IN ('Match Found', 'No Match Found', 'Multiple Matches', 'Invalid Search', 'Website Error', 'RPA Error'));

CREATE INDEX IF NOT EXISTS idx_compliance_sync_review_queue_status
    ON public.compliance_sync_review_queue (status, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_sync_review_result
    ON public.compliance_sync_review_queue (sync_run_id, contractor_id, compliance_name)
    WHERE sync_run_id IS NOT NULL;

COMMIT;
