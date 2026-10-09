This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open the URL configured by `APP_URL` with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Dashboard Custom Export

The Dashboard **Export** button opens Custom Export. Choose the current
Dashboard results (the current card and search), or all accessible contractors,
including inactive contractors. Select fields and download Excel or CSV.
Exports have one row per contractor. Dates are `YYYY-MM-DD`; repeated project
names and numbers are semicolon-separated. Project assignments and tiered-sub
relationships include active relationships only.

Compliance numbers, dates, and statuses use active, current compliance records
and active compliance types, never synced records or contractor master
registration numbers. Conflicting active/current records do not block export:
the affected compliance fields are blank, and the default-selected **Data Warning**
field in **Data Quality** describes each conflict, separated by semicolons.
The completion message counts affected contractors, not individual conflicts.
When Data Warning is deselected, a warning and explicit download confirmation
are shown before downloading a file that omits the warnings. The dialog stays
open after download to show the completion message. Latest follow-up uses follow-up date
descending, then creation date descending, matching the contractor detail page.

All retrieval uses the signed-in Supabase client and Row Level Security.
Additional row data is loaded only when Export is confirmed; the dialog loads
only an exact contractor count on opening. Active/current compliance is checked
on every export, even when compliance fields are deselected, so warnings are
not silently missed. Closing aborts pending requests.
Excel uses one `Contractors` worksheet, text-preserving cells, and bounded
column widths. CSV includes a UTF-8 BOM and protects formula-like text.
Header freezing is not supported by the installed SheetJS export API.

DBA, EIN, Website, insurance carriers/policy numbers, Automobile/Umbrella
coverage, and a next follow-up date are omitted because they are not available
in the verified contractor/export models. Stable field IDs and the export
configuration support future presets; no templates or schema changes are
implemented.

Run the isolated export tests with `node scripts\test-custom-export.mjs`.
These tests use synthetic data and do not access Supabase.

## Saved Export Templates

Apply `supabase\20261008_saved_export_templates.sql` after the existing user
management migrations. It creates template storage, RLS, personal preferences,
and two protected system templates: **Contractor Master Export** (26 fields,
Contractors category) and **Insurance Expiration Export** (10 fields, Insurance
category). Both default to Excel, All Contractors, and company-name order.
No existing contractor, compliance, insurance, or import records are changed.

Manage templates in the **Saved Export Templates** section of Import / Export.
Create, edit, duplicate, and delete use the existing imports Add/Edit/Delete
permissions; ownership is also enforced by RLS. System templates can only be
duplicated. Only administrators may publish shared templates. Category organizes
templates (Contractors, Compliance, Insurance, Projects, Executive, Personal);
it does not grant access. Personal category is independent of private visibility.
Favorites and the single default template are per user.

Dashboard Export lists templates grouped/filterable by category and offers
**Run**, **Review settings**, and **Create Custom Export**. Reviewing changes
settings for that run only; save permanent changes in Import / Export.
Current Dashboard Results uses the current visible IDs, never saved IDs.
All Contractors ignores Dashboard filters. Additional filters narrow the export
scope only: status/vendor equality, case-insensitive state equality, and
case-insensitive city/name contains, combined with AND.
Sorting supports company name, Sage ERP ID, city, state, and ZIP; contractor ID
breaks ties. Column order is saved with stable field IDs, independent of labels.
Invalid/retired fields or unsupported versions require explicit review/repair
before execution; they are never silently omitted.

New templates default-select Data Warning. Deliberate removal is preserved, and
the pre-download warning confirmation remains in place. Compliance stays
active/current-authoritative, ambiguous fields stay blank, and one contractor's
conflict does not block other rows. Templates do not elevate source-data access.
A missing migration shows an explicit loading error while ad hoc export remains
available.

Run `node scripts\test-custom-export.mjs` and
`node scripts\test-export-templates.mjs` for synthetic unit tests.
Run `supabase\tests\saved_export_templates.sql` only against an isolated test
database with the migration installed; its synthetic fixtures are rolled back.

## Compliance Sync Worker Health

Worker Health appears directly below the Compliance Sync heading, above existing
content. It shows liveness, server-received heartbeat, last successful search,
historical last error, process start time, worker-file modification time, and
Restart Required. No host secrets, PID-based controls, or raw filesystem logs are
exposed. Four cards share the same layout: NJ PWC Worker uses live telemetry;
NY Worker, Reminder Automation Worker, and Email Notification Worker are UI-only
placeholders marked Planned with a neutral status indicator and excluded from overall status. Their test
and log actions are disabled. No jobs, reminder schedules, or email sending are
implemented for these planned workers.

Overall health is green (Healthy) when all enabled workers are online/current, amber when
degraded or restart is required, and red when a required worker is offline.
Heartbeat boundaries are 60 seconds (fresh) and 120 seconds (offline beyond that).
Explicit shutdown is offline immediately. A long search retains online status
with fresh independent heartbeats and connected Chromium. Missing/stale queue
polls outside a search or disconnected Chromium make new searches unavailable.
Stopped describes telemetry expiry or shutdown, not an OS process inspection.
Successful Search includes completed No Match Found lookups; recovered errors
remain visible as history, without permanently degrading health.

Telemetry uses the existing RPA key on a dedicated server endpoint and stores
summary metadata in `compliance_sync_workers`; operational events are retained
in `compliance_sync_worker_events` (200 per worker, 50 shown). Browser roles cannot
access these tables directly. Health/log API reads require `compliance_sync/view`;
Test Worker requires `compliance_sync/manage`, is audited and rate-limited to
one request per worker per 30 seconds. The worker acknowledges readiness without
searching the registry or touching compliance records. A missing acknowledgement
times out explicitly. No direct restart or remote command execution is provided.

NJ PWC search creation is server-guarded: unavailable workers return HTTP 503
with **NJ PWC Worker Offline**, without inserting a search. Contractor Detail and
Add Contractor show the same feedback, including when resuming pending work.
Existing requests are not deleted and completed results remain readable offline.
A running worker needing restart remains usable with a warning. Health lookup
failure is an explicit error, not a silent healthy fallback.

Deployment order:
1. Review/apply `supabase\20261009_compliance_worker_health.sql` once; it adds only
   operational tables, grants, and a server-only atomic ingestion function.
   It does not alter existing compliance/follow-up policies or calculations.
2. Deploy the application endpoints and UI. Until the upgraded worker reports,
   health is unreported/offline and new search creation is blocked.
3. Stop the existing NJ PWC worker terminal with Ctrl+C, then run
   `Set-Location -LiteralPath 'D:\subtracker\worker\nj-pwc'` and
   `.\start-worker.ps1`. Do not start a duplicate instance.
   Monitoring history begins with this upgraded instance; old local log entries
   are not imported and an old running process cannot supply the new telemetry.
4. Verify initial telemetry, Test Worker acknowledgement, recent logs, and an
   authorized known-match lookup. Editing worker files requires another restart;
   file timestamps and code hashes are reported by the worker host, not read by
   the web server. Keep the host clock synchronized.

Run `node --test scripts\test-worker-health.mjs` for synthetic health/API/worker
tests, and `node scripts\test-worker-health-db.mjs` with PGlite on the test module
path (`PGLITE_MODULE` may point to an existing isolated installation). The database
runner uses an in-memory fixture and `supabase\tests\compliance_worker_health.sql`.
Never run that acceptance SQL against production.
Run `node scripts\test-worker-health-ui.mjs` with `TEST_APP_URL` pointing to an
isolated localhost production preview and Playwright available through the module
path or `PLAYWRIGHT_MODULE`. Authentication, API responses, and test requests are
intercepted synthetic fixtures; this validation performs no live database writes.

## Contractor Active Follow-Ups

The right side of Contractor Detail lists **Active Follow-Ups** with Open or
Waiting Response status. Each keyboard-accessible card opens the existing
follow-up editor, including date, method, Related Item, optional specific record, subject,
notes, and status. Confirmed saves update the list immediately; Closed and
Resolved items leave the active list but remain in Follow-Up History.
Failed saves leave the editor open and the active item unchanged.
**Related Item** supports None / General Follow-Up, active compliance registry
types (NJ PWC, NJ BRC, NY PWC, NY BRC, W9, Safety Certification), and Certificate
of Insurance, General Liability, and Workers Compensation. A specific record
is not required. Insurance selections use category metadata only, without an
insurance-record foreign key or a required insurance tracking row.

Compliance selections show **Specific Compliance Record (Optional)** with
matching active/current and historical contractor records, registration numbers,
and expiration dates. Empty option groups are hidden. Changing category with a
selected record requires confirmation; cancelling leaves the editor unchanged.
No specific record retains the type. None / General clears all relationships
only when explicitly saved.

`compliance_type_id` stores an optional type FK; `insurance_item_key` stores an
optional insurance category. Existing `compliance_record_id` values are retained.
Legacy record-only follow-ups display their linked record's type without a
backfill. Historical/inactive and unavailable links stay visible and selectable.
Legacy insurance compliance records are not converted to insurance keys.
Subject and Notes never determine Related Item.

The Follow-Ups import keeps its exact **Related Compliance Type** header and
preserves that type even without a record. It no longer auto-selects the latest
record, and does not match or create records. Insurance import headers are not
added in this phase. Related Item appears on active cards and in History.
Successful updates do not require a returned row: the edited values
update local state, followed by the existing database reload. Zero-row updates
are reported as errors, rather than displaying a successful local edit.
Existing history filters and database audit behavior are preserved.

If production has only the original development SELECT/INSERT policies,
apply `supabase\20261008_contractor_followups_update_policy.sql` after verifying
the granular user-management permission function is installed. This transactional,
re-runnable repair restores only the authenticated UPDATE policy, using
`user_has_module_permission('followups', 'edit')` for both USING and WITH CHECK.
It changes no records, relationship fields, other policies, or audit triggers.
Live status-transition verification succeeded after the repair. The live audit
query returned no entries for those test updates; production audit recording
remains an outstanding verification item, not a claimed result of this repair.

Run `node scripts\test-active-followups.mjs` for synthetic tests without
database access.

### Related Item deployment and validation

Do not run the new UI or importer against the old schema. Keep the development
server stopped until database approval and deployment are complete.

1. Back up and inspect production follow-up policies and `audit_followup_changes`.
   The prior live audit query found no entries, so verify the trigger/function
   before claiming production audit coverage; this feature does not repair it.
2. Review and approve `supabase\20261008_followup_related_items.sql`, then apply
   it once. It is transactional, adds two nullable columns and constraints plus
   an invoker-rights validation trigger, and does not update existing rows.
   It does not alter RLS, grants, the audit trigger, or the repaired UPDATE policy.
   Do not reapply the UPDATE-policy repair as part of this deployment.
3. Verify new columns, constraints, trigger, unchanged policies and audit trigger.
   Then build/deploy the UI and importer, or restart development.
4. Perform authorized live create/reopen/category/record/status tests and confirm
   corresponding audit rows, including relationship changes. Commit/push only
   after migration and live workflows are verified.

Run `node --test scripts\test-active-followups.mjs` for editor/service regression
tests. Run `node scripts\test-followup-related-items-db.mjs` with PGlite available
on the test module path (or `PGLITE_MODULE` pointing to an existing isolated
installation). The runner creates an in-memory synthetic fixture, loads the
existing granular permission function, repaired policy, and unchanged production
audit function, applies the new migration, and runs
`supabase\tests\followup_related_items.sql`. Never run that acceptance SQL in
production. Test transactions roll back; no production data is accessed.
Run `node scripts\test-followup-related-items-ui.mjs` with `TEST_APP_URL` set to
an isolated localhost production preview and Playwright on the test module path
(or `PLAYWRIGHT_MODULE` pointing to an existing isolated installation).
Authentication, API data, and every follow-up write are intercepted synthetic
fixtures; the test never writes to Supabase.

### Future reminder automation rules (documentation only)

- NJ BRC and NY BRC do not expire, must not require expiration dates, must not
  generate 90/60/30-day reminders, and missing expiration dates must not
  negatively affect their compliance status.
- Future automation must create follow-ups and send reminder emails 90, 60,
  and 30 days before expiration for applicable expiring compliance and insurance
  items. No reminder scheduling or email automation is implemented here.
- Existing compliance/insurance calculations are unchanged in this feature.

## Tiered Sub Relationships

Contractor Detail displays active parent/sub relationships on the right.
Contractor names link to Contractor Detail. **Shared Assigned Projects** are
the intersection of the parent's and sub's active project assignments, regardless
of project status; they do not establish project-specific subcontracting.
Project numbers link to the existing Projects detail modal using `projectId`.
Manage Tiered Subs retains assignment/removal controls, and Tiered Subs History
remains unchanged.

Supplemental Compliant/Expiring/Non-Compliant badges reuse the Dashboard's
existing compliance and insurance record-building and company-status logic.
The panel batches compliance, insurance, and project-assignment reads for all
displayed subs; there are no per-row requests. Large batches are chunked and
multi-row results are paginated. Status failures do not block relationship
navigation or project links and display an explicit unavailable message.
No synced compliance records are used and no schema changes are required.

Run `node scripts\test-tiered-sub-relationships.mjs` for synthetic tests.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
