-- =====================================================================
-- NJ PWC — Repair missing Review Queue entries for synced placeholders
-- Date: 2026-10-06
--
-- Purpose: some NJ PWC synced placeholder records were created with
-- valid registration data but WITHOUT a matching Compliance Sync Review
-- Queue entry. This migration creates the missing Review Queue entries
-- ONLY. It does NOT approve, activate, delete, or otherwise modify any
-- compliance record.
--
-- Scope of rows repaired:
--   compliance_records WHERE
--     active = FALSE
--     is_current = FALSE
--     sync_status = 'Pending Review'
--     registration_number is present
--     expiration_date is present
--     compliance type = 'NJ PWC'
--     AND no pending NJ PWC review-queue entry exists for that record
--
-- Known affected contractors at authoring time: 390, 392 (included in
-- audit output below; NOT hardcoded into the INSERT).
--
-- NON-DESTRUCTIVE: INSERT into compliance_sync_review_queue only.
-- No UPDATE / DELETE / approval / activation is performed.
-- Safe to run multiple times (the NOT EXISTS guard makes it idempotent).
--
-- >>> DO NOT EXECUTE AUTOMATICALLY. Run manually after review. <<<
-- =====================================================================

BEGIN;

-- Audit output: list the placeholder records that lack a review entry
-- (informational; run as a SELECT to preview before committing).
--   SELECT cr.id, cr.contractor_id, cr.registration_number,
--          cr.effective_date, cr.expiration_date
--   FROM public.compliance_records cr
--   JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
--   WHERE ct.compliance_name = 'NJ PWC'
--     AND cr.active = FALSE AND cr.is_current = FALSE
--     AND cr.sync_status = 'Pending Review'
--     AND NULLIF(TRIM(cr.registration_number), '') IS NOT NULL
--     AND cr.expiration_date IS NOT NULL
--     AND NOT EXISTS (
--       SELECT 1 FROM public.compliance_sync_review_queue q
--       WHERE q.compliance_record_id = cr.id
--         AND q.compliance_name = 'NJ PWC'
--         AND q.status = 'pending'
--     );

INSERT INTO public.compliance_sync_review_queue (
    sync_run_id,
    contractor_id,
    compliance_record_id,
    compliance_name,
    proposed_registration_number,
    proposed_status,
    proposed_expiration_date,
    current_registration_number,
    current_effective_date,
    current_expiration_date,
    status,
    sync_source,
    result_key,
    certificate_number,
    matched_company_name,
    synced_effective_date_proposed,
    last_verified,
    result_status,
    raw_result_summary,
    is_test
)
SELECT
    NULL,                                   -- no originating sync run for a repair
    cr.contractor_id,
    cr.id,                                  -- compliance_record_id
    'NJ PWC',
    cr.registration_number,                 -- proposed_registration_number
    NULL,                                   -- proposed_status
    cr.expiration_date,                     -- proposed_expiration_date
    cr.registration_number,                 -- current_registration_number
    cr.effective_date,                      -- current_effective_date
    cr.expiration_date,                     -- current_expiration_date
    'pending',                              -- status
    'RPA',                                  -- sync_source
    'repair:' || cr.id::text || ':NJ PWC',  -- result_key (repair provenance)
    cr.registration_number,                 -- certificate_number
    NULL,                                   -- matched_company_name (unknown at repair time)
    cr.effective_date,                      -- synced_effective_date_proposed
    NOW(),                                  -- last_verified
    'Match Found',                          -- result_status
    'NJ PWC placeholder repair — review queue entry created; not approved or activated.',
    FALSE                                   -- is_test
FROM public.compliance_records cr
JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
WHERE ct.compliance_name = 'NJ PWC'
  AND cr.active = FALSE
  AND cr.is_current = FALSE
  AND cr.sync_status = 'Pending Review'
  AND NULLIF(TRIM(cr.registration_number), '') IS NOT NULL
  AND cr.expiration_date IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM public.compliance_sync_review_queue q
      WHERE q.compliance_record_id = cr.id
        AND q.compliance_name = 'NJ PWC'
        AND q.status = 'pending'
  );

-- Record the repair in the audit log (one row per repaired record).
INSERT INTO public.administration_audit_log (
    user_name, user_email, action, object_type, object_id, object_label, details
)
SELECT
    'system', '', 'NJ_PWC_REVIEW_ENTRY_REPAIRED', 'compliance_sync',
    cr.id::text, 'Compliance Record #' || cr.id::text,
    jsonb_build_object(
        'contractor_id', cr.contractor_id,
        'compliance_record_id', cr.id,
        'registration_number', cr.registration_number,
        'effective_date', cr.effective_date,
        'expiration_date', cr.expiration_date,
        'repaired', 'review_queue_entry_created'
    )
FROM public.compliance_records cr
JOIN public.compliance_types ct ON ct.id = cr.compliance_type_id
WHERE ct.compliance_name = 'NJ PWC'
  AND cr.active = FALSE
  AND cr.is_current = FALSE
  AND cr.sync_status = 'Pending Review'
  AND NULLIF(TRIM(cr.registration_number), '') IS NOT NULL
  AND cr.expiration_date IS NOT NULL
  AND EXISTS (
      SELECT 1 FROM public.compliance_sync_review_queue q
      WHERE q.compliance_record_id = cr.id
        AND q.compliance_name = 'NJ PWC'
        AND q.status = 'pending'
        AND q.result_key = 'repair:' || cr.id::text || ':NJ PWC'
  );

COMMIT;
