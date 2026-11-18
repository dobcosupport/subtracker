# Email Communications workspace

## Approved production checkpoint

The previously stopped browser gate was investigated before release. At the
failure timestamps, the long-running development server repeatedly logged
Turbopack HMR subscription failures (`EcmascriptMergedChunkVersion` cells no
longer existed), immediately followed by the router-initialization error and
the `/settings` hydration mismatch. The same administration suite passed
unchanged on reproduction and against a clean production build. No obsolete
Style 3 assertion or application initialization defect was reproduced.

The regression harness now provides `scripts/test-email-release-ui.mjs`, which
starts a dedicated loopback production preview of an already-built release and
runs the unchanged administration, Email, shared composer and Style 3 suites.
It waits for explicit server readiness, checks an HTTP response, retains all
page-error assertions, fails on the first failed suite and stops its own server.
There are no automatic retries, error filters, arbitrary sleeps or application
rendering changes. This removes stale development HMR from the release gate
without weakening coverage. No second real email was sent.

The Email workspace and final Style 3 polish were approved for production on
2026-11-10. Only the reviewed migration below was applied to Supabase, after its
isolated PGlite tests passed. Its normalized SHA-256 is
`7fcaec1e0c6e9e311e634c54a2e23c9d4ffa007d610d0e70f1ef4f717622de15`.
The existing global Email switch remained ON; the new contractor/internal
switches are ON. Automation remains OFF, and contact preferences were not changed.
Existing Microsoft verification, settings revision and legacy recipient roles
were preserved.

Production Microsoft authentication was reverified without sending. One controlled
ordinary-message send, using the existing production Microsoft/Graph send route
before the redesigned UI deployment, was accepted and recorded as Sent:
`bad4af82-c5db-4437-ad3f-efd6a280e858`. The sole recipient was the approved safe
test address. The stored message and recipient have matching Sent timestamps,
the actor is recorded, the revision advanced to 3, and there is exactly one message
with the unique test subject. Graph acceptance does not prove mailbox delivery.
No connection-test email or second ordinary-message send was performed.

The local runtime does not have the production Vercel OIDC identity; it was not
used to send and no identity gate was bypassed. The redesigned direct-send
workflow, recipient controls and confirmations were validated with intercepted
browser tests; the live send validated the shared production reservation,
Graph and completion path. Browser screenshots use synthetic data.

On installations where this migration has not been applied, the real-data
workspace reports migration pending and disables Save Draft, Schedule and Send.

## Discovered architecture and controls

The existing Microsoft 365 / Graph path is retained: saved channel configuration,
Vercel OIDC identity, authentication and administrator-test verification,
revision-checked database reservation, `sendMail`, and recorded completion.
Graph acceptance is recorded as Sent, never as proof of delivery.

Read-only inspection of the live schema found:

| Existing authority | Meaning |
| --- | --- |
| `communication_channel_settings.enabled`, email row | Global email kill switch |
| `communication_channel_settings.automated_enabled` | Independent automation intent; not a prerequisite for deliberate manual messages |
| `contractor_contacts.is_active`, `.receives_compliance_email`, `.email` | Contractor contact eligibility |
| `dobco_contacts.is_active`, `.receives_internal_email`, `.email` | Dobco contact eligibility |

Separate contractor/internal master switches did not exist. The approved
[migration](../supabase/20261213_email_workspace.sql) adds
`contractor_email_enabled` and `internal_email_enabled` to the existing settings
table. Both default to true to preserve the existing global switch's behavior.
They do not turn global or automated email on, change contact preferences, or
invalidate existing Microsoft verification merely by applying the migration.

Effective ordinary business-message eligibility is determined by the shared SQL
`communication_email_exclusion` function, not by a composer-specific rule:

- Global email must be enabled.
- Dobco contacts additionally require the internal master, an active contact,
  the individual internal-email preference, and the current matching address.
- Contractor contacts additionally require the contractor master, an active
  contact, the individual compliance-email preference, and the current address.
- Unregistered external addresses require the contractor master. A raw external
  address cannot disguise an existing disabled/inactive contact or bypass the
  internal master for a known Dobco address.

The same authority supplies search explanations and read-only send assessments.
Both existing ordinary reservation entry points and the specialized reviewed
requirement-notice reservation converge on a protected common reservation that
rechecks current eligibility inside the database transaction. Contact rows and
channel settings are locked during reservation. Old drafts therefore cannot
bypass a preference changed after the draft was saved. No new hardcoded recipient
exception is introduced. Existing explicitly requested administrator connection
tests remain a separate diagnostic path; no connection test was run here.

Requirement-notice preview/identity checks, duplicate protections and delivery
outcome recording remain in their existing wrappers. SMS consent, draft behavior
and disabled delivery remain intact. General Communication Logs now opens the
same Email composer, with the existing Text Messaging workflow separately
available.

## Composer, search and history

The workspace provides New Message, Drafts, Scheduled, Sent, Templates, Contacts
and Settings. The page reuses the approved shared Style 3 application shell,
sidebar and header, with Email Communications selected. Mailbox sections use
compact bordered rows, tightly spaced inset icons, hover feedback and a blue selected state;
no counts are invented or fetched for decoration.
The Email composer uses searchable recipient chips, secondary
Cc/Bcc, Subject, optional Template and Related To, and a large plain-text message
editor. The existing Graph architecture sends plain text; the editor does not
claim unsupported HTML/rich-text delivery.

The normal Send action performs a read-only server assessment, saves the
authoritative draft internally, reserves it and sends through the existing route.
There is no required user Preview, Save Draft or review checkbox. Save Draft
remains an independent action. An uncertain save or attempted send is not
automatically retried; the user is directed to history before further action.

### Template fields and read-only Preview

The existing template engine uses case-sensitive snake_case double braces:
`{{contractor_name}}` (Company Name), `{{compliance_type}}`,
`{{registration_number}}`, and `{{expiration_date}}`. The template editor's
Insert Field controls insert the supported syntax at the Subject or Body cursor.
Contacts have a full name, not a separately authoritative first name, so the
editor does not offer a guessed Contact First Name.

Select one contractor and its compliance record in New Message, then use
Preview to render both Subject and Body from the current database records.
Preview does not save a draft, send email, or require a ready Graph connection.
Closing it and changing context requires a fresh Preview; Send always performs
a fresh server assessment. A compliance record belonging to another contractor
is rejected. Registration numbers and expiration dates are never fabricated:
a missing value remains unresolved and blocks sending with its field label.

Square-bracket labels such as `[Company Name]` are not merge syntax. Recognized
legacy labels, unknown/malformed double-brace tokens, and missing supported
values block assessment and direct manual sends before reservation or Graph.
Drafts may still retain unresolved content for editing.

### Configuration-driven template actions

`supabase/20261217_communication_template_actions.sql` and the function-only
`supabase/20261218_communication_message_followup.sql` upgrade were manually
applied successfully in Production Supabase before this release. Do not rerun
either migration during deployment; they are forward-only, not rerun-idempotent.
Release tests replay them only in isolated PGlite databases.
The migrations do not enable automation,
seed reminder templates, change Graph configuration, or update the real 90-Day
template's Follow-Up settings.

Templates store editable purpose text, Active and **default** Follow-Up creation,
status, delay in days and subject. Existing/new templates default to Follow-Up
OFF. These are starting values, not mandatory actions. Template names and purpose labels never control
rendering, scheduling, eligibility or delivery. Existing notification intervals,
current-revision approval, eligibility and master controls remain authoritative.

Every New Message exposes **Create Follow-Up after successful send** between
Related To and Message, even with no template. Selecting a template loads its
defaults; the user can enable, disable or edit the final message choice. Clearing
the template restores the no-template OFF defaults. Enabled choices include
status (initially Open), relative delay or a fixed calendar date, subject and
the authoritative Related To context. The same Insert Field catalog is available
for the message Follow-Up Subject. Unresolved enabled Follow-Up fields block
Preview, Send and Schedule; disabled Follow-Up subjects are not required.

The explicit `followup` message configuration is validated in TypeScript and SQL
and saved inside the existing communication snapshot, including without a
template. Draft reopening restores that message choice, not today's template
defaults. For notice generation without an explicit composer choice, the same
resolver loads template defaults into the message snapshot. Neither path adds
a separate delivery or Follow-Up engine.

If an exact Compliance Record is selected, it is retained; otherwise the
Follow-Up links only the selected Contractor. Multiple contractors/records must
be narrowed before enabling Follow-Up creation. The existing Follow-Up model
requires a Contractor and has no Project foreign key: Project context remains
on the originating communication (and is referenced in the Follow-Up notes),
without fabricating a direct Project link or Compliance Record. Project-only
Follow-Up creation is explicitly rejected. Change context using Related To.
The stored legacy template related-item preference is retained for compatibility;
actual message relationships, not that preference, determine the final linkage.

The shared `communication_template_context` resolver supplies authoritative
contractor, exact compliance record, recipient/contact, project and imported
policy values. Manual Email assessment and requirement-notice preview use the
same resolver and `renderMessage` renderer. Company selection never selects an
arbitrary compliance record. Contact data is re-read by ID; client display names
are not merge authority. A separate `first_name` is usable only if the contact
model actually supplies it, never by splitting a full name. The current editor
therefore offers Contact Name, not an inferred Contact First Name.

The template-only database functions from `20261217_communication_template_actions.sql`
must be upgraded with `20261218_communication_message_followup.sql` before using
per-message Follow-Ups. The upgrade changes functions only; it does not change
Email Settings, Microsoft verification, template defaults, reminder rules or
existing message/action snapshots. The original migration retains the verified
connected template-only function bodies so fresh-chain and upgrade tests cover
the same transition as the connected database. Existing template-only snapshots
remain readable/recoverable using their frozen defaults.

Live assessment requires an explicit database-assessed `followup` object and
rejects missing or changed message choices with HTTP 503 rather than silently
falling back to template defaults. Legacy fallback is only for reading frozen
snapshots. Preview displays the assessed status, timing, rendered subject and
authoritative compliance type/registration label. The assessed message choice
is also returned in `draft.followup` for Send/Schedule persistence.

When an Email draft is saved/generated, `context_snapshot.template_render`
captures the final message Follow-Up choice, reviewed template configuration
(when selected), authoritative merge values, contractor/record/project IDs
and recipient identity. Existing untouched legacy messages acquire no new actions.
Scheduled content is final, not re-merged with a later template. Dispatch and
scheduling validate the final Subject/Body plus the snapshotted Follow-Up Subject;
the database also rejects literal tokens at planning and the common reservation.
Old square-bracket placeholders are recognized as unresolved, not supported syntax.

Graph acceptance is committed as Sent before attempting the optional Follow-Up.
The existing completion function records a pending `communication_followup_actions`
entry only for accepted messages whose snapshotted message choice is ON. This is recovery bookkeeping, not a
second Follow-Up system. The actual row is in `contractor_followups`, uniquely
identified by `origin_communication_id`, and linked through existing
`communication_followups`. It retains the exact originating contractor/record.
Relative due dates use the accepted date in America/New_York plus the configured
days, independent of draft/schedule time. A specific date stays fixed, even if
acceptance occurs later; it does not create any Follow-Up before acceptance.

A record-creation failure persists `recoverable` and its error without changing
Sent. The worker retries only these actions (bounded to 20 per invocation);
message history also exposes **Retry Follow-Up only (no email)** to Delivery
Manage users. Neither recovery path calls Graph. Row locking, a unique message
action and a unique Follow-Up origin prevent duplicate creation. Frozen history
permits only the matching generated link after acceptance; other edits remain
blocked. Company Merge snapshots/locks recognize the new dependency and preserve
its original accepted-message identity.

### Follow-Up Email Sent audit date

Follow-Up views derive **Email Sent** read-only from the originating successful
Email communication's `sent_at`; Follow-Up Date remains a separate due date.
No timestamp is copied into `contractor_followups`, and editing a Follow-Up
never submits this audit value. Existing communication links work without a
backfill. An explicit `origin_communication_id` takes precedence; for legacy
records without one, the earliest successful linked Email is used. Only
Sent/Delivered Email with a timestamp and the same contractor is eligible;
manual Method = Email alone, failed messages and SMS do not supply a date.
Dates use America/New_York, matching acceptance-relative Follow-Up calculations.

The read-only `/api/followups/email-origins` projection requires Follow-Ups and
Contractors View and returns only communication identity/timestamp, not email
content or recipients. Read failures remain explicit. Modal, contractor workspace,
right rail, dashboard/work queue and activity history share the projection.
**View Sent Email** reuses the existing communication detail view and independently
requires Communications Content or Delivery View. It does not copy email bodies.
The Email History post-send Follow-Up section also labels its authoritative
successful-send date. No migration or delivery/automation change is needed.

`node --test scripts/test-followup-email-sent.mjs` verifies the authoritative
ABCO-shaped 11/17/2026 acceptance → 12/17/2026 due-date separation, legacy links,
non-email exclusions, time-zone boundaries, permissions, pagination and errors.

Validation:

- `node scripts/test-communications-db.mjs` runs existing communications and
  Scheduled Email coverage plus the real resolver/notice preview/renderer,
  isolated SQL and mocked Graph acceptance/failure/recovery/replay tests, including
  no-template ON/OFF, both template-default overrides, fixed-date/relative timing,
  exact/no-record linkage, Project context and scheduled ON/OFF snapshot immutability.
- `node --test scripts/test-nj-brc-reliability-db.mjs` replays the full migration chain.
- `TEST_APP_URL=http://localhost:3000 node scripts/test-template-architecture-ui.mjs`
  intercepts every API/provider mutation. Optional `TEST_SCREENSHOT_DIR` captures
  editor/Follow-Up defaults, New Message choices, ABCO rendering and mock outcomes. ABCO values
  were read-only verified; configuration/recipient/delivery are local fixtures.
  The selected ABCO record is not a real 90-day candidate.

The approved confirmation policy is one recipient with no extra confirmation;
multiple selected recipients with exactly one eligible/excluded confirmation.
Excluded recipients are not saved into the sent population. Reservation checks
again before Graph is contacted, so changed preferences fail closed rather than
silently changing the confirmed send.

Search reuses existing Dobco and contractor contacts and the existing contractor
identity search. Company/project search results expand into existing contacts;
project expansion uses active `contractor_projects` assignments, not an invented
contact-project association. Searches are bounded and debounced. Selections above
100 contacts require narrowing, never silent truncation into a send. No separate
stored All Employees group was found or invented.
Entering a complete email address also offers the existing manual external
recipient type; this does not create a contact and cannot bypass the shared
master/contact controls.

Contractor recipients retain the parent contractor relationship required by the
existing save function. Related project, compliance, Follow-Up, requirement,
myCOI and insurance associations already on drafts remain in the submitted model;
no alternative compliance or insurance authority is created.

History lists Date, Recipient, Subject, Type and Status. Details show stored
content, recipient roles, related labels and available delivery outcomes. Sent
also offers Failed, Cancelled and Skipped filters. Summary View alone never gains
Subject, recipient addresses or content: those additions require Content View.
Delivery-only reads expose role and delivery metadata, not content or addresses.
The existing Settings permissions govern contact/template administration.
Contractor contact maintenance remains in the existing contractor directory.

## To / Cc / Bcc persistence

`communication_recipients.recipient_role` is a constrained `to | cc | bcc` field,
defaulting existing recipients to `to`, their actual previous Graph behavior.
There is no parallel recipient database. The save wrapper strips this new field
before invoking the existing strict save chain, then persists roles on the same
recipient records in the same transaction.

Roles survive draft editing, scheduled plans, frozen Sent/history records and
delivery reads. Existing history guards freeze the role with the recipient
snapshot once a draft leaves Draft. The common reservation returns the persisted
role; the Graph adapter serializes separate `toRecipients`, `ccRecipients` and
`bccRecipients`. Bcc is not copied into To or Cc.

The existing maximum remains 100 recipients TOTAL across all three roles.
Case-insensitive duplicate addresses across roles are rejected. SMS does not gain
Cc/Bcc.

## Scheduling limitation

The locked production checkpoint below remains plan-only. A separate local,
uncommitted scheduled-worker implementation is described in
[Scheduled Email delivery](SCHEDULED_EMAIL_DELIVERY.md). Its migration and
trigger are not applied/activated. The UI now reports actual runtime capability,
including pending migration and disabled/unhealthy processing, rather than
unconditionally promising either automatic delivery or plan-only behavior.

There was no scheduled-delivery worker in the locked production checkpoint. The
existing planning RPC and route explicitly return `execution_enabled: false`.
The redesigned Date / Time / Time zone dialog stores a future instant using the
browser's named local zone or UTC. Scheduled, confirmation and success text state
that these are plans only and will not send automatically. Cancellation uses the
existing revision-checked planning path. No scheduler or worker is added.

## Migration review risks for further installations and rollback

1. Apply only after separate approval and after the preceding communication and
   requirement-notice migrations. The migration is transactional and forward-only,
   following the existing migration convention. Do not run it twice.
2. Table ALTERs require deployment-time locks. Choose an appropriate maintenance
   window and take the normal database backup. There are no new production-data
   fixtures, contact changes, automatic sends, cron jobs or new indexes.
3. Default-true child switches preserve current delivery behavior under the
   existing global switch; they are not an opt-out rollout. Administrators must
   intentionally disable a child switch if desired.
4. Existing drafts with newly disabled, inactive or changed recipients will now
   be blocked at reservation. This is intentional enforcement, including reviewed
   notices. Re-select the current contact rather than altering frozen history.
5. Saving settings advances the existing shared revision. A child-switch-only
   change carries forward an already Verified / Accepted-by-Graph connection only
   when every other configuration value is unchanged; otherwise disabling one
   recipient type would inadvertently block both. Untested, failed, unknown and
   in-progress connections are never promoted. Global/provider/sender/identity
   changes retain existing verification invalidation. No live verification/test
   email is automatic.
6. The code and migration must be coordinated. The new composer fails closed
   until its migration is available. The old production code must not be used to
   edit newly created Cc/Bcc drafts after a rollback: it does not understand roles.
   Do not drop the role column or discard newly recorded delivery history.
7. Historical Bcc recipients are visible only to authorized application
   content/audit readers, not to To/Cc email recipients. Existing independent
   summary/content/delivery permissions remain authoritative.

## Validation

The following validations passed:

- `node scripts/test-communications-db.mjs`: all prior isolated communication,
  template, Microsoft, data-foundation and requirement-notice checks, plus the
  workspace migration rollback, legacy preservation, switch truth tables,
  permitted cross-type sends, actual settings-RPC child-switch independence and
  retained global verification invalidation, changed preferences/addresses, raw
  address bypass prevention, roles, 100-recipient boundary, scheduling, frozen
  audit and private-function checks.
- `node scripts/test-communications.mjs`: real server authentication/permission
  guards with synthetic clients, strict parsing, search/source permissions,
  content-projection isolation, pending migration, fail-closed assessments,
  template merges and existing administration regressions.
- `node scripts/test-microsoft-email.mjs`: mocked Microsoft OIDC/Graph send,
  role serialization, reservation/revision checks, replay prevention, definite
  and unknown outcomes; no real outbound provider calls.
- `scripts/test-email-communications-ui.mjs`: intercepted unified workspace,
  direct Send, one bulk confirmation, exclusions, optional Draft save/reopen,
  roles, templates/project association, plan-only scheduling/cancel, history,
  settings, permission gates and uncertain-save handling.
- `scripts/test-communication-compose-ui.mjs`: general logs reuse the same
  Email composer; SMS consent, personalization, frozen snapshots and Draft-only
  behavior remain unchanged.
- Existing communications administration and shared Style 3 shell browser
  regressions, TypeScript, scoped ESLint, whitespace checks and an isolated
  production build.
- `node scripts/test-email-release-ui.mjs`: all four browser suites against the
  same clean production snapshot. Set `TEST_BUILD_DIR` to the build's application
  directory when validating an isolated snapshot; otherwise the repository's
  production build is used. `PLAYWRIGHT_MODULE` may point to the existing worker
  Playwright installation. No packages are installed by this runner.

Mocked tests do not constitute live-send evidence; the separate controlled-send
evidence is recorded above. The final production build used an isolated snapshot
of HEAD plus only the approved Email files, excluding the 24 unrelated
working-tree changes. Read-only live verification confirmed all three masters ON,
Microsoft authentication Verified at settings revision 4, the original controlled
message still Sent at revision 3 with one recipient, one matching test subject,
and zero subsequent messages to the safe recipient. No settings, contact
preferences, schema or production communication records were changed during
the stopped-gate investigation.

## Changed-file list

Only these Email checkpoint files are in scope; the 24 pre-existing unrelated
working-tree files are excluded:

- [Migration](../supabase/20261213_email_workspace.sql)
- [Email workspace page](../src/app/email-communications/page.tsx)
- [Shared application shell route selection](../src/components/AppShell.tsx)
- [Composer](../src/components/EmailComposer.tsx)
- [History](../src/components/EmailHistory.tsx)
- [Style 3 workspace styles](../src/components/email-workspace.module.css)
- [Shared composer entry point](../src/components/CommunicationComposer.tsx)
- [Existing logs entry point](../src/components/CommunicationLogsPanel.tsx)
- [Existing channel settings](../src/components/CommunicationChannelSettings.tsx)
- [Workspace server helpers](../src/lib/server-email-workspace.ts)
- [Strict communication parsing](../src/lib/communications.ts)
- [Graph adapter](../src/lib/server-email-provider.ts)
- [Shared client errors](../src/lib/communication-compose-client.ts)
- [Unified recipient search](../src/app/api/communications/email-recipients/route.ts)
- [Read-only assessment](../src/app/api/communications/email-assessment/route.ts)
- [Email history](../src/app/api/communications/email-history/route.ts)
- [Existing compose options](../src/app/api/communications/compose-options/route.ts)
- [Existing channel-settings API](../src/app/api/admin/communication-settings/[channel]/route.ts)
- [Existing content/edit API](../src/app/api/communications/[id]/route.ts)
- [Existing draft API](../src/app/api/communications/[id]/draft/route.ts)
- [Existing delivery API](../src/app/api/communications/[id]/delivery/route.ts)
- [Existing send API](../src/app/api/communications/[id]/send/route.ts)
- [Communication types](../types/communications.ts)
- [Compose types](../types/communication-compose.ts)
- [Workspace types](../types/email-workspace.ts)
- [Database test entry point](../scripts/test-communications-db.mjs)
- [Workspace database tests](../scripts/test-email-workspace-db.mjs)
- [API tests](../scripts/test-communications.mjs)
- [Microsoft tests](../scripts/test-microsoft-email.mjs)
- [Workspace browser tests](../scripts/test-email-communications-ui.mjs)
- [Shared composer/SMS browser tests](../scripts/test-communication-compose-ui.mjs)
- [Production-rendered browser release gate](../scripts/test-email-release-ui.mjs)
- This documentation file.
