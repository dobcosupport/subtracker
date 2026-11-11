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

The normal developer environment currently points at the production Supabase
project. Until the pending migration is approved and applied, running the new
Projects code against that database is intentionally incompatible.
`getAssignments()` hydrates contractor counts through a nested
`projects!inner(..., completed_at, completed_by, cancelled_at, cancelled_by)`
selection. PostgREST calls that joined relation `projects_1`, which explains
`column projects_1.completed_at does not exist` on the old schema. The directory
read itself uses `projects.select("*")`; removing the new fields is not a fix.

Use the isolated production-build preview for pre-migration review, not the
production-backed developer server. Its environment contains only synthetic
local credentials and points to the loopback fixture server. With
`TEST_PREVIEW_PORT`, the lifecycle test installs the historical prerequisite and
the exact pending migration into disposable PGlite, then serves those actual SQL
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

## Pending migration and reviewed development correction

[20261215_project_completion_guard.sql](../supabase/20261215_project_completion_guard.sql)
supersedes the installed Inactive closeout model. It has **not** been applied to
production as part of this local implementation.

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
is needed. No production application is authorized until visual/migration review.

## Local validation

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

Validation results for this local candidate:

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
- Two older broad harnesses are not green: `test-public-works-ui.mjs` still
  expects the old dashboard's `PWC Missing` filter (the committed baseline test
  fails at the same selector); unchanged `test-contractor-project-layout.mjs`
  invokes a component's existing `window.confirm` from Node without a window.
  Their unrelated dashboard/component behavior was not changed to force a pass.
  The new lifecycle browser suite independently exercises the changed project
  actions, classification, current relationships and historical views.

Email Communications, Scheduled Email, their settings, Windows trigger and live
delivery are outside this migration and remain unchanged.
