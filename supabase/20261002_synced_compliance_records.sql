-- =====================================================================
-- Synced Compliance Records support
-- Date: 2026-10-02
--
-- Adds nullable "sync" fields to compliance_records for the four
-- registration-based compliance types (NJ PWC, NJ BRC, NY PWC, NY BRC).
--
-- =====================================================================
-- COMPLIANCE LOGIC LOCK
-- =====================================================================
-- Active Compliance Records (compliance_records.expiration_date /
-- registration_number via the contractor_compliance_status view) remain
-- the AUTHORITATIVE and SOLE source for:
--   - Expired / 90 / 60 / 30 Day compliance buckets
--   - Dashboard counts
--   - Contractor compliance status and badges
--   - Compliance reports
--   - Reminder generation and email notifications
--   - Compliance warnings
--
-- The synced_* columns in this migration are INFORMATIONAL ONLY. They
-- are NOT read by dashboard counts, expiration warnings, status
-- calculations, reminder generation, or reports. The
-- contractor_compliance_status view deliberately does NOT reference
-- them.
--
-- FUTURE PREPARATION (do NOT implement now):
--   These columns reserve space for upcoming external integrations:
--     - NJ DOL integration
--     - NJ Public Works integration
--     - NY Public Works integration
--     - Daily RPA verification jobs
--     - API integrations
--   Possible future behavior (requires explicit approval workflow):
--     IF Administrator approves a Synced Record
--     THEN update the matching Active Compliance Record
--   or
--     IF sync_source = 'API'
--     THEN the Active Compliance Record may eventually be auto-updated
--   Until that logic is intentionally built, synced data has no effect
--   on compliance status, counts, reports, or expiration tracking.
-- =====================================================================

BEGIN;

ALTER TABLE compliance_records
    -- Verified registration number as reported by the sync source
    ADD COLUMN IF NOT EXISTS synced_registration_number VARCHAR(200),
    -- Expiration date as reported by the sync source
    ADD COLUMN IF NOT EXISTS synced_expiration_date DATE,
    -- When the record was last verified by the sync source
    ADD COLUMN IF NOT EXISTS synced_last_verified_at TIMESTAMPTZ,
    -- When the last sync job ran against this record
    ADD COLUMN IF NOT EXISTS last_sync_at TIMESTAMPTZ,
    -- Origin of the synced data
    ADD COLUMN IF NOT EXISTS sync_source VARCHAR(10);

-- Constrain sync_source to the allowed values (nullable)
ALTER TABLE compliance_records
    DROP CONSTRAINT IF EXISTS chk_compliance_records_sync_source;

ALTER TABLE compliance_records
    ADD CONSTRAINT chk_compliance_records_sync_source
    CHECK (sync_source IS NULL OR sync_source IN ('Manual', 'RPA', 'API'));

COMMIT;
