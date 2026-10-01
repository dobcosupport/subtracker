-- Inactive Projects support
--
-- Uses the existing `projects.status` VARCHAR column as the project status field
-- (equivalent to: project_status VARCHAR(20) NOT NULL DEFAULT 'Active').
-- Supported values for the active/inactive workflow: 'Active' / 'Inactive'.
-- Existing values ('Pending', 'Completed', 'On Hold', 'Cancelled') remain valid
-- and are treated as non-active (inactive) for list/dashboard purposes.
--
-- Deactivating a project NEVER deletes the project or any related history
-- (contractor assignments, compliance records, insurance records, follow-ups,
-- documents, and activity_log audit trail are all preserved).

-- Allow 'Inactive' as a project status value.
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
    CHECK (status IN ('Active', 'Inactive', 'Pending', 'Completed', 'On Hold', 'Cancelled'));

-- Allow project-level audit entries (status changes) without a contractor.
ALTER TABLE activity_log ALTER COLUMN contractor_id DROP NOT NULL;

-- Indexes to support Active/Inactive project filtering and project audit history.
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects (status);
CREATE INDEX IF NOT EXISTS idx_activity_log_project_id ON activity_log (project_id);
