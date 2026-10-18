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

## COI / myCOI Insurance - Step 1

The contractor card's **COI / myCOI Insurance** section is read-only. It shows
separate myCOI vendor contacts, project-specific imported status, policies, and
source/timestamp details. Empty contacts are omitted. Raw division names and
superseded records remain available under **myCOI Details / History**; the
compact display uses the existing SubTracker project number/name.
**Legacy / Manual Insurance** and existing Company History retain legacy values.
Legacy dashboard, compliance, follow-up, export, and general workbook-import
behavior is unchanged. Imported status does not replace legacy calculations.

Apply `supabase\20261021_mycoi_foundation.sql` after the existing schema and
user-management migrations, before deploying the card change. This additive
migration does not update, relabel, backfill, or delete existing data. It adds:

- `mycoi_vendor_mappings`: exact source vendor names and separate email/phone,
  contractor references, import provenance, and unique active trimmed/case-folded
  vendor-name keys. Multiple vendor aliases may reference one contractor.
- `mycoi_division_mappings`: exact division names, generated leading-number
  hints, and nullable references to existing projects. Multiple naming
  variations may reference one project. NULL means unresolved; never infer
  the project relationship from the hint alone.
- `mycoi_contractor_divisions`: vendor/division-specific compliance status,
  provenance, and current/historical state, without changing project assignments.
- `mycoi_policies`: policy line/number, nullable expiration and source-supplied
  expired flag, provenance, and current/historical state. No issue/effective
  date is manufactured. Complete current policy identities are unique by
  contractor, whitespace-normalized/case-folded line, trimmed/case-folded
  number, and expiration. Missing identity values require review, not
  type-only deduplication. Multiple legitimate policies per line are allowed.
- `mycoi_policy_divisions`: many-to-many policy/division relationships,
  constrained to the same vendor mapping.

All new tables use existing insurance View/Add/Edit permissions and RLS through
`public.user_has_module_permission(text, text) RETURNS boolean`.
No generic audit triggers are installed: production does not provide the
repository's `audit_application_change` function. Existing server actions write
`administration_audit_log` through `writeAdministrationAudit`; the existing
workbook importer separately writes `import_history`. Step 2 must use those
application-level patterns for import/mapping audit events and history, with
explicit error handling. No myCOI audit-write workflow exists in Step 1, and
direct table writes do not automatically create audit entries. The specialized
NJ PWC audit helper is not used.
Authenticated hard deletes are disabled: retire mappings with `active=false`; supersede imported status/policy
rows with `active=false,is_current=false` before inserting their replacements.
Future import execution must preserve old policy/status values, use transactions,
record source references, and retain raw mappings used by historical rows.
Company Name remains authoritative in SubTracker under the accepted NJ PWC
workflow; myCOI must never update it or general company contact fields.
Mapping review controls are not on the contractor card.

Step 2 extends the existing Import / Export area, as documented below,
for the exact headings **Division Name**, **Vendor Name**, **Vendor Email**,
**Vendor Phone**, **Compliance Status**, and **Policy Expiration Dates**.
No myCOI parser, upload, mapping review, exception workflow, or import execution
was included in Step 1. The existing general Insurance template remains legacy,
not a myCOI import.

Validation uses synthetic data only:
`node scripts\test-mycoi-db.mjs`,
`node scripts\test-mycoi-service.mjs`, and
`TEST_APP_URL` with `node scripts\test-mycoi-ui.mjs` against an isolated localhost
preview. The UI test intercepts database/auth requests and blocks mutations.
PGlite and Playwright must be available, like the existing database/UI tests.
The migration is not automatically applied to a live database.

## COI / myCOI Insurance - Step 2

**Import / Export > myCOI Insurance Import** is a dedicated, manual workflow;
the contractor card remains read-only. Upload a values-only XLSX (one worksheet)
or CSV with exactly the six headings above, once each, in any order. Limits:
3 MB upload, 5,000 source rows, 4 MB expanded review JSON. Unknown/missing/extra
headings, nontext values, formulas, and error cells are rejected explicitly.
Source strings are preserved, including punctuation, whitespace and HTML
entities. The real source workbook is ignored by Git; fixtures in tests are synthetic.

### Observed policy serialization

The supplied local report was inspected read-only: 1,099 data rows, all 1,099
policy cells strings, 120 blank cells, 979 populated cells, 4,250 policy entries,
and no populated policy cells containing valid JSON. A synthetic equivalent:

```text
policyNumber: SYN-1 (AZ, MA); expirationDate: 06/01/2027; isExpired: false; policyLines: General Liability, Rigger's Liability, policyNumber: SYN-2 &amp;; expirationDate: 06/01/2025; isExpired: true; policyLines: General Liability
```

Only comma + optional whitespace + `policyNumber:` starts another entry.
Fields occur in the exact observed semicolon-delimited order. Commas inside
policy numbers are preserved. `policyLines` is a comma-separated scalar list,
not an array; split it only after recognizing the complete policy entry.
Policy numbers containing literal `&amp;` remain literal (not HTML-decoded).
Dates must be real `MM/DD/YYYY` calendar dates and become SQL `date` values;
expired flags must be literal lowercase `true`/`false`. Apostrophes in coverage
names are valid. Blank cells contain no policies; they never erase stored data.
JSON/array syntax, literal null, malformed/truncated entries, ambiguous fragments,
and invalid dates/flags require review, without evaluation or guessed repairs.
Every staged row retains all six exact source strings and its original row
number for reviewing unsupported variants. No issue/effective date is created.

### Review, persistence and execution

- Vendors group by space-trimmed, case-folded exact source name, matching the
  foundation's generated PostgreSQL keys (raw tabs are not silently discarded). Active saved mappings
  are reused; otherwise punctuation-normalized name suggestions show their
  reason, but require the solid **Accept Match** button. Case-insensitive exact
  names take priority over punctuation-normalized suggestions and show **Exact Name Match**;
  ambiguous exact names require contractor selection. Contractor choices sort by
  case-insensitive Company Name, then ID; project choices sort naturally by Project
  Number, then Project Name and ID. Neither ordering changes the stored names.
  **Choose Different
  Contractor** selects an existing contractor without accepting it; **Accept
  Match** stages that selection. **Leave Unmatched** keeps the vendor unresolved
  without blocking ready vendors. No fuzzy auto-acceptance or contractor creation.
- Divisions retain their full raw name; a leading project number automatically
  stages a project only when exactly one existing `project_number` matches
  exactly. If no exact candidate exists, exactly five leading digits may match
  the unique `YY-NNN` equivalent (`22002` to `22-002`). No project-name similarity,
  numeric coercion or broader punctuation normalization is used. Duplicate exact
  candidates block fallback. Saved active mappings take precedence and are reused. Unknown,
  missing or ambiguous numbers require explicit review. No master renames,
  new projects, contractor assignments, or automatic contractor creation.
- Contacts remain on vendor mappings only. Nonblank useful values can update
  them; blanks preserve them. Placeholder email (including
  `VendorAsAgent@mycoitracking.com`), conflicting contacts and malformed phone
  values require choosing an exact safe source value or retaining existing
  contacts. Phone strings are not split, repaired, or reformatted.
- Preview shows row/vendor/division/policy/contact/change counts, Ready to
  Import, Vendor Review Required, Project Review Required and Policy Parse
  Errors, plus explicit contact/source issues. Edit mappings, fix a source
  value in a replacement report, leave unresolved, or explicitly ignore a
  source record with its raw context. Ignored rows can be restored before
  execution. Review actions automatically save staged decisions and refresh the
  server preview. Each vendor shows Matched/Ready to Import and its remaining
  project, contact, policy or source blockers. No manual mark-ready step is needed.
  Import Ready Vendors shows the ready-vendor count and is disabled at zero.
  Failed saves remain explicit and prevent import until retried or reloaded.
  Buttons and badges use a local CSS module with explicit colors, spacing,
  font weight, hover/focus and disabled states. Primary actions are solid blue,
  alternate-selection controls slate, and neutral actions filled light gray.
  Vendor/project matching actions share an equal-height horizontal flex row
  with consistent gaps, wrapping only when the available width cannot fit them.
  Vendor actions appear in the card header beside the identity/contact summary,
  before blockers, projects and insurance. Accepted staged matches show compact
  confirmation and Change Contractor; saved mappings retain their read-only confirmation.
  Automatically matched projects show compact green confirmations without
  review buttons; their permanent mappings are saved only by import execution.
  Every unresolved division is shown directly inside its vendor card with the
  full source division, detected number and existing-project suggestions.
  Choosing another project is local selection only; Accept Project Match is
  required to stage it. Accepted divisions collapse to confirmed project lines.
  Browser regression tests assert computed colors, AA text contrast and visible
  keyboard focus, not just utility-class presence.
  Per-source-row insurance tables show the existing parser's policy lines,
  numbers, expiration dates and Current/Expired source flags, even before
  mappings are accepted. The preview exposes those already-computed parser
  results; the UI does not reparse raw strings. Complete original rows and
  parser errors remain in collapsed Source Details disclosures. Parse failures
  are prominent outside the disclosure and still block readiness as before.
- A vendor is ready only when all its nonignored rows are safe. Import Ready
  Vendors commits just ready vendors; other vendors remain durable exceptions.
  Resume an earlier run from myCOI Import History. No supported workflow silently
  discards exceptions. Mapping acceptance becomes permanent on execution.
- Policies aggregate across every eligible vendor row, not just its first row.
  Multiple numbers per line, multiple lines per policy and multiple divisions
  are supported. Identity is vendor mapping + normalized line + normalized
  number + real expiration. Exact repeats share one policy and retain their
  division links. Distinct expirations are retained when explicitly reported.
  Same-number/line replacements absent from the new report become historical;
  flag/status changes retain the old values. Missing coverage never causes a
  blanket deletion. Nonexpired policies sort first; source flags are preserved.
- Status remains vendor + division-specific, using existing compact project
  names on the card; no contractor-level compliance status is derived.

### Migration, audit and permissions

Apply `supabase\20261022_mycoi_import_workflow.sql` after the deployed
`20261021_mycoi_foundation.sql`, before deploying Step 2 code. It creates
`mycoi_import_runs` (raw rows, decisions, revision, actual cumulative metrics,
imported row/vendor/policy identities, actor, timestamps and import-history FK).
It adds no columns to existing tables and migrates/deletes no legacy data.
One blocking Step 1 edge case is corrected: current policy uniqueness now
uses **vendor_mapping_id**, not contractor_id. The composite policy/division
FKs require vendor ownership, so contractor-wide uniqueness could not represent
two source aliases sharing a contractor without inventing vendor statuses.
Only that partial unique index is replaced; the five foundation tables and all
their constraints/FKs/RLS remain. Multiple vendor aliases safely retain their
own source/project associations.

The migration adds service-only `mycoi_import_reference()` and
`mycoi_apply_import(uuid,integer,text,jsonb,jsonb,uuid)` RPCs. The server
authenticates the active user and requires imports/insurance/contractors/projects
View plus imports/insurance Add and Edit for changes (existing system-admin
override). SQL rechecks the actor's active status and permissions. Authenticated
staging reads require imports and insurance View; staging mutation/deletion and
both RPCs are denied to ordinary authenticated/anonymous clients. No foundation
RLS is weakened. Service-role access is server-only.

The server recomputes plans and actor-labelled application audit payloads;
it never trusts client mutation plans. Atomic execution uses a per-run row
lock, advisory importer lock, revision and reference snapshot checks. Data,
`import_history`, stored counts and `administration_audit_log` events commit
together or all roll back. Audit actions are `MYCOI_MAPPINGS_ACCEPTED` and
`MYCOI_IMPORT_APPLIED`, using the existing application audit fields. The RPC
inserts the application-generated events transactionally rather than calling
the standalone nontransactional `writeAdministrationAudit` wrapper.
No generic audit triggers, invented audit function, or NJ PWC audit helper.

History shows original source row count, last actual import time (Not imported
for staging only), distinct imported vendor keys/policy IDs, actual meaningful
changes, unresolved source-row count and stored status. Counts reflect the
last applied execution, not staged decisions. Timestamp/provenance refreshes
are not counted as changes. Ignored counts/raw decisions remain stored;
`import_history.notes` also records actual metrics and the run reference.
Reimporting an identical report adds an intentional import-history run, but no
duplicate current mappings/policies or artificial change count.

### Deployment and manual acceptance

1. Back up production; apply only the Step 2 SQL in Supabase. Do not rerun the
   already-applied foundation migration. Verify the new table/RPC permissions.
2. Commit/review/push the application, migration, tests and docs when authorized;
   allow the normal Vercel production deployment. No worker restart is needed.
3. Confirm existing contractor names, ordinary contacts, project names/numbers,
   legacy insurance/history and compliance values are unchanged.
4. Upload the real report in Import / Export; verify the six headers, 1,099 rows,
   4,250 parsed policy entries and zero policy syntax errors for the inspected
   report. Review actual vendor/division matches and contact exceptions before
   accepting anything. Parsed source entries and unique policy-line identities
   are different metrics and need not match.
5. Accept a known vendor/project, retain useful contacts when placeholders are
   present, import only ready vendors, and verify unresolved vendors survive
   reload/resume. Check history, import_history and administration audit events.
6. Verify multiple policies/lines, expired history, ISO expiry dates and compact
   project-specific statuses on that contractor's read-only card. Reimport the
   same report: reuse mappings, verify zero meaningful changes and no duplicates.
7. Verify blank contacts retain prior values, a new expiration retains history,
   and an imports/insurance viewer cannot upload, save review or execute imports.
8. Exercise the existing general import/export templates and contractor workflows.

Run `node scripts\test-mycoi-import.mjs` (isolated PGlite), and
`node scripts\test-mycoi-import-api.mjs` (real handlers with isolated adapters).
With an isolated localhost production preview, set `TEST_APP_URL` and run
`node scripts\test-mycoi-import-ui.mjs` and `node scripts\test-mycoi-ui.mjs`.
Browser tests intercept external requests and writes; no production mutations.
The parser test optionally reads the supplied local workbook and verifies its
SHA256 is unchanged without printing source values. No real workbook is committed.
No 90/60/30 reminders, schedules, mailbox/watchers or worker jobs are added.

The contractor COI / myCOI panel groups current policies by their existing mapped
project relationships. Shared policies appear under each linked project; unassigned
current policies remain in Other / Unassigned Insurance. Attention-required projects
expand by default; Compliant Finalized projects without expired source policies collapse.
Raw divisions, provenance and available superseded records are shown only in the
collapsed myCOI Import History subsection of Company History. No new history is inferred.

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

## Communications Step 4 - Dobco Contacts

**Application Settings > DOBCO CONTACTS** is a separate internal address book,
not User Management. Apply `supabase\20261024_dobco_contacts.sql` before using it.
The migration creates only `dobco_contacts`, its indexes, RLS, and an updated-at
trigger. It does not copy users, change `user_profiles`, or depend on a generic
database audit function. It is not automatically applied to production.

Contacts have independently maintained name, optional email/mobile, Active status,
internal email/SMS preferences, and explicit SMS consent/date/note. Preferences and
consent default to false. A phone number never enables SMS or manufactures consent.
The optional `user_profile_id` link does not synchronize identity or account status;
contacts without any login are fully supported. Removing an account clears its
optional link, not the contact.

The compact list shows names and permission-controlled Edit actions. Add (`+`),
settings, consent, activation/deactivation, and the optional user link use the
Add/Edit form. Inactive contacts remain listed. No delete operation is exposed.
Edit includes compact Save Contact, Deactivate/Activate, and Cancel actions.
Deactivate/Activate changes only the saved contact's status; use Save Contact
to persist other form edits.

Existing `settings:view` allows reading; `settings:manage` authorizes creating and
updating contacts through server-only administration APIs. Assigning a new user
link additionally requires `users:view` and an existing profile. The existing
system-administrator override is preserved. Authenticated database clients have
RLS-controlled SELECT only; there are no client write grants or policies. Only
the server service role has contact INSERT/UPDATE access, behind API permission
checks, strict field allowlisting, contact-ID validation, and optional FK checks.
Administration audit events use the existing `writeAdministrationAudit` helper;
as in existing User Management, those application-level audit writes are separate
from the contact mutation. Audit failures surface as errors, not success.

Future email eligibility is active + nonblank email + internal email preference.
Future SMS eligibility is active + nonblank mobile + internal SMS preference +
recorded consent. These rules are informational recipient checks only; future
delivery must recheck current settings. No compose, Select All, recipient groups,
delivery/history tables, automation, email/SMS sending, or ACS configuration exists.
User Management, Contractor Contacts, and other operational systems are unchanged.

Synthetic checks: `node scripts\test-dobco-contacts.mjs` and
`node scripts\test-dobco-contacts-db.mjs` (requires PGlite, or `PGLITE_MODULE`).
The database test runs the real migration in an isolated in-memory database;
it never applies SQL to Supabase.
For browser checks, use `TEST_APP_URL=http://localhost:<port>` with
`node scripts\test-dobco-contacts-ui.mjs` (Playwright or `PLAYWRIGHT_MODULE`).
The browser uses a separate synthetic session and intercepts all API/auth
requests; it never writes live contacts or users.

## Communications Step 5 - Configuration and authoritative history foundation

Step 5 adds **installation-level**, not multi-tenant, configuration. Another
installation can maintain its provider, sender name/address, reply-to, domain,
SMS number, enablement, and automation intent through **Application Settings >
Email / Text Messaging**, without editing source. Email and SMS persist
independently. No sender/domain/phone/Azure-resource values are seeded.
General, Notifications, and both address books retain their previous behavior.
The existing Notifications schedule is still display-only; it is not a
Communications engine or rule source. Future reminder intervals must come from
editable Administration configuration, not constants or existing reminder rows.

The new forward-only migrations, in order, are:

1. `supabase\20261025_communications_permissions.sql`
2. `supabase\20261026_communications_foundation.sql`
3. `supabase\20261027_sms_twilio_provider_option.sql`
4. `supabase\20261028_user_invitation_email_configuration.sql`

All four migrations are **confirmed applied to production Supabase** by the
installation administrator at Step 5 finalization. Read-only production REST
checks also verified the Communications permission modules, tables and public
RPC availability, including invitation configuration. The Twilio constraint's
application is administrator-confirmed; REST does not expose CHECK constraints
or exact migration execution history. Each script is transactional.
They require the existing role/administration tables and the completed Contractor
Contacts, Dobco Contacts, and myCOI foundations. They neither alter business-record
tables nor depend on a generic database audit function. Existing roles receive
denied Communications rows, except the repository's established Administrator
bootstrap. The existing system-administrator override is unchanged.

### Permission and API boundaries

| API | Required permission | Returned data |
| --- | --- | --- |
| `GET /api/communications` | Communications Summary - View | Date, channel, direction, source, status, contractor/project labels, recipient count, generated non-sensitive description; optional validated `contractor_id` filters parent messages before pagination |
| `GET /api/communications/:id` | Communications Content - View | Exact body, subject, sender and recipient snapshots, related record IDs; no delivery/provider fields |
| `POST /api/communications` | Communications Content - Add | Creates manual outbound Draft; returns ID/status/revision only |
| `PATCH /api/communications/:id` | Communications Content - Edit | Replaces an existing manual outbound Draft only; returns ID/status/revision only |
| `GET /api/communications/:id/delivery` | Communications Delivery - View | Provider, provider identifiers, status/timestamps/failure details; no body, subject, sender address or recipient destinations |
| `GET /api/admin/communication-settings/:channel` | Settings - View | Nonsecret saved configuration and derived status |
| `PATCH /api/admin/communication-settings/:channel` | Settings - Manage | Saves nonsecret configuration; no Communications Content access implied |

Roles & Permissions exposes Summary View, Content View/Add/Edit, and Delivery
View separately. Content Add/Edit do not select or require Content View.
Communications delete is unavailable. Existing unrelated permission-grid
behavior is preserved. Cloning the protected Administrator role preserves all
applicable Communications actions without copying its unused delete flags.
Contractor or Settings access never implies message
history/content access. Navigation permits independently authorized capabilities;
without Summary View, authorized content/delivery viewers can look up a known
communication ID without requesting history rows.

All new tables have RLS enabled and **no anon/authenticated grants or policies**.
There is no client-readable full-message view. Server APIs authenticate Active
accounts, enforce the specific module/action, and use explicit field projections.
Only the service role may SELECT these tables. Mutations go through
service-role-only, fixed-search-path database functions which independently
validate the verified actor, module/action, IDs and related-record ownership.
The actor ID is taken from the authenticated server context, never client input.
Direct service-role INSERT/UPDATE/DELETE grants are also withheld.

### Configuration and credentials

Enablement flags record intent, not an operational delivery capability. All
connection/send tests and Replace Credential remain disabled.
**Credential Configured: No** is always truthful: there is no credential writer,
secret column, ACS SDK, connection, endpoint, key or client-visible secret.
Status is derived from persisted settings: untouched rows are **Not Configured**;
partially or fully entered administrative fields are **Configuration Incomplete**
because credentials/connector testing are unavailable. **Ready for Connection
Testing** is reserved for a future secure connector and is unreachable in Step 5.
The UI never claims Connected, Authenticated, Verified or Operational.

The future connector must use an approved server-side secret store, write-only
Administration replacement action and a server-only secret reference resolver.
It must not add plaintext client-readable credential columns, expose values
through APIs, or use `NEXT_PUBLIC` credentials. No fake secret-reference facility
is implemented here.

Settings saves use revision checks to reject stale writes and the existing
administration audit helper, recording field names only. As with existing
administration mutations, audit insertion is a separate transaction: a failed
audit returns an error even if configuration persisted. Reload before retrying.

### Authoritative messages and snapshots

Messages support email/SMS, inbound/outbound, manual/automated, exact body,
nullable subject, sender snapshot, provider metadata, creator/sender references,
all lifecycle timestamps, revision, and database-constrained
Draft/Queued/Sending/Sent/Delivered/Failed/Cancelled status.
Recipients are separate snapshots with explicit destinations, nullable contact
references, independent delivery state/provider identifiers and timestamps.
Changing either address book or current sender configuration never rewrites
stored messages/recipients. No contact preferences, consent or identities are
changed by this foundation.

Separate FK-backed relationship tables support multiple contractors/projects,
compliance records, myCOI policies, and legacy insurance item references without
copying business records. Compliance/myCOI/insurance items must belong to linked
contractors; contractor-contact references must belong to a linked contractor.
Creating those links additionally requires View access to the relevant existing
business module; Dobco contact links require Settings View. Contact records are
not required for explicitly supplied external destination snapshots.

Draft creation/update takes `channel`, nullable `subject`, exact `body`,
`recipients`, `contractor_ids`, `project_ids`, `compliance_record_ids`,
`mycoi_policy_ids`, and `insurance_items`. Arrays are required, may be empty
except recipients, and are limited to 100 entries each. Recipient fields are
`recipient_type` (`contractor_contact`, `dobco_contact`, `external`),
`recipient_name`, nullable `email`/`mobile_phone`, and nullable matching
`contractor_contact_id`/`dobco_contact_id`. Insurance references use
`contractor_id` and existing `item_key`. Updates also require the current
`revision`. Unknown fields, spoofed actor/status/provider IDs/timestamps,
invalid IDs, mismatched ownership and stale revisions fail explicitly.
Each save is atomic across message, recipients and relationships.

Draft saves never queue/send, generate provider IDs or populate delivery
timestamps. Only Draft records may be edited, and there is no send/status/delete
endpoint. A future sender must recheck then-current recipient eligibility and
SMS consent and freeze exact final body, sender and destination snapshots before
leaving Draft. Drafts are not proof of delivery eligibility.
Future reminder occurrences can link to the authoritative message ID through
a dedicated FK relationship when that occurrence model is approved. No fake
occurrences, unvalidated reminder IDs, existing reminder migration, schedules
or automation are introduced.

**Administration > Logs** contains **Audit Logs** and **Communication Logs** tabs.
Audit search, action filters and data remain unchanged. Tabs and data requests
are independently permission controlled: Audit View does not grant Communications
access, and Communications access does not grant Audit View. The existing
`/admin/audit` URL hosts Logs; `/communications` redirects to its Communication
Logs tab for compatibility. There is no standalone Communications sidebar item.
Communication Logs reuses the authoritative Step 5 history with pagination,
channel/source/status filters and permission-specific Content and Delivery details.
No duplicate log table or backend change is involved.

Email/Text Messaging provider selection displays the selected provider's
configuration below it. Saved provider selection restores that presentation.
Azure Communication Services fields are grouped into General, Sender,
SMS-only Messaging, and Connection. Connection shows **Credential Status:
Not Configured** and the status derived from saved settings, even while form
edits are unsaved. Provider controls request no credentials; Replace Credential,
Test Connection and test sending remain disabled.

Twilio is a recognized future **SMS-only** provider. Its selection persists through
the same authorized, revision-checked settings API and RPC. The additional
transactional migration changes only the channel-settings provider constraint:
ACS remains available to both channels; Twilio is accepted only for SMS.
No existing values, permissions, message records, snapshots, or RLS are changed.
The UI reports **Connector Status: Not Implemented** and **Credential Status:
Not Configured**. Switching providers preserves non-sensitive sender/messaging
settings; enablement is configuration intent, never delivery capability.
No Twilio SDK, credentials, credential inputs, or provider calls exist.

### User Management invitation email boundary

The Email tab includes a separate **User Management Email** configuration form.
These settings are installation-level future intent, not overrides of external
Auth settings. Account administration remains in User Management.
Communications Email Enabled and sender/provider configuration do **not**
currently control authentication invitations.

The existing invitation path is:

1. Administration > User Management > Add User > Send Invitation calls
   `POST /api/admin/users`, requiring `users:manage`.
2. The server validates input/role and uses its Supabase admin client to call
   `auth.admin.inviteUserByEmail(email, { data, redirectTo })`. The installed SDK
   sends this request to Supabase Auth `/auth/v1/invite`, not ACS or Twilio.
3. Metadata contains name, role, optional Entra identifiers/group, and
   authentication source. The redirect is `new URL("/invite", APP_URL)`.
4. After Auth succeeds, the server creates the Active user profile and writes
   the existing administration audit record. Profile creation failure invokes
   the existing Auth-user cleanup.
5. Re-Invite > Send calls `POST /api/admin/users/:id/re-invite`, under the same
   permission. It verifies existing Active/pending-or-never-logged-in eligibility,
   updates user metadata, invokes the same Auth invitation method/redirect,
   updates invitation counters/timestamp, and audits.
6. `/invite` consumes the Supabase session, lets the user set a password through
   Supabase Auth, signs out, then redirects to `/login`. This flow is unchanged.

Server configuration uses `NEXT_PUBLIC_SUPABASE_URL`, the server-only
`SUPABASE_SERVICE_ROLE_KEY` (Auth admin authorization, not an SMTP credential),
and `APP_URL`. Browser Auth uses the existing public Supabase URL and anonymous
key. No invitation sender, Reply-To, SMTP password, or email-provider credential
is passed by these invitation routes or returned in Communications settings.

Supabase Auth owns actual delivery, sender/from address, Reply-To behavior,
sending domain, SMTP/provider credentials, URL allowlisting and deployed email
templates. The repository does not establish which SMTP provider or sender is
currently configured in the hosted project; these must be verified by its
administrator, without exposing secrets. Supabase may use its configured mailer
or an externally configured mail integration; selecting ACS here does not
replace that path.

`supabase/config.toml` supplies the invitation subject
**You're Invited to Access SubTracker** and references
`supabase/templates/invite.html`. This repository template contains SubTracker
product text, **Dobco Group** company wording/logo alt text, and the hard-coded
logo URL `https://subtracker-one-pied.vercel.app/Logo.png`; its activation link
uses Supabase's `{{ .ConfirmationURL }}`. The `/invite` landing page also contains
Dobco Group branding, independently of the email. No sender/from or Reply-To is
hard-coded in either invitation API. The deployed hosted template may differ
from the repository copy.

**Stop boundary:** do not reroute invitations, substitute sender values, expose
SMTP secrets, or pretend Administration settings override Supabase Auth.
Another installation must configure its sender/domain (including verification),
Reply-To where supported by its mailer, organization wording/logo and invitation
subject/body in the secure Supabase Auth/template deployment boundary, and set
`APP_URL`, Auth Site URL and allowed redirects for its host. This requires
provider/template deployment configuration, not changes to invitation API
source. The existing company-specific landing-page branding remains outside
this email-configuration refinement. No new Administration setting changes
invitation identity or delivery behavior.

### Provider-independent invitation configuration foundation

`user_invitation_email_settings` is a singleton, non-secret installation
configuration table, independent of recipient/message history. Its
forward migration adds no authentication/user-profile changes and modifies no
existing Communications permissions. Like channel settings, it has server-only
reads, no anonymous/authenticated grants or RLS access, and service-only
revision-checked mutations that independently verify an Active actor with
Settings Manage permission.

`GET /api/admin/invitation-email-settings` requires Settings View.
`PATCH` requires Settings Manage, validates a strict field allowlist, and audits
changed field names (not template contents/values). No provider secret or
credential property is accepted or projected. Save/audit failures surface errors;
because audit is a separate transaction, reload before retrying a failed save.

The form persists:

- Invitation Email Enabled (future intent, initially true to represent the
  existing invitation capability; not an operational kill switch in Step 5).
- Invitation Delivery Mode: `supabase_auth` (default) or
  `application_email_provider`.
- Organization Name, Application Name, Invitation Subject.
- Application Base URL (HTTP/HTTPS origin) and local absolute Invitation Path.
- Non-sensitive Invitation Template, Sender and Reply-To references.
- Optional editable Invitation Template Draft (up to 10,000 characters).

All installation-specific text, URLs and references start unset, not seeded
with company names, hosts, subject text, sender addresses or reply-to values.
Saving future mode or disabling the intent flag **does not change** the active
Send Invitation/Re-Invite actions; they still call the existing Supabase Auth
path described above. The form makes this distinction explicit in both modes.
Main Email channel enablement and invitation enablement remain independent.

`invitationDeliveryPlan` is a pure configuration/adapter-planning boundary.
It identifies the configured adapter and truthful status (Supabase:
Externally Managed; Application Email: Not Implemented), while reporting
`active_delivery_mode: supabase_auth` and `configuration_only: true` in Step 5.
It performs no I/O or dispatch. Current invitation handlers intentionally do not
consume these settings yet, so configuration cannot accidentally reroute or
disable the approved production flow.

Future integration point: after User Management performs its existing
authorization, input validation and invitation eligibility checks, a delivery
dispatcher can select a **Supabase Auth Adapter** or **Application Email
Adapter** using the saved mode. The latter will use the main Administration
Email provider and resolved non-secret references, with credentials remaining
server-side. A trusted identity-provider boundary must supply the invitation
URL; a template must not generate authentication tokens. That dispatcher,
adapter implementation, enablement enforcement, identity lifecycle coordination
and rollout are future work, not operational Step 5 functionality. No call to
`inviteUserByEmail` has been replaced or wrapped.

Template draft convention reserves `{{organization_name}}`, `{{invitee_name}}`,
`{{invitation_url}}`, and `{{application_name}}`. Drafts are stored verbatim,
never interpreted as HTML, rendered, previewed or sent. A future renderer must
define escaping and URL validation before use. The template reference allows a
future installation-managed template instead of an inline draft; resolution
precedence is deliberately not implemented.

The current Supabase template's company wording/fixed logo host and the
invitation landing page's company branding are legacy/current-installation
branding, not defaults for this new architecture. They remain unchanged and
must become installation-configurable when the future deployment path is
implemented. The existing invitation APIs contain no company sender/domain
constants. Application delivery will not require Supabase as its email mailer;
this foundation does **not** provide non-Supabase authentication or abstract the
identity provider itself.

New Message is visibly disabled: draft persistence is API-only foundation, not
a compose screen. No sending, template rendering, Select All, bulk messaging, incoming
webhooks, retries, Follow-Up integration, ACS, or background worker exists.
User Management/authentication, contact-book behavior, compliance, COI/myCOI,
Compliance Sync, and PWC/BRC workers are unchanged.

### Contractor-centric operational timeline

**Operations > Contractor Activity Log** reuses `/activity-log` with contractor
search/selection and a newest-first timeline composed at read time from
`activity_log`, `contractor_followups`, and the existing Communications summary
projection. No records are copied, created, or synchronized between sources.
No migration or history table is added.

`GET /api/activity-log/contractors` requires `activity:view` and exposes only
contractor ID/name for selection, including inactive contractors; it does not
grant access to contractor master/contact details. Search and pagination are
server-side. `GET /api/activity-log?contractor_id=<id>` requires `activity:view`;
it independently checks `followups:view` and `communications_summary:view`
before querying those sources. Activity access alone never returns Follow-Ups
or Communications. Source read failures are explicit errors, not empty success.

The timeline reads existing Follow-Up ID, date, method, subject, status and
related-item label without notes or new management controls. A Follow-Up whose
method is Email or Text is not proof that SubTracker sent a message. The
Contractor Card remains the place to Add/Edit, change status, resolve/close,
work Active Follow-Ups and view Follow-Up History; none of that workflow changes.

Communication entries reference their authoritative message ID and include
only the approved safe summary fields. Filtering uses an inner
`communication_contractors` embed before pagination, while retaining complete
contractor/project labels from the ordinary summary projection. The shared
summary reader enforces Communications Summary View for both administrative
history and the operational timeline. View Details/Delivery Details call the
existing independently authorized Content/Delivery APIs. No recipient
destinations, message body, provider IDs or failures appear in summary responses.
Administration > Logs remains unchanged.

Activity/Follow-Up dates are date-only; their timeline position is midnight UTC
on the recorded date, with creation timestamp and stable source/ID tie-breaks.
Communication position is its creation timestamp. Each page merges up to 51
rows per authorized source and returns the newest 50. Per-source positions
advance only for returned entries, so Load Older Entries does not skip records
from another source. As with ordinary offset pagination, refresh the timeline
after concurrent source edits or inserts.

### Synthetic validation

- `node scripts\test-communications.mjs`: real server authentication/permission
  guards with synthetic clients, API projections, independent capabilities,
  request validation, configuration errors and permission-grid persistence.
- `node scripts\test-communications-db.mjs`: real migrations and database
  functions in isolated PGlite, rollback, denied defaults, grants/RLS, ownership,
  revisions, atomic failures, statuses and immutable historical snapshots.
- `$env:TEST_APP_URL='http://localhost:<port>'; node scripts\test-communications-ui.mjs`:
  Playwright with a separate synthetic browser session, intercepted APIs/auth,
  configuration persistence, saved status, view-only/error states, history
  filters and independent Content/Delivery/role-grid behavior.
- `node scripts\test-communications.mjs` also tests activity source authorization,
  contractor-scoped Communications queries before pagination, and multi-source
  pagination without gaps/duplicates or writes.
- `$env:TEST_APP_URL='http://localhost:<port>'; node scripts\test-contractor-activity-ui.mjs`:
  intercepted contractor selection/search, timeline source visibility,
  chronological paging, permission-specific details, errors and contractor changes.
- Existing `node scripts\test-active-followups.mjs` and the intercepted
  `scripts\test-followup-related-items-ui.mjs` exercise Contractor Card
  Add/Edit/status/Active/History behavior without changing live Follow-Ups.

Use existing PGlite/Playwright installations or `PGLITE_MODULE` /
`PLAYWRIGHT_MODULE`. Tests never apply migrations to Supabase, send messages,
configure Azure or mutate live contacts/users.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
