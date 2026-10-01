-- Inactive Contractors support
--
-- The existing `contractors.active` BOOLEAN column is the contractor status field:
--   TRUE  = 'Active'
--   FALSE = 'Inactive'
-- (Equivalent to: contractor_status VARCHAR(20) NOT NULL DEFAULT 'Active'
--  with supported values 'Active' / 'Inactive'.)
--
-- Deactivating a contractor NEVER deletes the contractor record or any related
-- history (compliance records, insurance records/history, project assignments
-- and history, follow-ups, tiered subs, activity_log audit trail).

-- Index to support Active/Inactive contractor list filtering.
CREATE INDEX IF NOT EXISTS idx_contractors_active ON contractors (active);
