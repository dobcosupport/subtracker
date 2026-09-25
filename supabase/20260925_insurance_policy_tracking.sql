BEGIN;

ALTER TABLE contractor_insurance
    ADD COLUMN IF NOT EXISTS general_liability_on_file BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS general_liability_expiration_date DATE,
    ADD COLUMN IF NOT EXISTS workers_comp_on_file BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS workers_comp_expiration_date DATE;

ALTER TABLE contractor_insurance_history
    ADD COLUMN IF NOT EXISTS general_liability_on_file BOOLEAN,
    ADD COLUMN IF NOT EXISTS general_liability_expiration_date DATE,
    ADD COLUMN IF NOT EXISTS workers_comp_on_file BOOLEAN,
    ADD COLUMN IF NOT EXISTS workers_comp_expiration_date DATE;

COMMIT;
