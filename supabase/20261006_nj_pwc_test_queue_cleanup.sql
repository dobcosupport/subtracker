-- =====================================================================
-- NJ PWC — Delete orphaned pending search requests (test data cleanup)
-- Date: 2026-10-06
--
-- Deletes ONLY the 8 orphaned pending NJ PWC search requests created
-- during worker testing. These never produced candidates, were never
-- processed by the PAD worker, and have no downstream records.
--
-- Target IDs: 15, 16, 17, 18, 19, 20, 21, 22
--
-- SAFETY GUARDS (all must hold for a row to be deleted):
--   * compliance_name = 'NJ PWC'
--   * status = 'pending'           (never completed / no_match / failed)
--   * candidates = '[]'            (no candidates were ever returned)
--   * selected_candidate IS NULL   (no candidate was ever selected/imported)
--   * is_test = FALSE              (these are worker-test requests)
--
-- The table is standalone: it has no contractor_id column, and neither
-- compliance_sync_review_queue nor compliance_records references
-- search_request_id. No review queue entries, sync runs, or compliance
-- records are touched.
--
-- DESTRUCTIVE (DELETE). Run manually. Preview with the SELECT below first.
-- =====================================================================

BEGIN;

-- Preview: rows that WILL be deleted (run this SELECT first to confirm).
--   SELECT id, searched_company_name, status, candidates, is_test, created_at
--   FROM public.compliance_sync_search_requests
--   WHERE id IN (15,16,17,18,19,20,21,22)
--     AND compliance_name = 'NJ PWC'
--     AND status = 'pending'
--     AND candidates = '[]'::jsonb
--     AND selected_candidate IS NULL
--     AND is_test = FALSE;

DELETE FROM public.compliance_sync_search_requests
WHERE id IN (15,16,17,18,19,20,21,22)
  AND compliance_name = 'NJ PWC'
  AND status = 'pending'
  AND candidates = '[]'::jsonb
  AND selected_candidate IS NULL
  AND is_test = FALSE;

COMMIT;
