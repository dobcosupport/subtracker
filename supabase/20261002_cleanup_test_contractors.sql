-- =====================================================================
-- ONE-TIME CLEANUP: Test Contractors
-- Date: 2026-10-02
-- Targets (exact company_name match only):
--   Acme, Johnny Appleseed, Mr SnowPlow, Pauls Painting,
--   Sallys Lawn Service, Test Company, Testing 2
--
-- SECTION 1: REVIEW — run first, inspect output, then run SECTION 2.
-- =====================================================================

-- ---------------------------------------------------------------------
-- SECTION 1: REVIEW QUERIES (read-only — safe to run anytime)
-- ---------------------------------------------------------------------

-- 1a. Contractors matched by exact name (this is the authoritative list
--     of what will be deleted):
SELECT id, company_name, active, created_at
FROM contractors
WHERE company_name IN (
    'Acme',
    'Johnny Appleseed',
    'Mr SnowPlow',
    'Pauls Painting',
    'Sallys Lawn Service',
    'Test Company',
    'Testing 2'
)
ORDER BY company_name;

-- 1b. Names from the target list that did NOT match any contractor
--     (should return 0 rows if all seven exist):
SELECT missing.name
FROM (VALUES
    ('Acme'),
    ('Johnny Appleseed'),
    ('Mr SnowPlow'),
    ('Pauls Painting'),
    ('Sallys Lawn Service'),
    ('Test Company'),
    ('Testing 2')
) AS missing(name)
WHERE NOT EXISTS (
    SELECT 1 FROM contractors c WHERE c.company_name = missing.name
);

-- 1c. Related-record counts per table for the matched contractors
--     (rows that will be deleted):
WITH target AS (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
)
SELECT 'documents'                  AS table_name, COUNT(*) AS rows_to_delete FROM documents                  WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'reminders',                            COUNT(*) FROM reminders                            WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'contractor_followups',                 COUNT(*) FROM contractor_followups                 WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'compliance_records',                   COUNT(*) FROM compliance_records                   WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'contractor_projects',                  COUNT(*) FROM contractor_projects                  WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'contractor_insurance',                 COUNT(*) FROM contractor_insurance                 WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'contractor_insurance_history',         COUNT(*) FROM contractor_insurance_history         WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'contractor_tiered_subs (as contractor)', COUNT(*) FROM contractor_tiered_subs             WHERE contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'contractor_tiered_subs (as tiered sub)', COUNT(*) FROM contractor_tiered_subs             WHERE tiered_sub_contractor_id IN (SELECT id FROM target)
UNION ALL
SELECT 'activity_log',                         COUNT(*) FROM activity_log                         WHERE contractor_id IN (SELECT id FROM target)
ORDER BY table_name;

-- 1d. Storage files that will be orphaned (delete manually from the
--     storage bucket after running the deletes):
SELECT d.storage_path, d.original_file_name, c.company_name
FROM documents d
JOIN contractors c ON c.id = d.contractor_id
WHERE c.company_name IN (
    'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
    'Sallys Lawn Service', 'Test Company', 'Testing 2'
)
ORDER BY c.company_name, d.document_name;

-- =====================================================================
-- SECTION 2: EXECUTION (deletes data — run only after reviewing 1a-1d)
-- =====================================================================

BEGIN;

-- Step 1: documents (child of contractors AND compliance_records)
DELETE FROM documents
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 2: reminders (child of contractors AND compliance_records)
DELETE FROM reminders
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 3: contractor_followups (child of contractors AND compliance_records)
DELETE FROM contractor_followups
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 4: compliance_records (child of contractors)
DELETE FROM compliance_records
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 5: contractor_projects / project assignments (child of contractors)
DELETE FROM contractor_projects
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 6: contractor_insurance (child of contractors)
DELETE FROM contractor_insurance
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 7: contractor_insurance_history (child of contractors)
DELETE FROM contractor_insurance_history
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 8: contractor_tiered_subs — both directions (parent contractor
-- and as the tiered sub itself)
DELETE FROM contractor_tiered_subs
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
)
OR tiered_sub_contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 9: activity_log / audit history (child of contractors)
DELETE FROM activity_log
WHERE contractor_id IN (
    SELECT id FROM contractors
    WHERE company_name IN (
        'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
        'Sallys Lawn Service', 'Test Company', 'Testing 2'
    )
);

-- Step 10: verify no children remain, then delete the contractors
-- (this final delete is the only irreversible step — review the counts
-- returned by each DELETE above before committing)
DELETE FROM contractors
WHERE company_name IN (
    'Acme',
    'Johnny Appleseed',
    'Mr SnowPlow',
    'Pauls Painting',
    'Sallys Lawn Service',
    'Test Company',
    'Testing 2'
);

-- Sanity check: should return 0 rows after execution
SELECT 'remaining target contractors' AS check_name, COUNT(*) AS remaining
FROM contractors
WHERE company_name IN (
    'Acme', 'Johnny Appleseed', 'Mr SnowPlow', 'Pauls Painting',
    'Sallys Lawn Service', 'Test Company', 'Testing 2'
);

-- Review all row counts from the DELETE statements above.
-- If anything looks wrong: ROLLBACK;
-- If everything is correct: COMMIT;
COMMIT;
