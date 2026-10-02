-- =====================================================================
-- NJ BRC RPA mapping — schema additions (Phase 1)
-- Date: 2026-10-02
--
-- Non-destructive: ADD COLUMN IF NOT EXISTS only. Adds the NJ BRC fields
-- that are genuinely missing after inspecting the existing
-- synced-compliance / review-queue / exceptions schema. Reuses existing
-- columns wherever possible.
--
-- Relational and portable to Microsoft SQL Server (no JSON columns for
-- core business values).
--
-- =====================================================================
-- COMPLIANCE LOGIC LOCK
-- =====================================================================
-- These columns store NJ BRC synced / review / diagnostic data ONLY.
-- They are never read by dashboard counts, Missing Information, 90/60/30
-- Day, Expired, contractor status, reports, reminders, or Active
-- Compliance Records. Approving a review entry stores the decision only;
-- it does NOT copy values into Active Compliance Records.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- compliance_records: display-only NJ BRC Synced Compliance Record fields
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_records
    ADD COLUMN IF NOT EXISTS synced_effective_date DATE,
    ADD COLUMN IF NOT EXISTS sync_status VARCHAR(20),
    ADD COLUMN IF NOT EXISTS source_url TEXT,
    ADD COLUMN IF NOT EXISTS certificate_number VARCHAR(100),
    ADD COLUMN IF NOT EXISTS searched_name_control VARCHAR(4),
    ADD COLUMN IF NOT EXISTS searched_business_entity_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS matched_business_entity_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS matched_company_name VARCHAR(200),
    ADD COLUMN IF NOT EXISTS sync_run_id INTEGER REFERENCES public.compliance_sync_runs(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS raw_result_summary TEXT;

ALTER TABLE public.compliance_records DROP CONSTRAINT IF EXISTS chk_compliance_records_sync_status;
ALTER TABLE public.compliance_records ADD CONSTRAINT chk_compliance_records_sync_status
    CHECK (sync_status IS NULL OR sync_status IN ('Never Synced', 'Pending Review', 'Approved', 'Rejected', 'Failed', 'Auto Approved'));

-- ---------------------------------------------------------------------
-- compliance_sync_review_queue: NJ BRC lookup + proposed/current detail
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_review_queue
    ADD COLUMN IF NOT EXISTS brc_name_control_used VARCHAR(4),
    ADD COLUMN IF NOT EXISTS business_entity_id_used VARCHAR(100),
    ADD COLUMN IF NOT EXISTS certificate_number VARCHAR(100),
    ADD COLUMN IF NOT EXISTS synced_effective_date_proposed DATE,
    ADD COLUMN IF NOT EXISTS current_effective_date DATE,
    ADD COLUMN IF NOT EXISTS exception_message TEXT;

-- ---------------------------------------------------------------------
-- compliance_sync_exceptions: company name + source url for diagnostics
-- ---------------------------------------------------------------------
ALTER TABLE public.compliance_sync_exceptions
    ADD COLUMN IF NOT EXISTS company_name VARCHAR(200),
    ADD COLUMN IF NOT EXISTS source_url TEXT;

COMMIT;
