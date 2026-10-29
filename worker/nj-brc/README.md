# SubTracker NJ BRC Playwright Worker

Separate Node.js/Playwright worker for New Jersey Business Registration Certificate (NJ BRC) requests. It does not share the NJ PWC worker process, selectors, key, or telemetry identity. It makes no application/database writes directly; it claims and reports typed requests through the authenticated NJ BRC integration API.

## Install and configure

Requirements: Node.js 18+, network access to SubTracker and `www1.state.nj.us`, and the dedicated `NJ_BRC_WORKER_KEY`.

```powershell
Set-Location 'D:\subtracker\worker\nj-brc'
Copy-Item .env.example .env
```

Configure `SUBTRACKER_BASE_URL` and `NJ_BRC_WORKER_KEY` in `.env`. Keep the key private; it is sent only as `x-subtracker-brc-key`. New installations default to headless operation; an existing `.env` retains its explicit `HEADLESS` value. Use `HEADLESS=false` only for an explicitly attended human-verification session. No challenge or access protection is bypassed.

Install the isolated worker dependency and Chromium browser:

```powershell
.\install-worker.ps1
```

The local exclusive lock rejects another process in the same installation. The database lease for `nj-brc` is authoritative across directories and machines: only its current owner may claim, change state, or report. The worker itself never automatically reclaims a local lock.

The repository's [Start SubTracker launcher](../../Start%20SubTracker.cmd) can
recover a provably stale/invalid `worker.lock` during its BRC step, after host
readiness and the PWC check. It verifies Windows process identity, retains live
or uncertain locks, and removes only the verified stale lock before invoking
the unchanged `start-worker.ps1`. The worker's exclusive acquisition and
owner-token release remain additional local safeguards. When starting this worker directly,
confirm the old process is stopped before manually removing an existing lock;
direct startup does not perform coordinator recovery.

## Attended capture mode

Set `NJ_BRC_CAPTURE_MODE=true` and `HEADLESS=false`, then run `.\start-worker.ps1`. Capture mode opens the confirmed NJ BRC login page, reports only selector counts and confirmed labels, and saves a screenshot of the initial page after masking and clearing visible input values. It never fills or submits a lookup. An operator may manually inspect the page and complete human verification. Use only an expressly approved known contractor for any manual lookup; do not save raw HTML, cookies, storage, or unredacted certificate screenshots.

The live form selector is `form[action='/TYTR_BRC/servlet/common/BRCLogin']`. The worker submits only `pinnctl` (Name Control, exactly four characters from `[A-Za-z0-9&-]`) and `pinidnum` (Taxpayer ID, max length 12); the source's Business Entity ID control is not a search input. The Taxpayer ID is the normalized nine-digit FEIN followed by `000`. Confirmed certificate labels are Taxpayer Name, Trade Name, Address, Certificate Number, Effective Date, and Date of Issuance. Each label is an exact table cell in a two-cell row; Address may continue in the next row. For Office Use Only is in a separate table and is retained only as evidence. On a successful result, Certificate Number supplies the contractor's NJ BRC #.

The result selectors were confirmed during an attended source inspection on October 9, 2026. Source no-match and invalid-input messages have **not** been confirmed live. The worker therefore classifies only explicit, conservative source phrases as `no_match` or `invalid_input`; an unknown page, changed markup, protection page, or extraction failure is `website_error` or `ambiguous_result`, never No Match.

## Start and human verification

```powershell
powershell -ExecutionPolicy Bypass -File "D:\subtracker\worker\nj-brc\start-worker.ps1"
```

Stop with Ctrl+C before installing updated code or starting another instance. Both SIGINT and SIGTERM stop claims immediately, allow the current request a configurable drain period, close the browser, report shutdown, and release the lease. Interrupted in-flight requests become explicit terminal failures without source replay; already-staged review items remain pending. A fatal or ownership error exits nonzero, and the PowerShell entry point propagates that exit code.

Visible reCAPTCHA/hCaptcha controls and explicit challenge messages put the request into `human_verification_required`. The worker keeps the same page and context, never clicks/solves a challenge, and never resubmits after verification. Every configured human-wait notice interval (five minutes by default) it reports a timeout notice but retains that session. Ownership is also checked every 30 seconds while waiting. A headless challenge cannot be completed unattended: stop, inspect the retained failure, and arrange a separately authorized attended attempt rather than replaying automatically.

## Timing, ownership and service readiness

| Setting | Default | Purpose |
| --- | --- | --- |
| `POLL_INTERVAL_SECONDS` | 30 | Normal claim interval; reset immediately after work |
| `IDLE_MAX_SECONDS` | 300 | Empty-queue delays: 30, 60, 120, 240, then 300 seconds |
| `ERROR_MAX_SECONDS` | 120 | Transient claim failures: 30, 60, then 120 seconds |
| `HEARTBEAT_SECONDS` | 20 | One atomic lease-renewal/health/test-ack RPC; allowed 5-25 |
| `RESULT_WAIT_SECONDS` | 30 | Bounded recognition wait after the single source submission |
| `RESULT_REPORT_ATTEMPTS` | 3 | Transient result-report retries, with 1/2-second waits by default |
| `SHUTDOWN_GRACE_SECONDS` | 30 | Time to drain active source work before browser closure |

Values are validated at startup; see `.env.example`. The database lease lasts 90 seconds; failed health reports do not extend the worker's 80-second safety deadline. Ownership is renewed before the source click and before every result submission. Losing ownership closes the browser and stops processing. Database expiry fences stale results even if a process or network is stalled. Lease takeover closes abandoned claimed/processing/human-wait requests with retained evidence, an exception and audit entry, rather than blindly resubmitting them.

Steady idle traffic is approximately 4,608 RPCs/day (4,320 health renewals plus 288 claims), excluding startup/events/UI traffic. Heartbeats have no extra worker-row read and ordinary ready/busy/poll changes are coalesced. The Worker Health interface uses fresh leased BRC heartbeats during idle backoff; its Last Queue Poll still shows the real claim timestamp. PWC freshness rules are unchanged.

The worker is ready for a future non-interactive service supervisor, not a fully unattended CAPTCHA solution. No service is installed. A future wrapper must propagate stop signals, allow the drain/API cleanup time, retain logs, protect configuration, and implement bounded restart delays. Hard kills rely on lease expiry and explicit interruption recovery. If all database/API access is down, terminal persistence must wait for recovery or the next successful lease takeover.

## Reliability checkpoint validation

The offline NJ BRC suite passes 72/72 runner tests. Supplemental migration
validation passes 20/20, including rollback after accidental re-execution.
These checks do not start a worker or submit a live NJ lookup.

The final readiness review preserves these coupled-check classifications:

- The PWC extractor snapshot compares against an obsolete historical expectation;
  the same failure reproduces on committed HEAD before the BRC repair.
- The Worker Health Settings assertion targets a hidden tab panel and also fails
  on the committed baseline. Later assertions in that UI test are not reached.
- The desktop exception action-row failure was not reproduced in fresh baseline,
  BRC-only or complete current-source builds. The existing development server
  lacked the generated desktop no-wrap CSS rule; no BRC layout regression was
  reproduced. No unrelated test or stylesheet was changed.

Production rollout still requires explicit approval, catalog/ownership checks,
the reliability migration before the matching application deployment, separate
local worker replacement and a controlled live validation before continuous use.

## Queue/API contract

- `POST /api/integrations/compliance-sync/nj-brc/lease` uses `{instance_id,action}` with `acquire`, `renew`, or `release`.
- `GET /api/integrations/compliance-sync/nj-brc?instance_id=<UUID>` atomically claims a request and returns `{request: null | snapshot}`. It is idempotent for the current worker's claimed request.
- Intermediate `POST` uses `{request_id, instance_id, state}` for `processing` or `human_verification_required`; a human-wait timeout may also contain a sanitized `error_message`.
- Final `POST` uses `{request_id, instance_id, result:{kind,...evidence}}`. `successful_certificate` becomes `review_required`; all outcomes remain review-controlled. Result kinds are `successful_certificate`, `no_match`, `invalid_input`, `identity_mismatch`, `ambiguous_result`, `website_error`, and `failed`.

The worker never receives the stored FEIN. Its API snapshot contains `taxpayer_id_submission`, the immutable 12-digit lookup value prepared server-side using the shared `input.js` helper. That transformation is lookup-only: it preserves leading zeroes, removes standard formatting, validates exactly nine digits, and appends `000`. The required website lookup inputs are BRC Name Control and this Taxpayer ID; an existing NJ BRC # is not required or submitted. A successful returned Certificate Number populates the contractor's NJ BRC #. No FEIN, 12-digit taxpayer ID, secret, cookie, raw page HTML, or unrestricted source evidence is logged. The only page content stored is the redacted website-error diagnostics described below.

Identity comparison mirrors `src/lib/contractor-matching.ts::normalizeCompanyName` exactly and requires equality; it does not use substring or fuzzy matching. It lowercases, maps `&` to `and`, removes periods/apostrophes, treats other punctuation as separators, collapses whitespace, then strips the same repeated trailing legal suffixes. Unequal names become an identity mismatch or ambiguous result, never a successful certificate.

Worker Health uses key `nj-brc`, key header `x-subtracker-brc-key`, and lifecycle states `starting`, `ready`, `busy`, `human_verification_required`, `website_error`, and `stopped`. Its independent configurable heartbeat supports Test Worker acknowledgement only with a connected browser and valid ownership. Human verification remains degraded/unavailable for new work.

## Result and review rules

The worker extracts only the confirmed result labels. Taxpayer Name, Trade Name, and Address are identity/review evidence and do not rename contractors or modify contractor addresses. Certificate Number is the proposed compliance Registration Number only after review approval. Effective Date maps to the compliance Effective Date; Date of Issuance remains separate evidence. Expiration is always `NULL`; effective date and For Office Use Only are never used as expiration or registration number. No Match, human verification, website errors, invalid input, mismatches, and ambiguous results never deactivate existing authoritative records.

### Website-error page diagnostics

Failures, including pre-submission failures, capture bounded metadata without modifying the page DOM: final URL (origin/path only), title, at most 3000 characters of sanitized visible text, classification, processing stage, HTTP status where available, iframe count and up to 20 sanitized iframe URLs/titles/visibility flags, and human/protection detection flags. Frame contents, scripts, form values, screenshots, unrestricted HTML, cookies and browser storage are never captured. Lookup identifiers, session/query values, worker keys and credential labels are redacted. Iframe metadata survives even when the response is otherwise empty.

Recognized classifications are `certificate`, `no_result`, `human_verification`, `protection`, `temporary_failure`, `unrecognized`, `navigation_failure` and `timeout`. Protection/temporary/unknown/navigation/timeout outcomes use the existing terminal `website_error` status, not fabricated no-match results. There is no automatic source retry for a terminal request.

The API accepts diagnostics only for `website_error`/`failed`, redacts them again, and attaches them after terminal persistence, including reporting fallbacks. New screenshot/HTML uploads are discarded; historical stored diagnostics are not changed and their blobs remain omitted from contractor-facing reads. Attachment errors are logged and surfaced as `page_diagnostics_stored:false`; they do not reopen the terminal request.

## Tests and troubleshooting

Run only synthetic local browser fixtures (no live registry access, no production API, and no real contractor data):

```powershell
npm run test:synthetic
```

An authorization/ownership error stops the worker. Only transient reporting failures are retried, idempotently and with bounded waits; the website click is never replayed. A reporting fallback retains original evidence and terminally fails ingestion explicitly rather than claiming certificate success.

Before any restart, obtain approval to apply the complete forward-only [reliability migration](../../supabase/20261130_nj_brc_reliability.sql), deploy the matching API/UI code, and update this worker directory separately. Do not rerun historical migrations. Keep BRC stopped throughout that sequence, inspect old in-flight requests and review items, verify the lease is unowned, then authorize one controlled attended validation before continuous operation. Never use the claiming GET as a health check. None of these production actions is performed by tests.

From the repository root, `node --test scripts\test-nj-brc-db.mjs scripts\test-nj-brc-runtime.mjs scripts\test-nj-brc-api.mjs scripts\test-nj-brc-application.mjs scripts\test-nj-brc-orphan-recovery.mjs scripts\test-nj-brc-worker.mjs` runs local regressions. The database entry point builds all current migrations in isolated PGlite, including the defective replacements and installed-schema drift; no remote connection is used. Deterministic timing/lifecycle tests use injected clocks/transports, and browser classifiers use intercepted offline HTML.
