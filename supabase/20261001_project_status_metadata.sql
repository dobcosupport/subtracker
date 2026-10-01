-- Project status metadata and history timeline support
--
-- Stores who deactivated/reactivated a project and when, for audit purposes.
-- Status changes are additionally recorded in activity_log (project-level rows),
-- and contractor assignment/removal events are logged to activity_log as well,
-- giving a permanent project status timeline.

ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS inactivated_by VARCHAR(200);
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS inactivated_at TIMESTAMPTZ;
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS reactivated_by VARCHAR(200);
ALTER TABLE projects
    ADD COLUMN IF NOT EXISTS reactivated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_activity_log_type ON activity_log (activity_type);
