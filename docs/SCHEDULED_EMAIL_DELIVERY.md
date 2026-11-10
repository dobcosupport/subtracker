# Scheduled Email delivery

## Status and scope

This is the separate, uncommitted scheduled-delivery implementation after locked
Email checkpoint `1e8773b0f6e554282ef7ff725bd17604705a6ea1`. The reviewed migration
was applied to Supabase on 2026-11-10 with processing OFF. After resolving the
Microsoft connection-readiness gate through the existing authorized tests, the
exact-scope candidate reached Production READY and the Windows trigger was
verified with processing OFF before activation. The single authorized automatic
delivery, three subsequent duplicate checks and dynamic Automatic Delivery
OFF/ON checks passed. The initial Windows trace-file and browser release stops
were investigated as documented below. A fresh exact-scope production build,
all four production-rendered browser suites and the remaining release gates
now pass. Processing and the Windows task are paused for the final committed
deployment, read-only smoke and authorized empty-queue reactivation.

The approved workspace styling, manual-send workflow, contacts, associations,
templates, Graph adapter, and communication history remain the foundation.
The 24 unrelated working-tree files are outside this change.

## Architecture and portability

```
Replaceable trigger
  -> processScheduledEmail(Supabase client)
  -> atomic Supabase lease
  -> current saved Email configuration / shared delivery readiness
  -> atomic final reservation and current SQL eligibility
  -> shared deliverReservedEmail
  -> existing sendMicrosoftEmail adapter
  -> token-checked completion and existing communication history
```

The service is [server-scheduled-email.ts](../src/lib/server-scheduled-email.ts).
It has no Vercel API imports, OIDC token acquisition, environment lookups,
scheduler expressions, recipient construction, or hosting identity assumptions.
It can be called by another server-side adapter using the same trusted Supabase
client. It never accepts a caller's recipient list, settings snapshot or send
status.

The HTTP trigger is
[the protected cron route](../src/app/api/cron/scheduled-email/route.ts).
It authenticates a bearer secret, calls the service and returns aggregate counts.
It contains no Graph or eligibility logic. Windows Task Scheduler wakes this
route once per minute using the protected launcher described below. There is
no Vercel Cron configuration, plan upgrade or Vercel-specific scheduling logic.
There is no Supabase cron, SQL HTTP call, browser poller or always-running
process. An idle trigger makes one claim RPC and one current-status RPC, not a
series of heartbeat and empty-queue requests. Due work uses the existing partial
`communication_messages_schedule(scheduled_at,id) WHERE status='Scheduled'`
index and bounded batches.
Two partial indexes on the new state table cover pending work and unfinished
claims, avoiding repeated scans of completed scheduling history.
Eligible work is ordered by its next-check time before scheduled time so old
blocked messages cannot repeatedly jump ahead of unprocessed due messages.

The current Graph authentication adapter still uses the already-working Vercel
OIDC path. That dependency is confined to the existing Email provider/identity
adapter, not the scheduled processor. Moving hosts requires replacing the
trigger and, if necessary, the Graph authentication adapter; the service,
eligibility functions, leases, completion and history do not change.

### Trigger/security configuration

- `CRON_SECRET`: secure server environment secret, supplied as a
  bearer header by the Windows launcher. Missing configuration fails closed (503);
  missing/wrong credentials return 401 before database access.
- The same authenticated route can be awakened by a different scheduler, or a
  different authenticated adapter can call the service directly.
- The existing Supabase service-role credentials and Microsoft authentication
  remain in secure environment/secret storage, never ordinary settings.
- The existing Vercel Hobby hosting remains unchanged. It hosts the application
  and current Graph identity adapter only, not the wake-up schedule.
- The adapter's 300-second execution ceiling is hosting configuration, not
  business policy. Batches are sequential and bounded to 5; existing provider
  token/Graph timeouts are 15/20 seconds.

### Windows Task Scheduler (replaceable trigger)

[Install-ScheduledEmailTrigger.ps1](../scripts/windows/Install-ScheduledEmailTrigger.ps1)
installs a **disabled** task running as SYSTEM, once per minute, with overlapping
launcher executions ignored. It runs when no interactive user is signed in.
The host must remain powered on and connected to the network. The launcher's
six-minute task limit and 310-second HTTP timeout are transport/hosting bounds,
not email retry or eligibility policy. No launcher retry is performed.

An administrator supplies the HTTPS endpoint and a SecureString secret, never
the secret as a command-line literal. The matching secret must be provisioned
in the application's secure server environment as `CRON_SECRET`.
The installer stores only a DPAPI LocalMachine encrypted credential in
`%ProgramData%\SubTracker\ScheduledEmailTrigger\trigger.xml`. The installation
directory disables inherited access and permits only SYSTEM and Administrators.
The task action contains **only executable, script and configuration-file paths**;
it contains no token, credential or email policy. Neither plaintext nor encrypted
production credentials belong in the repository.

[Invoke-ScheduledEmailTrigger.ps1](../scripts/windows/Invoke-ScheduledEmailTrigger.ps1)
decrypts the credential in memory and makes exactly one HTTPS GET to the protected
endpoint. It rejects redirects, reports failure with a nonzero task exit code,
and records only aggregate counts, runtime availability and a timestamp in
protected `last-result.json`. Errors never log raw exceptions, request headers
or HTTP bodies. The launcher contains no recipients, Graph construction,
email settings, scheduling state, business retries or eligibility logic.

Example (prompt locally; never paste a secret into a transcript):

```powershell
$secret = Read-Host 'Trigger secret' -AsSecureString
.\scripts\windows\Install-ScheduledEmailTrigger.ps1 `
    -Endpoint 'https://YOUR-SUBTRACKER-HOST/api/cron/scheduled-email' -Secret $secret
```

Verify the authoritative database worker gate is OFF before enabling or starting
the task. Task Scheduler enabled/disabled and the Supabase processing gate are
independent. The endpoint reports current Automatic Delivery and processing
availability even on an empty queue, allowing OFF/ON observation without creating
or sending email.

Azure Logic Apps, an Azure Functions timer or another scheduler can replace the
Windows task by invoking the same authenticated endpoint. Moving the application
host additionally requires moving its secure environment and replacing the
existing Vercel OIDC authentication adapter as appropriate. None of these changes
requires rewriting scheduled-email processing, reservations, eligibility or state.

Run `scripts\windows\Test-ScheduledEmailTrigger.ps1` for the isolated transport
tests. HTTP is mocked; no task is registered and no real endpoint is called.

## Runtime controls

All business controls are loaded from current Supabase state. No browser
eligibility or scheduling-time eligibility is trusted.

| Runtime authority | Meaning |
| --- | --- |
| `communication_channel_settings.enabled` | Global Email kill switch |
| `.automated_enabled` | Automatic Delivery master |
| `.contractor_email_enabled` | Contractor/external Email master |
| `.internal_email_enabled` | Dobco/internal Email master |
| Current provider, sender, reply-to, Microsoft IDs and revision | Shared configuration and revision-checked readiness |
| `microsoft_email_connection_state` | Previously Verified/Graph-tested current configuration |
| `contractor_contacts.is_active`, `.receives_compliance_email`, `.email` | Current contractor contact eligibility/address |
| `dobco_contacts.is_active`, `.receives_internal_email`, `.email` | Current Dobco contact eligibility/address |
| Current scheduling user's account and Delivery Manage permission | Authorization at final reservation |
| Frozen message/recipients and actual current status | Due, unsent Scheduled state; To/Cc/Bcc, resolved template, sender, content |
| Authoritative reservation | Existing combined 100-recipient limit, unique addresses and valid roles |

Changed contact addresses block the frozen message rather than silently sending
to either the stale address or an unreviewed new address. A blocked recipient
blocks the entire message; no partial or role-specific bypass is allowed.
Raw external addresses retain the existing known-contact preference protections.

Worker processing policy lives in `communication_email_worker_settings`:

| Setting | Default | Permitted values / behavior |
| --- | --- | --- |
| `enabled` | false | Deployment/activation gate, separate from Automatic Delivery |
| `batch_size` | 5 | 1-5 claims per run, including stale-claim cleanup |
| `retry_policy` | `pre_dispatch_only` | `none` or `pre_dispatch_only`; never retries a reserved provider delivery |
| `retry_delay_seconds` | 300 | 30-86400; fixed delay before pre-dispatch retry or blocked-eligibility recheck |
| `maximum_attempts` | 5 | 1-20 pre-dispatch attempts |
| `stale_claim_seconds` | 600 | 120-86400; lease expiry and worker-health reporting interval |
| `revision` | 1 | Optimistic settings concurrency |

`activated_at`, `updated_by`, `updated_at` and `last_polled_at` are audit/health
metadata, not user-supplied policy. No historical cutoff, deployment identifier,
hardcoded activation date, legacy enrollment state or duplicate contact database
is used.

Settings View can read policy; Settings Manage can edit it through
`GET/PATCH /api/admin/scheduled-email`, or the compact **Scheduled delivery
processing** details section in Email Settings. SQL validates types, keys,
bounds and revision. Policy changes take effect on subsequent database
operations without a code change or redeployment. Trigger cadence is configured
at the scheduler, not compiled into the worker.

Automation-only settings changes preserve an already Verified/Accepted sender
connection across the settings revision, like the existing recipient masters.
They never promote an unverified/failed connection. Sender, provider, global
enablement and identity changes retain existing verification invalidation.

## Atomicity and failure policy

1. A due message is leased with a unique random token. Transactional locks and
   `SKIP LOCKED` prevent overlapping workers from leasing the same message.
   Future, Cancelled, Sending and Sent messages cannot be newly leased.
2. Before Graph, `reserve_scheduled_communication_email` locks policy, current
   channel settings, message, lease and relevant contacts, rechecks authorization,
   all controls and current recipient eligibility, and calls the same private
   reservation core as manual sends. Requirement-notice freshness/duplicate
   checks are also shared.
3. Only this atomic final reservation changes Scheduled to Sending and marks the
   lease as dispatch-started. The token can never authorize delivery twice.
   Cancellation before reservation wins; cancellation after reservation is
   rejected by the existing state machine.
4. Settings/preferences that block delivery preserve Scheduled, store a visible
   reason, and recheck after the configured delay. They do not consume
   infrastructure retry attempts. Automatic Delivery OFF never discards a plan.
5. Infrastructure/preparation failure **before** final reservation can retry
   under the configured policy/delay/attempt limit. Exhaustion preserves an
   unsent Scheduled message with a stopped/review-required reason.
6. Graph acceptance records Sent, not Delivered. Definite rejection,
   authentication failure and uncertain outcome record Failed and the existing
   sanitized diagnostic. No successfully reserved delivery automatically retries,
   regardless of the configured pre-dispatch policy.
7. An expired pre-dispatch lease can be safely deferred/reclaimed with a new
   token. An expired dispatch-started lease becomes Failed/`outcome_unknown`
   and is never reclaimed for sending.
8. If Graph accepts but database completion fails, the message remains Sending
   until stale handling records the uncertain outcome. It is not resent.
   Completion uses the scheduling actor and claim provenance and still records
   the real outcome if the actor loses permission *after* reservation.

Graph `sendMail` and a database transaction cannot form an exactly-once
distributed transaction. This design provides at-most-one provider attempt
after a successful final reservation, prioritizing no duplicate sends.
A crash between reservation and Graph can leave an unsent message quarantined
as uncertain; history/mailbox review is required, not blind retry.

## Pending database changes

Only the new
[20261214_scheduled_email_worker.sql](../supabase/20261214_scheduled_email_worker.sql)
migration is pending. The deployed workspace migration is not edited/reapplied.

- New worker-policy, per-scheduled-message lease/state, and attempt-audit tables.
  RLS denies browser access; service functions own writes. History remains in the
  existing message/recipient tables.
- Pending/stale partial indexes on the new state table; no existing index is
  modified or removed.
- Revision-checked Settings Manage policy function, including first-activation
  zero-Scheduled guard serialized against scheduling.
- Planning wrapper records the real scheduling actor; cancellation finalizes
  a pre-dispatch lease without altering frozen content.
- Shared private reservation/notice-validation/completion helpers; ordinary
  manual entry points retain their permissions and Draft-only behavior.
- Service-only claim, reserve, defer and finish functions. Private helpers cannot
  be called directly even by service_role.
- Nonsecret scheduling capability/health projection for the UI.
- No production settings, contacts, messages, schedules, indexes or data are
  changed during this implementation pass. The migration itself defaults the
  worker to OFF and never performs a send.

## UI behavior

The approved layout/styling is unchanged. Scheduling success shows the date,
time and zone plus actual runtime capability. Scheduled and the schedule dialog
show disabled, unavailable/pending or unhealthy-worker states honestly.
Delivery details expose blocked/stopped reasons and the next recheck time.
General communication history and cancellation accept the same operational
capability instead of asserting plan-only behavior.

Worker availability requires both its activation switch and a recent successful
database check-in. Installing code or toggling Automatic Delivery alone does not
claim that a live worker exists.

## Isolated validation

`node scripts/test-communications-db.mjs` includes the new scheduled-worker suite
using PGlite. SQL, the actual worker service and shared delivery helper execute
against synthetic records; only the provider is mocked. The suite has no real
network or credentials. A controlled database clock replaces sleeps.

Coverage includes migration rollback/history preservation/default OFF,
activation with nonzero plans blocked, pause/resume, future/due work,
overlapping workers, repeated final reservation/completion, all current masters,
independent internal/contractor switches, every To/Cc/Bcc role, active/preference/
address changes, scheduling actor access, cancellation, template fields, the
100-recipient boundary, manual-send and requirement-notice completion,
Graph rejection/uncertainty/authentication, completion failure, stale claims,
runtime retry settings/exhaustion, authentication of the trigger, RLS/private
functions, and automation-only connection-verification preservation.

API, Microsoft adapter, Email workspace browser, administration browser, shared
composer and shared Style 3 regressions also passed, followed by TypeScript,
scoped ESLint, a clean production build and `git diff --check`.
Browser routes intercept all database/provider mutations; no real send is made.

| Validation | Result |
| --- | --- |
| Communications database suite, including scheduled-worker SQL/service tests | PASS |
| Communications/API permissions and capability projections | PASS |
| Microsoft Email adapter tests, synthetic Graph only | PASS |
| Administration browser regression | PASS |
| Email workspace browser, including scheduling/policy/disabled/pending states | PASS |
| Shared composer regression | PASS |
| Shared Style 3 shell, nine viewports | PASS |
| TypeScript and scoped ESLint | PASS |
| Clean HEAD plus scoped-changes production webpack build, 89 static pages | PASS |
| Whitespace and 24-file byte-preservation check | PASS |

The browser runner used the clean production build, not the long-running HMR
server. It stopped its own preview afterward. The existing developer server
was not stopped. The build's only warning was the expected inferred-workspace
root warning from the isolated copy's second lockfile.

## Production activation gate

The authorized sequence remains:

1. Perform an authoritative Supabase query:
   `SELECT count(*) FROM public.communication_messages WHERE channel='email' AND status='Scheduled';`
   If nonzero, stop and report the records. Do not activate them.
2. Review/apply only the scheduled-worker migration, check Microsoft readiness and
   current business switches without sending.
3. Configure the secure trigger credential and disabled Windows task, and review
   runtime policy. First activation enforces the same zero-Scheduled check
   inside the database transaction.
4. Deploy/enable the protected trigger and confirm check-in/capability.
5. Only under separate live-test authorization, schedule the controlled test.

The authoritative production check found zero Scheduled records after the
earlier test was already cancelled (revision 3). The cancelled record remains
in history. No legacy/manual-only enrollment state or historical cutoff is added.

On 2026-11-10, the exact reviewed migration was transferred and checksum-verified
before execution. Its LF-normalized SHA-256 is
`bb67a6934629cd248c218feb94cf9fd5760e27ec26b20e86788702cbbd1f34b1`.
Supabase reported success. All three new tables have RLS enabled. The verified
initial policy is disabled, batch 5, pre-dispatch-only retries, retry delay 300
seconds, maximum attempts 5, stale-claim timeout 600 seconds. State and attempt
tables are empty.

Global, Automatic Delivery, Contractor and Dobco Internal Email are ON. However,
the current settings revision is 5, updated at `2026-11-10T15:18:50.702582Z`;
the stored Microsoft Verified / Accepted by Graph result belongs to revision 4,
tested at `2026-11-10T14:51:20.656462Z`. Thus the authoritative current-revision
readiness check is false. This mismatch predates the worker migration. No
verification state was edited, no revision check was bypassed, and no
authentication or connection-test send was performed to overwrite that evidence.

The secure production trigger environment secret was provisioned, and the
Windows task was installed disabled. Its SYSTEM identity, path-only arguments
and SYSTEM/Administrators-only protected directory ACL were verified. The
endpoint has not been deployed or invoked by the task. The database processing
gate remains OFF, with zero Scheduled records, zero scheduling state rows and
zero attempts at the final check. The prior manual validation remains Sent.

Those were the initial stopped-checkpoint conditions. On explicit authorization,
the existing non-delivery Test Connection verified Microsoft authentication at
revision 5 at `2026-11-10T17:22:24.582804Z`. The existing authentication function
intentionally changed current delivery readiness to Not Tested rather than
carrying revision 4 evidence forward.

The separately authorized prerequisite Send Test Email then generated exactly
one communication, `354f3ac7-2afb-45fd-833a-fd8726131554`, addressed only to
`richg@dobcogroup.com`. Graph accepted it and the application recorded Sent at
`2026-11-10T17:24:26.026681Z`. Settings and connection revision remained 5,
authentication was Verified, and delivery was Accepted by Graph. The total
communication count increased from 8 to 9, with one Sent recipient and zero
Scheduled records. Processing remained OFF and the Windows task disabled.
No connection revision was edited manually.

The exact-scope candidate deployment `dpl_8zwHBTqnE4AaMEyT5wfx6VnqtZ3K` reached
Production READY. Upload inspection excluded environment files, dependencies
and unrelated working-tree changes. The worker endpoint returned 401 without
authentication. Both the protected launcher and the actual SYSTEM task returned
successful zero-work responses with processing OFF. The task was enabled at
one-minute intervals before the normal Settings UI activated the authoritative
worker gate at `2026-11-10T17:29:01.892985Z`. Its first healthy enabled cycle had
zero claims and zero sends.

One automatic test, `87c26189-16f4-4002-82f3-6343783fbd4f`, was scheduled through
the production composer at approximately 17:30 UTC for `2026-11-10T17:35:00Z`.
Its sole recipient is the currently eligible Dobco contact at the approved safe
address. No manual Send action was used. Before due time it remained Scheduled
with no attempt, reservation or send, including empty worker cycles through
17:34 UTC.

The database attempt audit records claim at `2026-11-10T17:35:36.376511Z`, final
reservation/dispatch at `2026-11-10T17:35:37.084856Z` and Graph acceptance/Sent
completion at `2026-11-10T17:35:37.553414Z`. The shared production Graph adapter
was used, with current settings and current Dobco contact eligibility enforced
by the common reservation. There is one attempt, outcome `accepted`, one Sent
communication and one Sent To recipient. Graph acceptance does not prove mailbox
receipt or reading.

Three additional real Windows executions completed at 17:36:47, 17:37:47 and
17:38:47 UTC (launcher host clock), each reporting zero claims and zero sends.
The authoritative post-cycle database check still found one accepted attempt,
one message with the unique test subject and one recipient. No second reservation
or delivery occurred.

The ordinary Email Settings UI then switched Automatic Delivery OFF at revision
6 and ON at revision 7. The 17:39:47 worker response reported automatic delivery
disabled, and the 17:40:47 response reported it enabled, without code changes or
redeployment. Both cycles claimed/sent zero. The reviewed settings wrapper
preserved Verified / Accepted by Graph legitimately through these automation-only
changes; the final settings and connection revisions both equal 7. No manual
connection-state write was used.

The final live database check found zero Scheduled records and 10 total
communications, exactly the original 8 plus the separately authorized prerequisite
test and automatic test. Global, Automatic Delivery, Contractor and Dobco
Internal Email are ON. Worker processing is enabled, policy remains batch 5 /
pre-dispatch-only / 300-second delay / 5 attempts / 600-second stale timeout.
These were the successful live-test conditions before the final build stop below.
When enabled, the Windows host must remain powered on and network-connected;
replacing it with another authenticated timer does not change the worker.

### Final release stop

After live validation, the database/API/Microsoft mock suites, Windows transport
tests, TypeScript, scoped ESLint, whitespace check and 24-file preservation check
passed again. The earlier exact-scope production build and all four browser
suites had passed during live observation.

The required post-live production rebuild failed with:

```
EBUSY: resource busy or locked, open
D:\subtracker\.next\scheduled-email-validation\.next\trace
```

The chained post-live browser run therefore did not execute. No automatic retry,
lock bypass, checkpoint or final deployment was attempted. The authoritative
processing gate was switched OFF through Save Worker Settings, and the Windows
task was disabled. The candidate deployment remains the READY production build;
it cannot automatically process messages while the database gate is OFF.
The existing locked Git checkpoint is unchanged and the index remains empty.
Both authorized live messages remain part of communication history; neither may
be resent when resuming this release.

On the authorized continuation, Windows Restart Manager reported no current
owner of the old trace file, and an exclusive read/write file-open probe
succeeded. No responsible temporary build/preview process remained identifiable;
no process was terminated, and unrelated development/worker processes were left
alone. The exact isolated directory was removed after unlinking its dependency
junction and recreated from the locked HEAD plus only the 29 approved files.
The complete clean production build then passed with 89 static pages.

Database/API/mock Microsoft tests, Windows-trigger tests, TypeScript, scoped
ESLint, whitespace and protected-file verification all passed again. The
production-rendered administration browser suite passed, but the Email suite
failed at `scripts/test-email-communications-ui.mjs:269`: immediately after the
Edit draft heading appeared, the expected `Remove Chris Contractor from cc`
button count was 0 instead of 1. The shared composer and Style 3 suites were not
reached by the fail-fast runner. No test retry, assertion change or functionality
change was attempted; this subsequent release failure stopped the checkpoint as
instructed. The owned isolated build was cleaned afterward.

Read-only production verification still found the automatic test Sent, exactly
one accepted attempt, one recipient, zero Scheduled messages, 10 total
communications and zero later messages to the safe recipient. The authoritative
worker remained OFF, the Windows task remained Disabled, the Git index was empty
and all 24 unrelated files retained their original bytes.

### Draft-recipient investigation and regression correction

The browser failure was a premature assertion, not a persistence or recipient
filtering defect. The Email suite intercepts all API requests: its draft store is
an in-memory Map, not a live database. Separate PGlite tests execute the real
save/update SQL against `communication_recipients` and verified these exact
synthetic email/role pairs:

| Email | Stored recipient_role |
| --- | --- |
| third-internal@example.invalid | to |
| notice@example.invalid | cc |
| external@example.invalid | bcc |

Database tests additionally verify all three roles can move on the same draft,
repeated edits leave exactly the expected rows, and a cross-role duplicate is
rejected without changing saved recipients. Actual draft and history route tests
verify exact email/role serialization for To, Cc and Bcc.

The reopened-draft route maps stored roles without dropping Cc. EmailComposer
loads configuration, templates and the draft asynchronously using Promise.all,
then sets recipients and reveals Cc/Bcc when a secondary role exists. Its
`Edit draft` heading depends only on the draft ID, so that heading appears before
the response arrives; it is not evidence that recipient hydration has finished.

A controlled response gate in the browser regression now holds the draft API
response, proves the heading is visible while the Cc chip is absent, releases
the unchanged exact email/role payload, and waits for the Cc chip to render
before asserting its count. No arbitrary delay, retry or error suppression was
added. Expanded browser coverage reopens all three roles, moves each recipient
to another role and back, rejects cross-role duplicate selection, and confirms
the same draft and exact recipient count after repeated edits.

No application, SQL or Scheduled Email worker behavior changed to resolve this
gate. The only necessary correction is test synchronization and stronger
database/API/browser assertions. The fresh production build, administration,
Email, shared composer, nine-viewport Style 3, scheduled-worker/database/API,
mock Microsoft, Windows trigger, TypeScript, scoped ESLint, whitespace and
protected-file checks passed. Read-only production verification still found
one Sent automatic message, one accepted attempt, one recipient, zero Scheduled
records and zero later messages to the safe recipient. No live test was repeated.

## Changed files (30)

Documentation:
- [EMAIL_COMMUNICATIONS_WORKSPACE.md](EMAIL_COMMUNICATIONS_WORKSPACE.md)
- [SCHEDULED_EMAIL_DELIVERY.md](SCHEDULED_EMAIL_DELIVERY.md)

Database and trigger configuration:
- [20261214_scheduled_email_worker.sql](../supabase/20261214_scheduled_email_worker.sql)
- [Install-ScheduledEmailTrigger.ps1](../scripts/windows/Install-ScheduledEmailTrigger.ps1)
- [Invoke-ScheduledEmailTrigger.ps1](../scripts/windows/Invoke-ScheduledEmailTrigger.ps1)
- [Test-ScheduledEmailTrigger.ps1](../scripts/windows/Test-ScheduledEmailTrigger.ps1)

Services and contracts:
- [server-communication-email-delivery.ts](../src/lib/server-communication-email-delivery.ts)
- [server-scheduled-email.ts](../src/lib/server-scheduled-email.ts)
- [server-scheduled-email-status.ts](../src/lib/server-scheduled-email-status.ts)
- [scheduled-email.ts](../types/scheduled-email.ts)
- [communication-compose.ts](../types/communication-compose.ts)
- [email-workspace.ts](../types/email-workspace.ts)

API:
- [scheduled policy administration](../src/app/api/admin/scheduled-email/route.ts)
- [trigger adapter](../src/app/api/cron/scheduled-email/route.ts)
- [manual send](../src/app/api/communications/[id]/send/route.ts)
- [schedule/cancel](../src/app/api/communications/[id]/plan/route.ts)
- [delivery detail](../src/app/api/communications/[id]/delivery/route.ts)
- [compose options](../src/app/api/communications/compose-options/route.ts)
- [Email history](../src/app/api/communications/email-history/route.ts)

UI (scheduling status/settings only):
- [CommunicationChannelSettings.tsx](../src/components/CommunicationChannelSettings.tsx)
- [ScheduledEmailWorkerSettings.tsx](../src/components/ScheduledEmailWorkerSettings.tsx)
- [CommunicationComposer.tsx](../src/components/CommunicationComposer.tsx)
- [CommunicationLogsPanel.tsx](../src/components/CommunicationLogsPanel.tsx)
- [EmailComposer.tsx](../src/components/EmailComposer.tsx)
- [EmailHistory.tsx](../src/components/EmailHistory.tsx)

Tests:
- [test-communications-db.mjs](../scripts/test-communications-db.mjs)
- [test-scheduled-email-db.mjs](../scripts/test-scheduled-email-db.mjs)
- [test-communications.mjs](../scripts/test-communications.mjs)
- [test-email-communications-ui.mjs](../scripts/test-email-communications-ui.mjs)
- [test-email-workspace-db.mjs](../scripts/test-email-workspace-db.mjs)
