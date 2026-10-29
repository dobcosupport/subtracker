# SubTracker — NJ BRC Verification

Queue administration, attended batch instructions, and legacy Power Automate Desktop
field mappings for the **NJ Business Registration Certificate** (NJ BRC) workflow.
NJ PWC, NY PWC, and NY BRC automation are outside this work.

> The current attended browser worker runs on the interactive Windows desktop.
> The PAD material after the queue/batch section is the older integration reference,
> not the launch procedure for an attended verification batch.

## Verification Queue and attended batches (Phases A/B, local implementation)

Administration → Compliance Sync → NJ BRC now contains a reconciliation queue.
This queue is separate from the legacy PAD execution contract below. Viewing the
queue or creating a Prepared Batch does not start a worker, open NJ's website,
create a search request, or promote compliance. Only an explicitly started attended
batch, bound to its Batch ID in the BRC worker command, enables NJ processing.

- Every active company requires NJ BRC, including Material Only companies.
  Public Works status, project assignment and mailing state do not affect BRC
  eligibility. Inactive companies are outside this active population.
- The authoritative compliant/missing value comes from active/current
  `compliance_records` for the active NJ BRC compliance type. A nonblank
  registration number is Active; an absent/blank record is Missing Information.
  A contractor-master number or successful unapproved search is not sufficient.
- NJ BRC remains non-expiring. Existing accepted records remain accepted even
  when their older verification metadata needs reconciliation.
- Summary counts partition the complete active population. Search and bucket
  filters affect table rows, not population counts. The queue displays FEIN
  validity only, never the full identifier.
- Ready rows can be selected individually or with **Select Ready on page**,
  without opening the company. Selection survives paging/searching in selection
  order; **Clear selection** resets it. Non-Ready rows explain why selection is
  disabled. **Create Verification Batch (5)** with five selected companies freezes
  exactly those five members in a Prepared Batch.
- Selection is available to queue viewers; creating or changing a batch still
  requires Compliance Sync manage permission, with a visible permission message
  for view-only users. Start/Resume authorize attended processing; Pause blocks
  additional source actions, while allowing an in-flight result to be retained.
  Stop is final. Completed submissions are not replayed. Existing search/review
  protections remain in force.
- No historical attempt, verifier, source or verification date is manufactured.
  Actual search requests are created just in time by the attended batch coordinator.
- The new queue/session APIs are under `/api/admin/compliance-sync/nj-brc-queue`
  and `/api/admin/compliance-sync/nj-brc-sessions`. They require authenticated
  Compliance Sync permissions; manifest mutations require manage permission.
- The local migration is
  [`20261201_nj_brc_verification_queue.sql`](../supabase/20261201_nj_brc_verification_queue.sql).
  It must be reviewed and applied separately before deploying these APIs.
  The Phase B extension is
  [`20261202_nj_brc_attended_batches.sql`](../supabase/20261202_nj_brc_attended_batches.sql).
  Neither migration is applied by local implementation/testing.

NJ PWC processing, eligibility and configuration are unchanged.

### Controlled five-company review instructions

These are preparation instructions, **not authorization to run a live lookup**.
Review the local changes and validation before applying SQL, deploying or starting
the updated BRC worker.

1. Apply only the Phase A migration above if it has not already been applied,
   then the Phase B extension, in that order. Do not apply every uncommitted SQL
   file in the repository. The earlier `20261130_nj_brc_reliability.sql` dependency
   was already deployed; do not blindly rerun it.
2. Deploy the reviewed BRC application changes before using the currently
   configured worker against Vercel. Its existing base URL points at the deployed
   application; old deployed APIs cannot coordinate batches. A deliberate local
   UI/API target is an alternative, but requires separately configuring the
   BRC worker base URL. This work does not change that private configuration.
3. In Administration -> Compliance Sync -> NJ BRC, click **Ready**. Check exactly
   five companies. The button must read **Create Verification Batch (5)**.
   Click it and expand **View frozen membership**. Confirm five contractors in
   the intended order. Copy the displayed Batch UUID.
4. On the attended Windows server, stop the old **BRC-only** PowerShell process
   with Ctrl+C and wait for its stop/lease-release message. Do not stop PWC,
   restart the shared launcher, or launch a second BRC instance. If an old process
   crashed, verify it is stopped before manually removing its stale local BRC
   lock; do not clear a live or uncertain lock. An unreleased lease can require
   waiting for expiry rather than repeated restarts.
5. In a visible, interactive PowerShell desktop session, paste the command from
   the batch's **Copy Worker Command** action (or its read-only command field):

   ```powershell
   powershell -ExecutionPolicy Bypass -File "D:\subtracker\worker\nj-brc\start-worker.ps1" -BatchId "<copied batch UUID>"
   ```

   Keep `HEADLESS=false` and `NJ_BRC_CAPTURE_MODE=false`. The worker should log
   lease acquisition and attended startup, open one browser page, and wait without
   contacting NJ until the prepared batch is started. No Windows service,
   Task Scheduler hidden desktop, or second worker is needed.
6. Click **Start attended session** for that exact batch and confirm. The worker
   processes one member at a time, fills Name Control and the FEIN-derived taxpayer
   ID, and submits the ordinary NJ form at most once for that request.
7. When NJ asks for human verification, complete **all stages yourself** in the
   visible worker browser. Do not click the BRC form's Submit or Reset controls,
   refresh, navigate away, or start a separate lookup. The worker neither clicks
   nor solves challenges. It waits for the legitimate result after manual
   verification and reuses the same session for the remaining companies.
8. Keep **View frozen membership** open. It refreshes during running/paused
   sessions. Each safely persisted result appears as a completed member with its
   actual request status: `review_required`, `no_match`, `invalid_input`,
   `website_error`, etc. Captured certificates also appear in the existing Reviews
   tab. `review_required` is not compliant or approved. Saved/skipped counts update
   on the batch line; the next company advances automatically.
9. **Pause manifest** pauses future source actions and claims; an already-sent
   response may still be saved. Keep the browser/PowerShell open to retain the
   legitimate NJ session. **Resume manifest** continues unfinished members;
   completed submissions are skipped. **Stop manifest** permanently stops that
   batch and closes it after the current attempt is safely accounted for.
10. Protection/temporary service failure or repeated source errors pause the batch.
    Investigate before explicitly resuming. Browser/lease/persistence failure can
    require restarting the BRC-only process with the **same Batch ID**, never
    constructing replacement requests blindly. An interrupted, uncertain attempt
    is closed/reconciled without replay and may require an extra Resume to
    acknowledge recovery. A stopped/completed batch cannot be restarted.

The worker exits after completion/stop and closes its ephemeral browser session.
There is no automatic approval, automatic CAPTCHA interaction, or global pending
queue drain.

---

## Purpose

Verify NJ Business Registration Certificates for contractors by driving the NJ BRC website, then submit results into SubTracker's Compliance Sync review pipeline without affecting authoritative compliance data.

---

## NJ source URL

```
https://www1.state.nj.us/TYTR_BRC/jsp/BRCLoginJsp.jsp
```

The RPA opens this page in a supported web browser.

---

## SubTracker field mapping

Lookup inputs come from the **contractor master record** — never from the Active Compliance Record registration number.

| NJ website field | SubTracker source field |
|---|---|
| **Name Control** | `contractors.brc_name_control` |
| **Taxpayer ID** | `contractors.federal_tax_id` normalized to nine digits plus `000` |

The website lookup requires Name Control and Taxpayer ID only. `contractors.nj_brc_number` is an output populated from the returned Certificate Number; it is not required to search or submitted as Business Entity ID.
- Compliance Type: `NJ BRC`
- Sync Source: `RPA`

---

## Input validation (before opening the website)

A lookup is allowed only when **all** of the following hold:

1. Contractor is active
2. NJ BRC sync is enabled (Compliance Sync Settings)
3. BRC Name Control is valid
4. Taxpayer ID can be derived from a valid nine-digit FEIN

**Blank/invalid BRC Name Control** → do not search; create exception `Missing BRC Name Control` or `Invalid BRC Name Control`; Review Status = Failed.
**Blank/invalid FEIN** → do not search; create exception `Missing Taxpayer ID (FEIN)` or `Invalid Taxpayer ID (FEIN)`; Review Status = Failed.

### Name Control rules
- Trim leading/trailing spaces
- Convert to uppercase
- Use four characters
- Never overwrite a manually maintained stored value
- Do not send spaces or unsupported punctuation
- Preserve an allowed ampersand `&` or hyphen `-` present in the stored value
- **Log the exact normalized Name Control used** (returned on the work item as `nj_brc_lookup.brc_name_control`)

### Taxpayer ID rules
- Treat FEIN as text and preserve leading zeros
- Remove standard formatting and validate exactly nine digits
- Append `000` for the 12-digit NJ Taxpayer ID submission
- Never submit the FEIN itself or use NJ BRC # as a fallback

---

## Power Automate Desktop flow

Flow name: **`SubTracker - NJ BRC Verification`**

Sequence:

1. Call the SubTracker **Start Sync Run** endpoint
2. Call the SubTracker **Work Items** endpoint
3. Filter work items to NJ BRC
4. Loop through each eligible contractor
5. Open a new **Microsoft Edge** browser instance
6. Navigate to the NJ BRC website
7. Wait until the Name Control and Taxpayer ID inputs are available
8. Enter the normalized BRC Name Control into **Name Control**
9. Enter the normalized 12-digit FEIN-derived value into **Taxpayer ID**
10. Submit the search
11. Wait for the result page
12. Capture the result information visibly returned by the NJ website
13. Submit that result to the SubTracker **Compliance Sync Results** endpoint
14. Continue to the next contractor
15. Complete the Sync Run after every work item is processed
16. Close the browser

**Use stable web elements (CSS / UI-automation selectors), not fixed screen coordinates.** Document the selectors chosen for the Name Control and Taxpayer ID inputs, submit control, and result fields. On a successful result, use Certificate Number to populate NJ BRC #.

---

## SubTracker API endpoints

Base path: `/api/integrations/compliance-sync`. All require the auth header below.

| Endpoint | Method | Purpose |
|---|---|---|
| `/work-items` | GET | Active contractors needing NJ BRC verification (normalized lookup inputs + Active record context) |
| `/runs` | POST | Start a sync run |
| `/results` | POST | Submit one lookup result |
| `/runs/{id}/complete` | POST | Complete a sync run |

### Required authentication header

```
x-subtracker-rpa-key: <COMPLIANCE_SYNC_RPA_KEY>
```

`COMPLIANCE_SYNC_RPA_KEY` is a **server-only** environment variable. Never expose it via `NEXT_PUBLIC_*`, browser code, URL query params, or logs. Missing/invalid key → HTTP 401 (an audit entry is written without logging the key).

### Request / response examples

See `docs/COMPLIANCE_SYNC_RPA.md` for full request/response bodies, allowed `result_status` values, validation, and error codes.

---

## Result classification

`Match Found` · `No Match Found` · `Multiple Matches` · `Invalid Search` · `Website Error` · `RPA Error`

For **Match Found**, capture when available: Contractor ID, Compliance Type = NJ BRC, Searched Name Control, submitted Taxpayer ID (masked), Matched Company Name, Certificate Number, registration/certificate status, Effective Date (if displayed), Expiration Date (only if displayed by the source), Verification Date, Source URL, Raw Result Summary. Use the returned Certificate Number to populate the contractor's NJ BRC #.

**Expiration date:** never fabricate one. If the source does not display an expiration date, store it as `null`, do not treat the missing value as an RPA failure, and record that no expiration date was supplied by the source.

---

## Result handling

For every NJ BRC result:

1. Update the **display-only** Synced Compliance Record for NJ BRC
2. Create/update the **Compliance Sync Review Queue** item
3. Store current Active Compliance Record values separately from proposed synced values
4. Set Review Status = **Pending Review**
5. **Do not** update Active Compliance Records
6. **Do not** affect dashboard counts, reminders, reports, or contractor compliance status

---

## Review Queue behavior

NJ BRC items display: Contractor (links to `/contractors/[contractor_id]`), BRC Name Control Used, NJ BRC # at Request (optional context), Matched Company Name, Certificate Number, Synced Status, Existing/Proposed Registration Number, Existing/Proposed Expiration Date, Last Verified, Sync Source, Review Status, Exception Message, View Contractor, Approve, Reject.

**Approve** records the decision only: `approved_by`, `approved_at`, `approval_source = Manual Review`, Review Status = Approved. It does not update Active Compliance Records.
**Reject** requires a reason and stores `rejected_by`, `rejected_at`, `rejection_reason`, Review Status = Rejected.

Every review record is preserved.

---

## Auto Approve preparation

The NJ BRC approval mode setting (Review Required / Auto Approve) is preserved. During Phase 1, even when Auto Approve is selected: do not write to Active Compliance Records, mark the item Pending Review, and store `approval_source = Auto Approve Requested`. Write-through is enabled only after the NJ BRC RPA workflow is tested and approved.

---

## Exception behavior

Exceptions are created for: Missing BRC Name Control, Missing Taxpayer ID (FEIN), Invalid BRC Name Control, Invalid Taxpayer ID (FEIN), NJ Website Unavailable, Search Form Not Found, Search Timed Out, No Match Found, Multiple Matches, Result Page Changed, Result Fields Could Not Be Read, SubTracker Submission Failed.

Stored: `contractor_id`, `company_name`, `compliance_type`, `exception_type`, `error_message`, `source_url`, `sync_run_id`, `created_at`, `resolved`, `resolved_by`, `resolved_at`.

**Never logged:** RPA API keys, Supabase service-role keys, passwords, authentication tokens.

---

## Retry rules

Results are idempotent per `(sync_run_id, contractor_id, compliance_type)`. Retrying the same lookup returns the existing review entry (`duplicate: true`) rather than creating a duplicate. Network/5xx errors may be retried; validation (4xx) errors should not be retried without correction.

## Orphaned worker requests

Compliance Sync administrators can review aged NJ BRC requests in `claimed` or `processing` whose assigned worker instance is no longer the registered NJ BRC worker. The default age threshold is 10 minutes; configure the Next.js server environment variable `NJ_BRC_ORPHANED_REQUEST_AGE_MINUTES` to an integer from 1 through 1440 to change it.

Cleanup requires explicit confirmation and rechecks eligibility transactionally. Eligible requests are preserved and transitioned to `website_error` through `store_nj_brc_terminal_error()`; the completion timestamp and administrator audit entry are written atomically. Pending, review-required, completed, current-instance, and too-young requests cannot be recovered through this action. Apply `supabase/20261013_nj_brc_worker_orphan_recovery.sql` before deploying this UI/API feature.

---

## Test Mode

A per-type **Test Mode** setting processes only one selected contractor, creates a test Sync Run, creates a Review Queue result, never updates Active Compliance Records, and labels all generated records **Testing Only**.

The Administrator-only **Test NJ BRC Lookup** action (Administration → Compliance Sync) runs a single attended test. The first test should be attended and manually observed. **Do not schedule an unattended daily run yet.**

---

## Test procedure

1. Set the `COMPLIANCE_SYNC_RPA_KEY` server environment variable.
2. Run the migrations: `20261002_compliance_sync_admin.sql`, `20261002_compliance_sync_rpa.sql`, `20261002_nj_brc_rpa_mapping.sql`, `20261002_nj_brc_test_mode.sql`.
3. Enable NJ BRC Test Mode in Compliance Sync Settings.
4. Use **Test Connection** to confirm reachability/auth/tables (no website lookup).
5. Run **Test NJ BRC Lookup** on one contractor, attended, and verify the Testing Only review result appears.

---

## Compliance Logic Lock

Active Compliance Records remain the sole authoritative source for All Companies, 90/60/30 Day, Expired, Missing Information, contractor compliance status, reports, and reminders. NJ BRC synced results do not directly change Active Compliance Records and do not affect dashboard calculations.

---

## Human Verification Requirement (Observed 2026-10-02)

The NJ BRC website now presents an anti-bot **human-verification challenge** ("Additional security check is required" / "I am human") after submitting Name Control and Taxpayer ID. **Do not automate, solve, or bypass this challenge.**

### Challenge identification
- **Not definitively identifiable from static markup** — the page blocks automated fetches, so the challenge vendor cannot be confirmed from HTML alone. Based on the wording and behavior it is a managed human-verification widget (most consistent with **reCAPTCHA**- or **Cloudflare Turnstile**-style checkbox challenges; possibly hCaptcha). Confirm the exact vendor by loading the page manually and inspecting the challenge iframe/script origin (`google.com/recaptcha`, `challenges.cloudflare.com`, or `hcaptcha.com`).
- **Do not attempt to identify it programmatically for the purpose of solving it.**

### When it appears
- Observed **after search submission** (post-submit gate), and it can be triggered **earlier or after repeated requests** as the site's bot-detection escalates. It is not reliably present before search; treat any appearance as a hard stop for the RPA.

### RPA limitation
The RPA **cannot complete** a human-verification challenge. When the challenge appears, the flow must stop the lookup for that contractor and record it — not retry, not solve, not route around it.

### Compliance Sync exception type
A new exception type records this condition: **`Human Verification Required`** (supported by the results endpoint's NJ BRC exception set). When the challenge is detected, submit the result with `result_status = "RPA Error"` and an `error_message` of "Human Verification Required" so the exception is classified correctly and the run's failed counter increments.

### Manual verification workflow
Until/unless a sanctioned API or manual-verification path is available:

1. The RPA processes contractors normally; on `Human Verification Required`, it records the exception and moves on.
2. An Administrator opens the NJ BRC website manually, completes the human check, performs the lookup, and records the result via a Manual sync source (or reviews the resulting review-queue entry).
3. Review-queue entries proceed through the normal Pending Review → Approve/Reject flow (decision-only; Active Compliance Records unchanged in Phase 1).

### Hard rules
- **Never** bypass, solve, or programmatically defeat the human-verification challenge.
- **Never** rotate IPs, user-agents, or use headless-stealth techniques to evade it.
- If the challenge blocks automated verification at scale, escalate to a manual process or pursue an official data-sharing/API arrangement with the state.
