# SubTracker NJ PWC Worker

A persistent **Node.js + Playwright** worker that polls SubTracker for pending NJ PWC search requests, searches the NJ Public Works Contractor Registration Power BI report, and posts candidate matches back over HTTPS.

> This is the production implementation of the extraction method proven during live testing (Playwright frame iteration + table read). **It is not a Power Automate Desktop flow.**

The worker communicates only with the SubTracker integration endpoints. SubTracker itself may run locally, in GitHub, or hosted on Vercel — the worker reaches it via `SUBTRACKER_BASE_URL` over HTTPS.

---

## Prerequisites

- **Node.js 18+** (`node -v`)
- Network access from this machine to both the SubTracker host and `app.powerbigov.us`
- The `COMPLIANCE_SYNC_RPA_KEY` shared secret (matches the server's env value)

## Setup

1. Copy the environment template and fill in real values:

   ```
   copy .env.example .env
   ```

   Edit `.env`:
   - `SUBTRACKER_BASE_URL` — e.g. `http://localhost:3000` (local) or your Vercel URL
   - `COMPLIANCE_SYNC_RPA_KEY` — the real shared secret
   - `NJ_PWC_REPORT_URL` — the NJ PWC Power BI report URL
   - `POLL_INTERVAL_SECONDS` — default `30`
   - `WORKER_LOG_PATH` — default `./logs/nj-pwc-worker.log`
   - `HEADLESS` — `false` for attended first-run validation, `true` for production

2. Install dependencies and the Chromium browser:

   ```
   .\install-worker.ps1
   ```

   This verifies Node.js, runs `npm ci`, installs Playwright's Chromium, and creates the log directory.

## Run

**Attended (first-run validation):** set `HEADLESS=false` in `.env`, then:

```
.\start-worker.ps1
```

or directly:

```
node worker.js
```

A visible Chromium window opens per request so you can observe the search.

**Production:** after the flow is validated, set `HEADLESS=true` in `.env` and run `node worker.js` (or `.\start-worker.ps1`).

Stop with `Ctrl+C`.

> Task Scheduler / Windows service setup is intentionally **not** configured yet.

## Worker Health

Compliance Sync displays Worker Health above its existing content (not under
Settings). Deploy `supabase\20261009_compliance_worker_health.sql` and the
application endpoints before restarting this worker to load monitoring.
Old processes do not reload saved JavaScript and cannot report the new telemetry.
Do not start a duplicate worker; stop its existing terminal with Ctrl+C first.

Start the worker using a new PowerShell process:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\subtracker\worker\nj-pwc\start-worker.ps1"
```

Alternatively:

```powershell
Set-Location -LiteralPath 'D:\subtracker\worker\nj-pwc'
npm start
```

Bypass applies only to the new PowerShell process being launched and avoids
unsigned-script execution-policy failures. Enforced organizational policies may
still take precedence. Do not run multiple worker instances simultaneously.

`health.js` reports startup/shutdown, an independent 15-second heartbeat (also
during long searches), Chromium readiness, successful queue polling, completed
searches, and errors to the RPA-authenticated worker-health endpoint. Search
normalization, retries, extraction, and candidate submission remain unchanged.
Telemetry failures are logged as `health_report_error`; they do not abort searches.
No inbound worker port, remote shell, or automatic process restart is added.

The server uses receipt time for heartbeat freshness: up to 60 seconds is fresh,
over 60 seconds is degraded, and over 120 seconds or explicit shutdown is offline.
Busy workers with a connected browser and recent heartbeats are not marked offline
merely because a long lookup delays the next queue poll. Queue polling failures
after returning idle can make the worker unavailable even if its process is alive.

Restart Required compares the running instance's start time with the latest local
modification time of `worker.js` and `health.js`, and also compares their combined
loaded/current SHA-256 hash. A timestamp-preserving code change still requires
restart. Report timestamps need a correctly synchronized worker host clock.
Restart Required makes overall health Degraded but does not itself block searches.

Test Worker is a harmless 30-second readiness acknowledgement, not a registry
lookup. Recent logs are sanitized database events (last 50 shown, last 200 kept);
idle heartbeats update a summary row rather than creating events. Last Successful
Search includes completed No Match Found responses successfully submitted.
Last Error is historical and is not silently erased on recovery.

The future NY worker is Not Configured and excluded from overall health. Enabling
an NY worker requires a separately implemented/configured worker; this feature
does not implement NY extraction.

## What it does

1. Registers its process UUID through heartbeat reports, then POSTs `action=claim` to `{SUBTRACKER_BASE_URL}/api/integrations/compliance-sync/search-requests` with that UUID (header `x-subtracker-rpa-key`). The server atomically assigns exactly one request.
2. POSTs `action=start` with the request ID and same instance UUID before executing the search. Processes **one request per queue poll**, ordered by priority (`0` user, `10` exception retry, `20` daily), creation time, then ID. After acknowledged completion, immediately claims again; a new user search jumps ahead of remaining daily work without interrupting the current search.
3. For each: opens the report in a fresh page, waits until the **Business Name** search box (the single `search-field` inside the iframe under the "Search Business Name" heading) and the results table have rendered, applies the search term with Playwright **Locators** (re-resolved on every action; the typed value is verified before pressing Enter), waits until the results table changes from its pre-search state and settles, then reads the result table across all frames and maps 9 columns by position. It never falls back to another search box; if the Business Name box cannot be identified uniquely, the search fails with a diagnostic error.
4. Classifies: 1 row → `Match Found`, 2+ → `Multiple Matches`, 0 (every variation searched successfully) → `No Match Found`; Business Name box not identifiable, or transient failures (detached element, timeout, results not updating) that persist after retries → `Website Error`; other worker exceptions or unrecoverable browser loss → `RPA Error`.
5. POSTs `action=complete`, the owning instance UUID, and candidates back to the same endpoint (idempotent by request ID and owner; retries POST 3× at 5s/15s/45s — never re-runs the search on a POST failure). A rejected/unacknowledged result retains the processing claim and blocks further execution by that instance.
6. Writes one structured JSON log line per request plus a heartbeat when the queue is empty.

## Daily NJ PWC registry sync

### Atomic-queue rollout and orphan recovery

Allow active legacy searches to finish, then stop legacy NJ PWC workers before rollout. Apply `supabase/20261015_nj_pwc_atomic_queue.sql` after the two `20261014` registry-sync migrations and worker-health schema, deploy the application, then start upgraded workers. Legacy GET batch polling is rejected with HTTP 409. Do not run old cached batches alongside new claim-based workers.

For administrator-controlled recurring schedules, apply `supabase/20261019_nj_pwc_daily_sync_schedule.sql` after the existing NJ PWC schema/functions, atomic queue, exception retry lifecycle, and active/current registration synchronization migrations. Deploy the application and poll-only worker after the database migration.

Claims never automatically expire or reassign. Per-instance heartbeats support more than one live worker without interpreting an older instance as orphaned merely because another started. The Compliance Sync page provides **NJ PWC Orphaned Requests** with confirmed **Mark Failed**, **Retry Search**, and **Resolve** actions. A request must be claimed/processing, at least 10 minutes old, and owned by an instance stopped or without a heartbeat for over two minutes. Server environment `NJ_PWC_ORPHANED_REQUEST_AGE_MINUTES` changes the minimum age (1–1440). This is not a new Compliance Sync setting.

Recovery rechecks liveness under a lock, preserves the original owner/history, and rejects late results from that owner. Retry creates a linked fresh pending request; background retries have priority 10 and preserve Test Mode. Resolve closes an abandoned search as failed, never as verified compliance. Infrastructure failures never count toward expiration. Stop a worker stuck after failed result submission before attempting orphan recovery; heartbeat activity correctly keeps it ineligible while alive.

### Scheduling

The recurring NJ PWC schedule is configured in **Administration → Compliance Sync → NJ PWC Daily Sync Schedule**. Set Enabled, Start Date, Start Time, and the initial `America/New_York` time zone there; no worker environment variable or operating-system scheduler is used. SubTracker calculates `next_sync_at` and handles daylight-saving transitions. The worker periodically POSTs `{ "action": "poll" }` to `/api/integrations/compliance-sync/nj-pwc-daily`; the database decides whether a run is due and creates no more than one scheduled run per local date. Missed historical occurrences are skipped. Disabling the schedule does not remove existing queued/in-progress work.

When due, SubTracker queues one search per active contractor that has an NJ PWC # or an active NJ PWC compliance record. Those searches use the normal queue and priority order (user 0, exception retry 10, daily 20). The worker processes one item at a time and returns to user searches between daily items. When the queue is idle the worker POSTs `{ "action": "finalize" }` (at most every 10 minutes); finalization continues for existing runs even when the recurring schedule is disabled.

The worker sends `search_variation` with each result for diagnostics. It never decides whether a schedule is due or how approval, expiration, and Test Mode behave — the Compliance Sync **NJ PWC Mode**, **Test Mode**, and **Failure Threshold** are applied by SubTracker. Test Mode still runs scheduled searches/classification and records exceptions/WOULD_* metrics without live compliance writes. Log events: `daily_sync_scheduled`, `daily_sync_finalized`, `daily_sync_error`.

**Search reliability (bounded):** transient errors (detached element, timeout, search box re-rendered before the search applied) are retried up to 3 times per page with a short delay, re-acquiring the frame and Locator each time, then the search is retried once on a fresh page. Valid empty results are never retried. A transient failure on one name variation does not stop the remaining variations; if no variation returns rows and any variation failed, the request is reported as an error rather than `No Match Found`. If the shared browser has closed or disconnected, it is relaunched and the current request is retried once. Each attempt is logged as a `search_attempt` event (variation, page attempt, input attempt, outcome); a screenshot is saved to `logs/screenshots/request-<id>.png` only on a search's final failed attempt.

**Search discovery:** tries exact and punctuation/suffix variants first, then ampersand compaction, `Manufacturing` → `Mfg`, first two words, and the first meaningful word. Results are deduplicated across terms, with broader-query rows prioritized when the payload is capped. Broad terms discover candidates only; SubTracker validates certificate/address/location/registration evidence and applies the existing confidence/approval rules. The variation used is logged.

**Security:** the RPA key is sent only as the `x-subtracker-rpa-key` header and is **never logged**. No Supabase keys, tokens, cookies, or passwords are logged. `.env` must never be committed.

## Validation

First test — search `ABCO ELECTRIC, LLC` → expect `Abco Electric, LLC`, Cert `708951`, Reg `2026-01-15`, Exp `2028-01-14`, `1 Geoffrey Way`, Wayne, NJ, `07470`, Passaic.

Second test — search `454 MECH` → expect `454 Mechanical LLC`, Cert `708435`.

Verify: the pending request is retrieved, Power BI is searched, the candidate is extracted, the result is posted, the request leaves `pending`, and the candidate popup appears in SubTracker.
