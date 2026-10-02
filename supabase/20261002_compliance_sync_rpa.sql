-- =====================================================================
-- Compliance Sync RPA Integration (Phase 1) — schema additions
-- Date: 2026-10-02
--
-- Non-destructive: only ADD COLUMN IF NOT EXISTS / new indexes on the
-- tables created by 20261002_compliance_sync_admin.sql.
--
-- Relational and portable to Microsoft SQL Server: no JSON/JSONB columns
-- are used for business values (raw diagnostics are stored as TEXT).
--
-- =====================================================================
-- COMPLIANCE LOGIC LOCK
-- =====================================================================
-- These columns support the RPA pipeline writing to Synced Compliance
-- Records, Sync Runs, Review Queue, and Exceptions ONLY. They are never
-- read by dashboard counts, Missing Information, contractor status,
-- reminders, reports, or Active Compliance Records. Active Compliance
-- Records remain the sole authoritative source. Approving a review entry
-- does NOT update Active Compliance Records (auto-write stays disabled).
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- compliance_sync_runs: run lifecycle for RPA runs
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_runs
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS run_status VARCHAR(30),
    ADD COLUMN IF NOT EXISTS records_failed INTEGER NOT NULL DEFAULT 0 CHECK (records_failed >= 0),
    ADD COLUMN IF NOT EXISTS initiated_by VARCHAR(200),
    ADD COLUMN IF NOT EXISTS bot_version VARCHAR(50),
    ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Constrain run_status to the allowed lifecycle values (nullable)
ALTER TABLE public.compliance_sync_runs DROP CONSTRAINT IF EXISTS chk_compliance_sync_runs_run_status;
ALTER TABLE public.compliance_sync_runs ADD CONSTRAINT chk_compliance_sync_runs_run_status
    CHECK (run_status IS NULL OR run_status IN ('Running', 'Completed', 'Completed With Errors', 'Failed'));

-- ---------------------------------------------------------------------
-- compliance_sync_review_queue: RPA result + idempotency + approval lock
-- ---------------------------------------------------------------------
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

ALTER TABLE public.compliance_sync_review_queue DROP CONSTRAINT IF EXISTS chk_compliance_sync_review_queue_result_status;
ALTER TABLE public.compliance_sync_review_queue ADD CONSTRAINT chk_compliance_sync_review_queue_result_status
    CHECK (result_status IS NULL OR result_status IN ('Match Found', 'No Match Found', 'Multiple Matches', 'Invalid Search', 'Website Error', 'RPA Error'));

-- Idempotency: one result per (sync_run_id, contractor_id, compliance_name)
CREATE UNIQUE INDEX IF NOT EXISTS uq_compliance_sync_review_result
    ON public.compliance_sync_review_queue (sync_run_id, contractor_id, compliance_name)
    WHERE sync_run_id IS NOT NULL;

-- ---------------------------------------------------------------------
-- compliance_sync_exceptions: capture result_status for diagnostics
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_exceptions
    ADD COLUMN IF NOT EXISTS result_status VARCHAR(30);

COMMIT;
