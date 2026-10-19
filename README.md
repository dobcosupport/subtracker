This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

### Vercel production OIDC -> Azure Key Vault

The existing server-only Key Vault provider supports explicit
`AZURE_KEY_VAULT_AUTH_MODE=vercel_oidc`. Official `@vercel/oidc` supplies
`getVercelOidcToken()` to Azure Identity's `ClientAssertionCredential` callback.
The callback obtains the current request's token when Azure needs an assertion;
no token is cached in application settings, written to a file, logged or returned.
The same SecretClient and credential get/set/status interface remain authoritative.

Configure these **server-only Production environment variables** in Vercel:

| Variable | Value |
| --- | --- |
| `SUBTRACKER_KEY_VAULT_ENABLED` | `true` |
| `AZURE_KEY_VAULT_URL` | `https://subtracker-keyvault.vault.azure.net` (confirm the vault URI in Azure) |
| `AZURE_KEY_VAULT_AUTH_MODE` | `vercel_oidc` |
| `AZURE_TENANT_ID` | Directory/Tenant ID for the server identity |
| `AZURE_CLIENT_ID` | Application/Client ID of SubTracker Server |

Do not prefix these with NEXT_PUBLIC. Vercel production does **not** need
AZURE_CLIENT_SECRET, certificate/token files, an ACS connection-string environment
variable, or any stored Azure authentication password. Enable Vercel OIDC token
availability with the **team issuer** in the project's OIDC settings. Vercel
provides/refreshes its runtime token; do not manually copy it into configuration.
The default audience is retained: no custom audience option and no
`api://AzureADTokenExchange` override.

For this installation, the provisioned Entra federated credential must match:
issuer `https://oidc.vercel.com/dobco`, subject
`owner:dobco:project:subtracker:environment:production`, audience
`https://vercel.com/dobco`. These deployment identifiers are documentation,
not application business logic. Entra validates the assertion. The server
identity needs vault RBAC secret get/set access and network reachability.
Preview/development deployments need their own deliberately provisioned federation;
the Production federation does not authorize them.

Official package `@vercel/oidc` is a runtime dependency. Deploy the build and
Production environment configuration together when authorized; this task does
not deploy or perform a real token exchange. Live identity/RBAC/network success
must be verified after deployment without exposing tokens or secret values.
Key Vault availability is not ACS connectivity or carrier approval. Configure/
Replace still accepts ACS credentials only through the protected Administration
endpoint; SMS/automation stay OFF unless deliberately enabled separately.
Test Connection and Send Test SMS remain disabled.

### Step 6E: ACS SMS configuration and verification

Administration -> Text Messaging retains ACS and future/alternative Twilio.
The ACS-only informational notice reads: "Azure Communication Services SMS retires
September 30, 2028." It does not disable configuration or alter message status.
SMS Sender Phone Number remains an installation setting; no production sender,
endpoint, resource, credential or carrier status is seeded.

`supabase\20261101_acs_sms_verification_configuration.sql` follows the Step 6D
migration. The operator confirmed it successfully applied to production during
the OIDC continuation. Do not reapply it; this authentication change needs no
additional migration and does not execute production SQL.
It adds only `sms_verification_status` to existing channel settings and a
Settings Manage/revision-protected writer wrapper. Existing settings audit
conventions record the changed field names. Status defaults to Not Recorded,
with Not Submitted, Submitted / Under Review, Approved and Rejected available.
These are administrator-recorded carrier/toll-free states, not live ACS results.
Save a changed sender before recording its status; changing the sender invalidates
the old status at the server boundary, including for older clients.

The connection panel shows the saved verification separately from unsaved edits.
Pending/rejected/unknown verification never appears Ready for Testing. A saved,
enabled ACS provider, E.164 sender, administrator-recorded approval and available
credential establish configuration readiness only, never Verified or production
readiness. No live SMS adapter, connection test or dispatch is implemented:
Test Connection and Send Test SMS remain disabled even with complete settings.
Future delivery must additionally enforce Settings Manage, real connection
verification, current carrier eligibility and existing recipient/consent rules.

Credentials still use the server-only Key Vault abstraction, never normal
settings or credential responses. No ACS page-load verification request is added.
Configure/Replace accepts a one-time password input submitted only to the
Settings Manage-protected credential endpoint. The input is cleared before the
request completes and is never populated with a stored credential. SMS Enabled
and Automated SMS Enabled may both remain OFF while credentials are Configured
and carrier verification is Submitted / Under Review (or Approved). Credential
storage and carrier status changes never enable either switch.

Credential entry requires operator-provisioned Key Vault access:
`SUBTRACKER_KEY_VAULT_ENABLED=true`, `AZURE_KEY_VAULT_URL`, and
`AZURE_KEY_VAULT_AUTH_MODE` with a server Entra identity. Environment mode uses
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and a securely provisioned client secret or
certificate; workload identity uses tenant/client IDs and a deployment-managed
`AZURE_FEDERATED_TOKEN_FILE`; managed identity requires a supported Azure host.
The identity needs secret get/set permission and network access to the vault.
Without these prerequisites the UI truthfully shows Unavailable and disables
credential entry; no database/browser/plaintext fallback is provided. Deployment
identity credentials and the ACS connection string must be configured through
their secure operator/application flows, never chat or tracked files.
Email, contacts/consent, authoritative Communications, Compose/Templates,
invitations and notification automation behavior are unchanged.

### Step 6D: Microsoft 365 / Office 365 Email foundation

Administration -> Email recognizes `microsoft_365` (Microsoft 365 / Office 365)
and `azure_communication_services` (ACS). SMS choices remain ACS and future
Twilio; Microsoft 365 is rejected for SMS in API, credential and database paths.
Provider switching uses the same authoritative Communications, snapshots,
permissions and Logs. It does not rewrite existing Draft/sent provider or sender
snapshots, reset notification master flags or change invitation delivery.

Apply `supabase\20261031_microsoft_365_email_foundation.sql` after the preceding
Communications migrations, including Steps 6A/6C. At the Step 6 checkpoint,
read-only production REST schema inspection confirmed the expected objects from
all three Step 6 migrations (20261029, 20261030, 20261031). This verifies exposed
schema signatures, not a migration execution ledger; development did not apply
production SQL. It adds nullable non-secret installation
`microsoft_tenant_id` and `microsoft_client_id` fields and an Email-only provider
option. Tenant/client IDs accept Entra UUIDs or blank during configuration.
The service-only Settings Manage writer keeps revision checks and preserves
hidden provider-specific configuration when switching providers. Existing
sender/Reply-To fields remain shared installation Email configuration.

The Microsoft-only panel contains General enablement, sender name/mailbox and
Reply-To, Tenant ID and Application/Client ID. It does not show ACS Sending
Domain or SMS settings. It reuses the same server-only Key Vault provider with
the separate stable secret reference `subtracker-microsoft-365-email`.
The configure/replace workflow currently accepts an application **client secret**,
not a certificate; certificate-based authentication may be added to the same
server adapter boundary later. Saved credentials never enter normal settings,
logs/history/audit payloads, browser storage or status responses.
No Graph/authentication SDK or delivery package was needed for this foundation.

Credential status requests include an explicit provider selector. Saves require
Settings Manage and a matching saved channel provider so a stale provider
selection cannot write to another provider's secret. Missing infrastructure
shows Unavailable, not Configured. All existing Key Vault provisioning and
server-identity requirements from Step 6B also apply to this third secret.
No tenant, client, sender, domain or secret value is hard-coded for an installation.

`src\lib\email-provider.ts` describes adapter/authentication and configuration
readiness; `src\lib\server-email-provider.ts` is the future server adapter
preparation boundary for Microsoft application authentication and ACS connection
strings. The latter retrieves credentials only through the shared Key Vault
interface, never through browser settings. It has no token acquisition,
Graph/ACS network call, test or dispatch. No new Communications database exists.

Non-secret Email/SMS settings are editable and persist through **Save Settings**
without Key Vault, including the selected provider. **Unsaved Changes** tracks
ordinary edits separately from connection status. Microsoft application IDs are
in the ordinary settings section; credential controls have a separate connection
section. Unavailable credential storage blocks only credential configuration.

Saved Email enablement, valid Tenant ID/Client ID (Microsoft only) and a sender
mailbox determine non-secret completeness. Configuration Status is **Incomplete**
until complete, **Credential Required** without an available configured credential,
then **Ready for Testing**. SMS uses saved enablement and sending phone number.
This is configuration readiness, not an operational test. Connection Status
remains **Not Verified**. Verified and Test Failed are reserved for a future actual
provider test and cannot be fabricated by saving settings. Test Connection and
Send Test Email remain disabled even when configuration is ready. Future tests
must require Settings Manage and all readiness conditions; future test sending
must additionally require a real successful verification tied to the current
configuration/credential.

Application Email Provider invitations remain provider-independent and may
eventually use whichever Email provider is selected. Current Supabase Auth
invitation/re-invite behavior is unchanged. Compose/Templates work without
Microsoft or Azure infrastructure. No reminder scan, generated communication,
queue, Email or SMS transmission is introduced.

The existing synthetic Communications API/database/UI suites cover Microsoft
configuration, Email-only validation, permission/revision checks, independent
vault references, sanitized failures, server adapter preparation, readiness
gates and unchanged historical snapshots. No live Microsoft, Graph, ACS,
Twilio or Key Vault credentials/calls are used.

### Step 6C: manual Draft composition, preview, and templates

Apply the new forward-only
`supabase\20261030_communication_templates_compose.sql` **after** the Step 5
migrations and `20261029_notification_configuration.sql`. Its expected production
schema objects were confirmed read-only at the Step 6 checkpoint; development
did not execute production SQL. It adds a server-only template
table, optional template references on existing Communications and reminder
rules, and guarded wrappers around the established atomic mutation functions.
Historical migrations and contact tables are unchanged. No templates are seeded,
no messages are generated, and automation master settings are not reset.

Administration -> Logs -> Communication Logs now provides **New Message** for
Communications Content Add and **Edit Draft** / direct Draft ID lookup for
Content Edit. These permissions do not imply Summary View, Content View, or
Delivery View. The editor-only read endpoint exposes only manual outbound
Drafts, never Sent/non-Draft records. Existing Content/Delivery detail readers
retain their independent permission checks.

Compose supports Email, SMS, or both; choose one/multiple contractors and their
contacts, one/multiple Dobco Contacts, related contractors for internal alerts,
and optional projects/compliance context. Existing source permissions remain:
Contractors View for contractor contacts/relationships, Projects View for
projects, Compliance View for compliance context, Settings View for Dobco
Contacts. Dobco Contacts never require an account/user link. Source endpoints
return minimal explicit columns, not contact notes, consent notes or user
identity fields; paged directory reads are fully collected before Select All.

Active contact, channel destination and channel receive preference are required
for selection. SMS additionally requires recorded consent. Select All Eligible
Dobco Contacts evaluates the chosen channel, never silently includes inactive
contacts, and explicitly rejects more than 100 recipients. Contractor receive
preferences are the existing Receive Compliance Email/SMS flags; internal
preferences are Receive Internal Email/SMS. Database mutation guards recheck
live eligibility and exact snapshots for newly selected contacts so a client
cannot forge a destination/name or bypass consent. Future sending must recheck
eligibility again; a frozen Draft snapshot is not delivery authorization.

**Preview -> Save Draft** is manual and cannot send. Each new recipient/channel
gets a separate existing authoritative Communication, allowing exact per-person
template resolution and separate Email/SMS text without a second history
system. Preview shows destinations, relationships, subject where applicable,
exact editable final plain text, intended provider and sender. Every save is
explicit and individually reports its authoritative ID. A failed/uncertain save
is not automatically retried; check Communication Logs before composing again.
No batch atomicity or idempotent replay is claimed.

Draft recipient snapshots do not refresh when a contact changes. Edit retains
those values and the existing sender/provider snapshot for the same channel.
The explicit reselect/refresh control loads current contacts and requires a new
eligible selection. Revision checks and existing Draft/manual/outbound-only
database restrictions remain authoritative. Unsent Drafts still appear as
Draft in Communication Logs but are excluded **before pagination** from the
operational Contractor Activity Log; Activity and Follow-Up composition is
otherwise unchanged.

Administration -> Templates supports add/edit/activate/deactivate with Settings
Manage, Settings View for administration reads, revision checks and existing
administration audit conventions. There is no permanent-delete workflow or
delete grant. Template wording, names, channels and categories are configuration,
not production constants; no company-specific wording is seeded. Templates are
plain text (not HTML or executable code). Applying a template copies resolved
text into the Draft; later template edits do not rewrite stored message content.
Referenced template channels cannot change; deactivation preserves history and
existing references while excluding the template from new selections.

Supported literal merge fields are listed in the template editor. Contact data
has a single `contact_name`: first/last names are deliberately not guessed.
Contractor name comes from authoritative `company_name`; projects use existing
project number/name; optional compliance fields use the existing
`contractor_compliance_status` view without new status/expiration calculations.
Organization/Application names reuse saved installation configuration.
Missing/ambiguous context leaves the exact placeholder and a visible unresolved
warning. Manual users can edit final preview text before saving. No fabricated
names, dates, compliance statuses or days-until-expiration are supplied.
Unresolved Drafts may be saved as unfinished work but are not ready for future
sending. Future automated use must reject unresolved or malformed fields.

Reminder configuration now has separate Email/SMS template foreign keys with
channel validation; the legacy optional free-text reference is preserved.
Inactive template references remain visible when already saved. These are
configuration references only: no expiration scans, reminder rendering,
automatic Drafts, queue, workers or sending. Channel/master safety gates remain.

No Azure infrastructure is needed for Draft/template workflows. Existing Key
Vault unavailable state and disabled ACS Test/Send controls remain truthful.
Twilio remains Connector Not Implemented. Supabase invitations are unchanged.

Validation: `scripts\test-communications.mjs` covers permissions/source
projections/merges/eligibility/API failures; `scripts\test-communications-db.mjs`
adds isolated Step 6C migration, lifecycle, references, consent and snapshot
tests. `scripts\test-communication-compose-ui.mjs` runs intercepted localhost
multi-channel compose/preview/save/edit/template scenarios. The existing
Notifications UI suite also verifies channel-specific template persistence.
All fixtures are synthetic; provider/queue/invitation calls are blocked.

### Step 6B: Azure Key Vault credential boundary (infrastructure gated)

ACS Email and SMS credentials use the same server-only provider on every host:
`src\lib\server-provider-credentials.ts`. Its get/set/status operations use official
Azure Identity and Key Vault Secrets libraries. Stable secret names are
`subtracker-acs-email` and `subtracker-acs-sms`; provision a separate vault for
each installation/environment to prevent cross-installation replacement.
Replacing a connection creates a new vault secret version. No secret is stored
in Supabase, application logs, audit payloads, browser storage, or settings.
Only the transient password input and authenticated HTTPS submission carry
the entered value; the field is cleared before awaiting the save response.
Saved values are never returned to the browser.

Required **server-only infrastructure**, not configured by this change:

- Node.js 22 or newer, as required by the installed Azure SDK dependencies.
- An Azure Key Vault URL in `AZURE_KEY_VAULT_URL` (HTTPS public Azure vault).
- `AZURE_KEY_VAULT_AUTH_MODE`: `vercel_oidc`, `environment`, `workload_identity`, or
  `managed_identity`. No developer-login credential fallback is used.
- For `environment`, provision an Entra application/service principal with
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` (or the
  certificate configuration supported by Azure EnvironmentCredential).
  This mode is for separately provisioned server identities, not Vercel production;
  never use `NEXT_PUBLIC` variables for identity credentials.
- For `workload_identity`, provision federation and the Azure SDK's
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_FEDERATED_TOKEN_FILE`.
  The deployment must supply and refresh that token file; this change does not
  use Vercel runtime tokens. Vercel production uses `vercel_oidc` instead.
- For `managed_identity`, provision an Azure-hosted server identity; optional
  `AZURE_CLIENT_ID` selects a user-assigned identity. A Windows machine outside
  Azure must use a separately provisioned supported identity, not assume a
  managed identity exists.
- Grant the server identity secret get/set access to the two named secrets,
  with least-privilege vault RBAC/access policy and appropriate network access.
  Enable vault soft delete/purge protection and review retained secret versions.
- After infrastructure/access is verified, explicitly set
  `SUBTRACKER_KEY_VAULT_ENABLED=true`. Keep it unset until provisioned. The same
  Administration interface applies to Vercel and in-house deployments.

`GET /api/admin/communication-settings/:channel/credential` requires Settings
View and returns only a configured boolean. `PUT` requires Settings Manage and
a saved ACS provider; it accepts only `{ credential }` and returns only status.
Both use no-store responses and sanitized errors. A missing secret is Not
Configured; missing infrastructure or denied vault access is explicitly
Unavailable, never a misleading successful status. Failed replacement does not
delete the prior version. Hosting/APM request-body capture must be disabled for
this secret endpoint; do not enable Azure SDK HTTP body logging.

No vault/identity access has been supplied or live-tested. Consequently
Configure/Replace is unavailable without a successful vault status read.
ACS connection testing and test sending are deliberately **not implemented**
under the infrastructure stop condition; controls remain disabled even after a
credential is stored. A stored credential is never labeled Verified. Future
test adapters must persist non-secret test status/time and authoritative
Communication/sender/recipient snapshots before controlled sending, and must
never infer Delivered from provider acceptance. Twilio remains Not Implemented.
No automation, reminder generation, or master-toggle changes occur here.

`node scripts\test-communications.mjs` tests real authorization and credential
operations using synthetic Azure adapters only; it cannot contact Key Vault or
ACS. The intercepted Communications UI regression verifies unavailable controls.

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
The Step 5 Notifications schedule was display-only; Step 6A replaces it with
the persisted configuration foundation documented below. There is still no
Communications engine or runtime reminder scheduler.

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

## Step 6A - Notifications configuration foundation

Administration > Settings > Notifications persists installation-level reminder
rules and exposes independent **Automated Email** / **Automated SMS** master
controls. It does not scan expiration dates, generate Communications drafts,
create queue items, dispatch messages, start workers, or contact providers.

Apply `supabase\20261029_notification_configuration.sql` after the four Step 5
migrations. Its expected production schema objects were confirmed read-only at
the Step 6 checkpoint; development did not execute production SQL. It creates
only reminder configuration and two
service-only configuration functions. It does not alter compliance, non-expiring
NJ/NY BRC handling, contact books, Follow-Ups, Activity/Communication Logs,
invitation behavior, permissions, existing workers, or message tables.

Initial 90/60/30 offsets are seeded as database configuration rows with both
Email and SMS **false**. They are not application/runtime constants and are
never recreated by page loads. Installations can edit, add or remove intervals,
including removing every rule. Days Before Expiration must be a positive int32.
There is **no Active column, checkbox, or independent activation state**:

- Email OFF + SMS OFF = **Inactive**.
- Either channel ON = **Active configuration**, not operational delivery.
- Clear both channels to deactivate while preserving the rule; removal requires
  confirmation and deletes configuration only, never Communications/history.
- A partial unique index prevents duplicate **active** expiration offsets,
  including simultaneous conflicting saves. Inactive duplicates are allowed.

Rules have revision, created/updated timestamps and optional non-secret template
reference. References are future identifiers only; the invitation-specific
template draft is not reused as a reminder renderer. No rendering, recipient
lists, provider choice, company template or generated message is stored here.

Master flags reuse `communication_channel_settings.automated_enabled`: the
Email/Text Messaging tabs and Notifications edit the **same saved controls**,
not competing copies. Step 5 defaults are OFF; the migration leaves any
explicitly saved values intact. Saving masters changes only those flags,
revisions and update metadata, atomically across both channels; sender,
provider and other configuration remain unchanged. Concurrent changes from
another tab cause an explicit revision conflict requiring reload.

`reminderIsActive` and `reminderChannelConfigured` are pure configuration checks.
The latter requires both a rule channel and that channel's master ON. Neither
is a send authorization or delivery implementation. All API loads explicitly
return `execution_enabled: false`. Future Email/SMS execution must additionally
check channel enablement, an operational/configured provider, eligible
recipients, valid required message data, and SMS consent/eligibility where
applicable. There is no path from configuration saves to message generation.

API boundaries:

- `GET /api/admin/notifications`: Settings View; persisted rules and minimal
  automation flags/revisions only. Missing migration/read failures are errors,
  not display defaults or empty-success fallbacks.
- `PATCH /api/admin/notifications`: Settings Manage; atomic master flags.
- `POST /api/admin/notifications/reminders`: Settings Manage; create rule.
- `PATCH /api/admin/notifications/reminders/:id`: Settings Manage; edit with revision.
- `DELETE /api/admin/notifications/reminders/:id`: Settings Manage; confirmed
  configuration removal with revision.

Reminder tables have RLS enabled and no anon/authenticated access; service role
has SELECT but no direct mutation grants. SECURITY DEFINER functions use a fixed
search path, independently verify the Active actor's Settings Manage permission,
validate inputs and enforce revisions. APIs take actor IDs from verified
sessions, not request bodies. Administration audit entries record actions/field
names; audit failures are explicit even if the separate configuration transaction
persisted. Reload configuration before retrying any failed save.

Validation:

- `node scripts\test-communications.mjs` includes Notifications API access,
  validation, error handling and the full master/channel configuration truth table.
- `node scripts\test-notifications-db.mjs` uses isolated PGlite for the real
  migration/functions, rollback, defaults, preservation, CRUD, duplicate active
  offsets, concurrent-revision protection, grants/RLS and unchanged history.
- `$env:TEST_APP_URL='http://localhost:<port>'; node scripts\test-notifications-ui.mjs`
  intercepts every auth/API request and rejects draft/queue/invitation/provider
  calls while exercising configuration, permissions, persistence and errors.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
