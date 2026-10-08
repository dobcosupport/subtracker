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

## What it does

1. Polls `GET {SUBTRACKER_BASE_URL}/api/integrations/compliance-sync/search-requests?compliance_name=NJ PWC&limit=25` (header `x-subtracker-rpa-key`).
2. Processes pending requests **oldest first, one at a time**.
3. For each: opens the report in a fresh page, waits until the **Business Name** search box (the single `search-field` inside the iframe under the "Search Business Name" heading) and the results table have rendered, applies the search term with Playwright **Locators** (re-resolved on every action; the typed value is verified before pressing Enter), waits until the results table changes from its pre-search state and settles, then reads the result table across all frames and maps 9 columns by position. It never falls back to another search box; if the Business Name box cannot be identified uniquely, the search fails with a diagnostic error.
4. Classifies: 1 row → `Match Found`, 2+ → `Multiple Matches`, 0 (every variation searched successfully) → `No Match Found`; Business Name box not identifiable, or transient failures (detached element, timeout, results not updating) that persist after retries → `Website Error`; other worker exceptions or unrecoverable browser loss → `RPA Error`.
5. POSTs candidates back to the same endpoint (idempotent by `search_request_id`; retries POST 3× at 5s/15s/45s — never re-runs the search on a POST failure).
6. Writes one structured JSON log line per request plus a heartbeat when the queue is empty.

**Search reliability (bounded):** transient errors (detached element, timeout, search box re-rendered before the search applied) are retried up to 3 times per page with a short delay, re-acquiring the frame and Locator each time, then the search is retried once on a fresh page. Valid empty results are never retried. A transient failure on one name variation does not stop the remaining variations; if no variation returns rows and any variation failed, the request is reported as an error rather than `No Match Found`. If the shared browser has closed or disconnected, it is relaunched and the current request is retried once. Each attempt is logged as a `search_attempt` event (variation, page attempt, input attempt, outcome); a screenshot is saved to `logs/screenshots/request-<id>.png` only on a search's final failed attempt.

**Search normalization:** tries the exact company name, then commas removed, then commas + trailing business suffixes (LLC/INC/CORP/CORP/COMPANY/CO/LTD) removed, then the first two meaningful words — stopping at the first variation that returns rows. The variation used is logged.

**Security:** the RPA key is sent only as the `x-subtracker-rpa-key` header and is **never logged**. No Supabase keys, tokens, cookies, or passwords are logged. `.env` must never be committed.

## Validation

First test — search `ABCO ELECTRIC, LLC` → expect `Abco Electric, LLC`, Cert `708951`, Reg `2026-01-15`, Exp `2028-01-14`, `1 Geoffrey Way`, Wayne, NJ, `07470`, Passaic.

Second test — search `454 MECH` → expect `454 Mechanical LLC`, Cert `708435`.

Verify: the pending request is retrieved, Power BI is searched, the candidate is extracted, the result is posted, the request leaves `pending`, and the candidate popup appears in SubTracker.
