# Project lifecycle

## Statuses and directory

The shared Style 3 Projects page retains the project directory, search, sorting,
details and Actions controls.

Project Details uses a centered 94vw workspace (maximum 1600px) at 90dvh,
with responsive outer margins, a fixed-in-workspace header and one primary
vertical body scroll area. Relationship tables retain horizontal scrolling
on smaller screens so dates and action labels remain readable. This is a
presentation-only refinement; content, tabs, exports and lifecycle behavior
are unchanged.
Relationship actions use compact 28px secondary buttons with 12px medium text,
small consistent gaps and short Detach Procore / Detach myCOI labels. The
confirmation still identifies the full designation change. Export and Close use
the same compact sizing.

### Isolated preview database

The lifecycle migration has been applied to production and deployed at checkpoint
`dfc287fdbcd584887bcc028d9dc7ab03d47b4a29`. This is the functional/schema baseline;
the visual-only candidate does not require another migration or roll it back.
The normal developer environment points at the migrated production Supabase project.
`getAssignments()` hydrates contractor counts through a nested
`projects!inner(..., completed_at, completed_by, cancelled_at, cancelled_by)`
selection. PostgREST calls that joined relation `projects_1`, which explains
`column projects_1.completed_at does not exist` on the old schema. The directory
read itself uses `projects.select("*")`; removing the new fields is not a fix.

Use the isolated production-build preview for destructive regression tests, not the
production-backed developer server. Its environment contains only synthetic
local credentials and points to the loopback fixture server. With
`TEST_PREVIEW_PORT`, the lifecycle test installs the historical prerequisite and
the exact reviewed migration into disposable PGlite, then serves those actual SQL
rows and lifecycle RPCs. It includes an Active project with different source/action
combinations and Completed/Cancelled projects with retained assignments. Refreshes
retain this in-memory data while the preview process runs; restarting resets it.
This fixture is not a full Supabase/PostgREST replacement.

Both browser fixtures and the local HTTP fixture validate requested project
columns against SQL before serializing nested relationships, including all four
completion/cancellation fields. Regression tests deliberately remove each field
in a rolled-back local transaction and require the expected missing-column error.
The installed review RPC serializes the whole project row, so it automatically
includes the renamed completion and added cancellation metadata. Directory,
details, relationship/history reads and project exports use the same schema.
The unrelated older `inactivated_*`/`reactivated_*` metadata columns still exist;
they are not aliases for completion/cancellation or used to label terminal states.

| View | Database statuses |
| --- | --- |
| Current Projects | Active, Pending, On Hold |
| Completed Projects | Completed only |
| Cancelled Projects | Cancelled only |

New projects and normal status edits offer Active, Pending and On Hold.
Pending and On Hold preserve assignment periods but do not qualify a contractor
for NJ PWC monitoring. The existing authoritative eligibility predicate requires
an active contractor, active assignment and Active Public Works project; Material
Only and other existing exclusions remain unchanged.

Completed and Cancelled are terminal operational states. Project details may be
corrected, but status cannot be edited or reactivated. Reopening would require a
separately approved workflow; old assignment periods must not be reactivated.

## Authoritative actions

`POST /api/projects/[id]/lifecycle` accepts `complete`, `cancel`, `end` and
`detach`. The old `close` action is rejected.

- Complete Project requires an Active project.
- Cancel Project accepts Active, Pending or On Hold.
- Both require an active system administrator or Administrator with Project
  View/Edit permission and the current authoritative review token.
- Each uses the existing ownership advisory lock and a project row lock. Stale
  reviews return a conflict, without automatic retries.
- The private shared assignment-ending function clears effective ownership,
  sets `active=false`, records end date/actor/reason, retains original sources and
  detached designations, and records an Assignment Ended event.
- Existing source-removal audit/activity triggers continue to run. Project
  status, completion/cancellation metadata, events, administration audit and NJ
  PWC eligibility reconciliation commit together or all roll back.
- No project, relationship, compliance, document, contact, Follow-Up, policy,
  import or provenance row is deleted.
- Completed/Cancelled projects reject new active assignments, including import
  attempts. Current-assignment reads exclude them; unrestricted history reads
  retain their ended periods.

The confirmation has Cancel and the named action, without an acknowledgment
checkbox. A stale/failed review can be reloaded explicitly.

## Applied migration and reviewed development correction

[20261215_project_completion_guard.sql](../supabase/20261215_project_completion_guard.sql)
superseded the Inactive closeout model and was manually applied successfully in
Supabase before the lifecycle checkpoint was pushed and deployed.

It renames `closed_at/closed_by` to `completed_at/completed_by`, adds independent
cancellation metadata, replaces the lifecycle guard/action, and removes Inactive
from the project-status constraint. There is no UI translation from Inactive to
Completed and no compatibility action.

Read-only inspection identified these development fixtures:

| Assignment | Project | Contractor |
| --- | --- | --- |
| 1375 | 46, PROCORE VALIDATION 20261023 43F5D5 isolated MAN | 532, validation MATCH |
| 1376 | 47, PROCORE VALIDATION 20261023 43F5D5 isolated COI | 532, validation MATCH |
| 1377 | 48, PROCORE VALIDATION 20261023 43F5D5 isolated BOTH | 532, validation MATCH |
| 1378 | 46, same MAN fixture | 533, validation ADD |
| 1379 | 47, same COI fixture | 533, validation ADD |

Projects 46/47 were Inactive and project 48 was Completed without completion
metadata, lifecycle events or completion activity. All names share the validation
identifier above. They are not real completed-project history.

The migration refuses unknown prior completions/cancellations, unexpected
non-active assignments, or changes to the reviewed fixture identities and source
ownership. If the fixtures exist, the applying administrator must explicitly set
the connection's `subtracker.migration_actor` to their active authorized auth user
UUID before executing the migration. Missing or unauthorized actors abort it.
Do not invent an actor or bypass a preflight failure.

The correction uses the same private assignment-ending mechanism as normal
completion, records original reviews and correction audits, and standardizes
these three fixture projects to Completed. All five relationship IDs and their
source history remain. If there are no old terminal-state fixtures, no correction
is needed. These were migration preflight safeguards, not permission to rerun the
migration for visual-only work.

## Local validation

The deployed completion/cancellation schema is the functional baseline. The
Projects visual-completion candidate reuses shared Style 3 surface, button,
count, table and badge styles, extracted from the established Reports standard.
Each directory row has one compact Actions dropdown; View Project and Edit Project
inside it retain the existing handlers. Lifecycle actions are separated in the menu.
Complete Project and Cancel Project still enter the authoritative lifecycle
review. Public Works labels display the stored classification without changing
eligibility. There is no project-level Material Only field, additional filter,
or pagination behavior introduced by this visual checkpoint.
The approved 94vw / 90dvh Details workspace and 28px relationship, Export and
Close controls are unchanged. Rich approved and locked the final directory and
Details design on November 12, 2026. This visual checkpoint is separate from the
deployed lifecycle checkpoint and requires no schema migration.

Project names and secondary Public Works classification pills share a line when
space permits, with wrapping confined to narrower tables and long names. Rows use
tighter vertical padding; the existing five columns and single Actions menu remain.
Details shows the five core project fields, completion/cancellation date and actor
when applicable to the status or populated, and reactivation fields only when
reactivation metadata exists. Populated historical metadata is never suppressed
because of current status. Review, Complete/Cancel and relationship-view buttons
use compact 28px sizing without changing handlers, confirmations or modal size.

`node scripts\test-project-lifecycle.mjs` runs real PostgreSQL-compatible isolated
SQL, actual API handlers and service-query fixtures. Coverage includes:

- Reviewed five-period correction, source-removal audits, actor/preflight
  failures and late migration rollback.
- Active project with assignments to Completed, zero current assignments and
  retained source/relationship history.
- New qualifying Active Public Works assignment restoring eligibility.
- Cancellation from Active/Pending/On Hold; Pending/On Hold assignment retention.
- Direct/forged/unauthorized/stale/repeated requests and atomic audit failures.
- Completed/Cancelled import-assignment rejection and Company Merge safeguards.
- Unchanged compliance, documents, contacts, Follow-Ups and import provenance.

With `TEST_APP_URL` pointing to an isolated localhost production build and
`PLAYWRIGHT_MODULE` pointing to the existing Playwright installation, the same
suite exercises all three directory views, Actions, exact confirmations, retained
history, terminal-state restrictions and responsive shared Style 3 layout. All
API/database traffic is intercepted and backed by disposable local SQL.

Lifecycle checkpoint validation:

- Fresh webpack production build and TypeScript: passed.
- Isolated lifecycle SQL/API/service tests and production-rendered lifecycle
  browser suite: passed, including Current/Completed/Cancelled views and
  320px through 2560px responsive checks.
- Project current-compliance and PDF/XLSX browser suites, shared Style 3 shell,
  compliance-assessment, Procore mapping, myCOI ownership and Company Merge
  coverage: passed.
- Communications SQL/API and Scheduled Email SQL/worker/mock-delivery coverage:
  passed without live delivery.
- Scoped ESLint has no new findings. Two existing effect/state errors and one
  existing dependency warning remain on unchanged lines in the Projects and
  contractor-detail pages; they were not suppressed.
- `test-public-works-ui.mjs` follows the current Style 3 Dashboard Details path
  to the legacy PWC filters and keeps the existing eligibility, classification,
  grouping, error and lifecycle assertions. Its dashboard API fixture is
  intercepted, and the production-rendered browser test passes.
- `test-contractor-project-layout.mjs` supplies an explicit browser-confirm
  fixture to its Node-side handler checks and verifies both cancel and confirm
  behavior for removing the last MANUAL ownership source. Its production CSS
  layout checks pass without network or database access.
- The production-backed Style 3 live-read test compares dashboard eligibility
  with current active contractor, assignment and Active Public Works project
  rows, then checks the rendered compliance counts dynamically rather than
  relying on a fixed snapshot of changing production data.

Email Communications, Scheduled Email, their settings, Windows trigger and live
delivery are outside this migration and remain unchanged.

The content header uses the shared Style 3 tinted content-header treatment, and
the operational panel keeps its title, segmented lifecycle controls, compact
search and table in distinct sections. Table rows use subtle horizontal separators,
centered compact contractor counts and compact status badges rather than a full grid.
Counts are separate badges, not parenthesized label text. No directory columns or
sorting handlers changed.

Visual candidate validation includes TypeScript, an isolated webpack production
build, production-rendered lifecycle and Reports browser regressions, current
compliance and PDF/XLSX exports. Actions is checked for keyboard focus, Escape,
outside dismissal and unclipped positioning from 320px to 2560px. Connected
localhost review uses existing projects and contractor relationships only; it
does not confirm lifecycle mutations or send emails.
