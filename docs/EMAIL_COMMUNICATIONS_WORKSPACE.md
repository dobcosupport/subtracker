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

There is no scheduled-delivery worker in the inspected implementation. The
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
