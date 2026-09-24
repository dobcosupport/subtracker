BEGIN;

CREATE TABLE IF NOT EXISTS contractor_insurance (
    contractor_id INTEGER PRIMARY KEY,
    certificate_on_file BOOLEAN NOT NULL DEFAULT FALSE,
    last_verified_date DATE,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_contractor_insurance_contractor
        FOREIGN KEY (contractor_id) REFERENCES contractors(id)
        ON DELETE RESTRICT
);

ALTER TABLE contractor_insurance ENABLE ROW LEVEL SECURITY;

ALTER TABLE contractor_projects
    ADD COLUMN IF NOT EXISTS removed_date DATE;

ALTER TABLE contractor_projects
    DROP CONSTRAINT IF EXISTS uq_contractor_project;

ALTER TABLE contractor_projects
    DROP CONSTRAINT IF EXISTS chk_contractor_project_dates;

ALTER TABLE contractor_projects
    ADD CONSTRAINT chk_contractor_project_dates
        CHECK (removed_date IS NULL OR removed_date >= assigned_date);

CREATE UNIQUE INDEX IF NOT EXISTS uq_contractor_project_active
    ON contractor_projects (contractor_id, project_id)
    WHERE active = TRUE;

INSERT INTO compliance_types (compliance_name, requires_expiration, active)
VALUES
    ('NJ PWC', TRUE, TRUE),
    ('NJ BRC', FALSE, TRUE),
    ('NY PWC', TRUE, TRUE),
    ('NY BRC', FALSE, TRUE),
    ('W9', FALSE, TRUE),
    ('Safety Certification', TRUE, TRUE)
ON CONFLICT (compliance_name) DO UPDATE
SET requires_expiration = EXCLUDED.requires_expiration,
    active = TRUE;

UPDATE compliance_types
SET active = FALSE
WHERE compliance_name IN ('Public Works Registration', 'Business Registration');

UPDATE compliance_types
SET active = FALSE
WHERE compliance_name = 'Insurance Certificate';

CREATE OR REPLACE VIEW contractor_compliance_status
WITH (security_invoker = true) AS
SELECT
    c.id AS contractor_id,
    c.company_name,
    c.active AS contractor_active,
    cr.active AS compliance_active,
    cr.is_current AS compliance_current,
    CASE WHEN ct.id IS NULL THEN NULL ELSE cr.id END AS compliance_record_id,
    ct.id AS compliance_type_id,
    ct.compliance_name,
    cr.registration_number,
    cr.expiration_date,
    CASE
        WHEN cr.id IS NULL THEN NULL
        WHEN cr.expiration_date IS NULL THEN NULL
        ELSE (cr.expiration_date - CURRENT_DATE)::INTEGER
    END AS days_remaining,
    CASE
        WHEN cr.id IS NULL THEN 'Missing Information'
        WHEN ct.requires_expiration = TRUE AND cr.expiration_date IS NULL THEN 'Missing Information'
        WHEN ct.compliance_name IN ('NJ PWC', 'NY PWC')
            AND NULLIF(TRIM(cr.registration_number), '') IS NULL THEN 'Missing Information'
        WHEN cr.expiration_date <= CURRENT_DATE THEN 'Expired'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 1 AND 30 THEN '30 Day'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 31 AND 60 THEN '60 Day'
        WHEN (cr.expiration_date - CURRENT_DATE) BETWEEN 61 AND 90 THEN '90 Day'
        WHEN cr.expiration_date IS NULL AND ct.requires_expiration = FALSE THEN 'Active'
        WHEN (cr.expiration_date - CURRENT_DATE) > 90 THEN 'Active'
        ELSE 'Active'
    END AS calculated_status
FROM contractors c
LEFT JOIN compliance_records cr
    ON cr.contractor_id = c.id
   AND cr.active = TRUE
   AND cr.is_current = TRUE
LEFT JOIN compliance_types ct
    ON ct.id = cr.compliance_type_id
   AND ct.active = TRUE
WHERE c.active = TRUE;

COMMIT;