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

## Contractor Taxpayer ID

Contractor master records store Taxpayer ID (FEIN) in nullable text
`federal_tax_id`, separately from `nj_brc_number` (Business Entity ID) and
`brc_name_control`. Apply `supabase\20261009_contractor_federal_tax_id.sql`
before deploying the FEIN forms/imports/exports. It performs no backfill.
The contractor import header is `Taxpayer ID (FEIN)` in the Contractors
worksheet, immediately after `BRC Name Control` and before `Sage ERP ID`.
The generated workbook formats the entire FEIN column as Excel Text. Values
such as `001234567` and `12-3456789` are imported as entered; do not append the
NJ BRC worker's three lookup zeros in the workbook. The column is optional,
older workbooks without it import normally, and blank cells preserve existing
FEIN values.
Regenerate the published workbook with
`node scripts\generate-import-template.js`; the output is
`public\SubTracker_Import_Template.xlsx`, served by the Import / Export page.
Contractor master exports include FEIN; custom exports offer it as an optional,
not default-selected field. Handle these exports as sensitive business data.
Existing contractor audit triggers include the field in their changed-field
tracking. FEIN is not used for duplicate matching, compliance status,
expiration, or reminders, and is not sent to workers by this change.

Validate with `node --test scripts\test-contractor-fein.mjs` (requires PGlite
through `PGLITE_MODULE` or the module path). The tests use an isolated database
and the existing audit trigger definition. For mocked browser save/reopen tests,
run `scripts\test-contractor-fein-ui.mjs` with a localhost `TEST_APP_URL` and
Playwright on the module path or through `PLAYWRIGHT_MODULE`; no live writes occur.

## NJ BRC Worker: Approved Mapping and Deployment Gates

Target: https://www1.state.nj.us/TYTR_BRC/jsp/BRCLoginJsp.jsp

| SubTracker field | Database field | NJ BRC website field |
| --- | --- | --- |
| NJ BRC # | `nj_brc_number` | Business Entity ID |
| BRC Name Control | `brc_name_control` | Name Control |
| Taxpayer ID (FEIN) | `federal_tax_id` | Taxpayer ID |

These are three distinct identifiers. Neither FEIN nor a separately returned
certificate number may replace Business Entity ID or Name Control.

Primary NJ BRC search inputs are Business Entity ID (NJ BRC #), Name Control,
and Taxpayer ID (FEIN), using the source-supported lookup path described below.
NJ BRC # is not the Certificate Number. The state-returned Certificate Number
is a separate output, stored as the Compliance Record Registration Number only
after approval. Never substitute one identifier for the other in lookup inputs,
result staging, review comparisons, or approved write-through.

The future worker must use one dedicated helper,
`normalizeFederalTaxIdForNjBrcLookup()`, as the only location for FEIN
transformation. At website submission time only, remove formatting to obtain
digits, preserve leading zeros using string/text handling (never numeric
conversion), and append exactly three zeros. Validate that the normalized
base FEIN has nine digits before submission; invalid inputs must produce an
explicit input error, not a guessed identifier.

Queued requests snapshot the lookup submission value using that same
worker-owned helper during request preparation; the worker revalidates the
snapshot before submission. This exception is limited to operational request
storage, never contractor master storage, imports, exports, or calculations.

| Stored FEIN | Normalized base | Submitted Taxpayer ID |
| --- | --- | --- |
| `12-3456789` | `123456789` | `123456789000` |
| `001234567` | `001234567` | `001234567000` |
| `00-1234567` | `001234567` | `001234567000` |

Never save the transformed value to `federal_tax_id` or update contractor
records with it. Do not change imports, exports, compliance calculations,
reminders, NJ BRC #, or BRC Name Control. Keep identifiers out of operational
logs and use the transformed value only for submission to the official site.

NJ BRC is non-expiring: expiration remains NULL, no expiration date is required,
no reminders or 90/60/30-day follow-ups are generated, and missing expiration
must not cause a compliance penalty. Lookup failures, challenges, and No Match
must never remove existing NJ BRC information. Initial production mode is
Review Required; Auto Approve remains unverified and must not be enabled.

The worker implementation is separate under `worker\nj-brc`; see its README
for install/start, attended capture mode, manual human verification, and
sanitized local evidence. Deploy the new BRC migration only after approval,
then deploy the application, configure a distinct `NJ_BRC_WORKER_KEY` on
server and worker, and start a single visible BRC worker. Do not run duplicate
instances or start this worker before its queue and health endpoints exist.

### NJ BRC deployment gate and acceptance

1. Back up production and review `supabase\20261009_nj_brc_worker.sql`.
   Prerequisites include the existing compliance-sync schema, Worker Health
   migration, Contractor FEIN column, granular module permissions, and
   administration audit table. Apply the exact transactional SQL only after
   explicit approval using the Supabase SQL Editor or the project's approved
   SQL deployment process. No production deployment was performed by this work.
2. Verify the private request table, service-only claim/report RPCs,
   authenticated approval/rejection RPCs, restrictive review-write policies,
   review guard, and enabled `nj-brc` health row. Existing NJ PWC queue writes
   must still work. Restart the application after deploying the matching code.
3. Configure the dedicated shared worker key separately from NJ PWC. Install
   dependencies/browser using the BRC worker instructions, then start one
   visible process. Do not enable Auto Approve.
4. Use an approved known contractor for an attended request. Complete any
   challenge manually. Verify masked snapshot/evidence, Certificate Number and
   Effective Date, Review Required, and readiness acknowledgement.
5. With explicit authorization, approve one result and verify the new current
   compliance record, NULL expiration, retained prior history, decision audit,
   and unchanged three contractor identifiers. Verify rejection preserves all
   authoritative data. Synthetic tests do not claim this production acceptance.

For rollback, stop the BRC worker with Ctrl+C, stop creating BRC requests, and
disable only the `nj-brc` health row through the approved operational process.
Keep queue/evidence/history tables and completed approval records; do not drop
the migration or delete records as a rollback shortcut. Restore application
code only after checking compatibility with the BRC review-write restrictions.
Any abandoned claimed request requires an authorized investigation of its
owner and source submission before recovery; there is no blind automatic
reclaim or resubmission.

Synthetic validation commands are `node --test scripts\test-nj-brc-api.mjs
scripts\test-nj-brc-application.mjs scripts\test-worker-health.mjs`,
`node scripts\test-nj-brc-db.mjs`, and the worker's `npm run test:synthetic`.
Database tests run only in an isolated PGlite fixture (configure
`PGLITE_MODULE` if installed separately); browser UI tests use
`scripts\test-nj-brc-ui.mjs` and `scripts\test-worker-health-ui.mjs` with
`TEST_APP_URL` pointing at localhost and all data/write calls intercepted.

Contractor Detail provides Search NJ BRC; Compliance Sync exposes masked
request/certificate evidence and routes NJ BRC approval through a transactional
server operation. The NJ PWC adapter is unchanged. Three planned worker cards
remain placeholders. No schedules or reminder jobs are introduced.

Non-expiring validation found the live NJ BRC type active with
`requires_expiration=false` and zero NJ BRC rows in expiration-warning states
on October 9, 2026. Client-side NJ BRC status ignores legacy expiration values.
New approved records always use NULL expiration. Dashboard SQL and existing
reminder rules are unchanged; a legacy manually populated NJ BRC expiration
could still be evaluated by the base SQL view. Audit such data before rollout;
do not silently rewrite it or claim general reminder automation was validated
(no reminder-generation implementation exists in this project).

### Approved NJ BRC Approval Mapping

After manual approval of a validated source certificate, populate the NJ BRC
Compliance Record only:

| Compliance Record field | Approved source value |
| --- | --- |
| `registration_number` | Certificate Number |
| `effective_date` | Certificate Effective Date |
| `expiration_date` | NULL (non-expiring) |

Approval must leave all contractor master identifiers unchanged:
`nj_brc_number` (Business Entity ID), `federal_tax_id` (stored FEIN), and
`brc_name_control`. Do not copy Certificate Number into `nj_brc_number` or
the transformed website Taxpayer ID into `federal_tax_id`. This is the approved
future write-through contract, not a claim that the current approval code
already implements it.

### Attended Source Validation: Form Observed October 9, 2026

Read-only inspection of the shared browser confirmed:

- Lookup form: `form[action="/TYTR_BRC/servlet/common/BRCLogin"]`, method POST.
- Name Control: `input[name="pinnctl"]`, maximum length 4.
- Taxpayer ID: `input[name="pinidnum"]`, maximum length 12.
- Business Entity ID: `input[name="pincorpid"]`, maximum length 10.
- Separate certificate-number input: `input[name="pincasinoid"]`, maximum
  length 7; do not populate it from FEIN or Business Entity ID.
- Submit: `input[type="submit"][name="submit"]`.

The page instructs users to enter Name Control and either Taxpayer ID or
Business Entity ID for registration lookup. Certificate validation is a
separate Name Control plus certificate-number path. Do not assume all three
identifiers must be submitted together.

Source instructions require a ten-digit Business Entity ID including leading
zeros, without spaces/dashes/slashes; it is not applicable to general
partnerships or proprietorships. Name Control uses the first four characters
of the business/trade name, with hyphen padding for shorter names; spaces,
slashes, and special characters other than ampersand/hyphen are disallowed.
Keep the stored Name Control unchanged; the approved mapping is direct.

Taxpayer ID instructions require twelve digits: nine digits followed by 000
or a source-specific three-digit suffix. The approved SubTracker rule uses
000 only; do not infer a different suffix or append 000 to a twelve-digit input.

An approved human-submitted ABCO ELECTRIC LLC lookup returned a certificate.
Read-only result inspection confirmed Taxpayer Name, blank Trade Name, Address
with a continuation row, Certificate Number, Effective Date, Date of Issuance,
and a separate For Office Use Only section. Business Entity ID, FEIN, expiration,
and a separate registration-status value were not displayed on that certificate.
The result URL was `/TYTR_BRC/servlet/common/BRCLogin`.

Result selectors use exact accessible cell labels (`Taxpayer Name:`,
`Trade Name:`, `Address:`, `Certificate Number:`, `Effective Date:`,
`Date of Issuance:`) and their same-row value cells. The address continuation
belongs to the next row. For Office Use Only is separate source evidence,
never a certificate identifier. Sanitized label-only screenshot evidence was
captured locally outside source control. No source session data was exported.

Live invalid-input messages, explicit No Match wording, and challenge transitions
remain unverified. Synthetic fixtures are not proof of those live states.
Unknown/protected pages must fail explicitly, not become No Match. Do not bypass
CAPTCHA, Incapsula, or challenges.

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
   `powershell -ExecutionPolicy Bypass -File "D:\subtracker\worker\nj-pwc\start-worker.ps1"`.
   Alternatively, run `Set-Location -LiteralPath 'D:\subtracker\worker\nj-pwc'`
   followed by `npm start`. Bypass applies only to the new PowerShell process
   and avoids unsigned-script execution-policy failures; enforced organizational
   policies may still take precedence. Do not run multiple worker instances.
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
