# SubTracker NJ BRC Playwright Worker

Separate Node.js/Playwright worker for New Jersey Business Registration Certificate (NJ BRC) requests. It does not share the NJ PWC worker process, selectors, key, or telemetry identity. It makes no application/database writes directly; it claims and reports typed requests through the authenticated NJ BRC integration API.

## Install and configure

Requirements: Node.js 18+, network access to SubTracker and `www1.state.nj.us`, and the dedicated `NJ_BRC_WORKER_KEY`.

```powershell
Set-Location 'D:\subtracker\worker\nj-brc'
Copy-Item .env.example .env
```

Configure `SUBTRACKER_BASE_URL` and `NJ_BRC_WORKER_KEY` in `.env`. Keep the key private; it is sent only as `x-subtracker-brc-key`. Defaults use a visible browser (`HEADLESS=false`), poll every 30 seconds, and wait five minutes between human-verification timeout notices. Adjust the navigation, human-verification, retry, and log settings in `.env` if required.

Install the isolated worker dependency and Chromium browser:

```powershell
.\install-worker.ps1
```

The worker rejects a second same-host process through an exclusive lock. It never automatically reclaims a stale lock because the prior process may still own an in-flight request. Confirm the old process is stopped before manually removing `worker.lock`.

## Attended capture mode

Set `NJ_BRC_CAPTURE_MODE=true` and `HEADLESS=false`, then run `.\start-worker.ps1`. Capture mode opens the confirmed NJ BRC login page, reports only selector counts and confirmed labels, and saves a screenshot of the initial page after masking and clearing visible input values. It never fills or submits a lookup. An operator may manually inspect the page and complete human verification. Use only an expressly approved known contractor for any manual lookup; do not save raw HTML, cookies, storage, or unredacted certificate screenshots.

The live form selector is `form[action='/TYTR_BRC/servlet/common/BRCLogin']`. Confirmed controls are `pinnctl` (Name Control, exactly four characters from `[A-Za-z0-9&-]`), `pinidnum` (Taxpayer ID, max length 12), `pincorpid` (Business Entity ID, max length 10), `pincasinoid` (max length 7; not used for the contractor Business Entity ID lookup), and `input[type=submit][name=submit]`. Confirmed certificate labels are Taxpayer Name, Trade Name, Address, Certificate Number, Effective Date, and Date of Issuance. Each label is an exact table cell in a two-cell row; Address may continue in the next row. For Office Use Only is in a separate table and is retained only as evidence.

The result selectors were confirmed during an attended source inspection on October 9, 2026. Source no-match and invalid-input messages have **not** been confirmed live. The worker therefore classifies only explicit, conservative source phrases as `no_match` or `invalid_input`; an unknown page, changed markup, protection page, or extraction failure is `website_error` or `ambiguous_result`, never No Match.

## Start and human verification

```powershell
powershell -ExecutionPolicy Bypass -File "D:\subtracker\worker\nj-brc\start-worker.ps1"
```

Stop with Ctrl+C before installing updated code or starting another instance. The browser is visible by default. The worker detects visible reCAPTCHA/hCaptcha controls and explicit visible challenge messages but never clicks, solves, or bypasses them. It keeps the same browser context and request open, reports `human_verification_required`, and waits for an authorized person at the worker machine. The request is not resubmitted after verification. During the wait the worker periodically checks queue ownership using the same instance ID and refreshes health only when the same request is confirmed; it will not process another request while the challenge is active. After the configured wait expires, it reports a timeout while retaining the recoverable request and browser session.

## Queue/API contract

- `GET /api/integrations/compliance-sync/nj-brc?instance_id=<UUID>` atomically claims a request and returns `{request: null | snapshot}`. It is idempotent for the current worker's claimed request.
- Intermediate `POST` uses `{request_id, instance_id, state}` for `processing` or `human_verification_required`; a human-wait timeout may also contain a sanitized `error_message`.
- Final `POST` uses `{request_id, instance_id, result:{kind,...evidence}}`. `successful_certificate` becomes `review_required`; all outcomes remain review-controlled. Result kinds are `successful_certificate`, `no_match`, `invalid_input`, `identity_mismatch`, `ambiguous_result`, `website_error`, and `failed`.

The worker never receives the stored FEIN. Its API snapshot contains `taxpayer_id_submission`, the immutable 12-digit lookup value prepared server-side using the shared `input.js` helper. That transformation is lookup-only: it preserves leading zeroes, removes standard formatting, validates exactly nine digits, and appends `000`. The original contractor FEIN, NJ BRC Number/Business Entity ID, and Name Control are never changed. A valid Taxpayer ID snapshot takes precedence. Only when no Taxpayer ID is supplied may the worker use the Business Entity ID alternative; a malformed non-empty Taxpayer ID snapshot is rejected rather than substituted. No lookup proceeds if neither input is valid. No FEIN, 12-digit taxpayer ID, secret, cookie, raw page HTML, or unrestricted source evidence is logged.

Identity comparison mirrors `src/lib/contractor-matching.ts::normalizeCompanyName` exactly and requires equality; it does not use substring or fuzzy matching. It lowercases, maps `&` to `and`, removes periods/apostrophes, treats other punctuation as separators, collapses whitespace, then strips the same repeated trailing legal suffixes. Unequal names become an identity mismatch or ambiguous result, never a successful certificate.

Worker Health uses key `nj-brc`, key header `x-subtracker-brc-key`, and lifecycle states `starting`, `ready`, `busy`, `human_verification_required`, `website_error`, and `stopped`. The independent 15-second heartbeat supports Test Worker acknowledgement only while the browser is connected and queue polling is fresh. A prolonged inability to reconfirm request ownership does not fake a fresh queue poll.

## Result and review rules

The worker extracts only the confirmed result labels. Taxpayer Name, Trade Name, and Address are identity/review evidence and do not rename contractors or modify contractor addresses. Certificate Number is the proposed compliance Registration Number only after review approval. Effective Date maps to the compliance Effective Date; Date of Issuance remains separate evidence. Expiration is always `NULL`; effective date and For Office Use Only are never used as expiration or registration number. No Match, human verification, website errors, invalid input, mismatches, and ambiguous results never deactivate existing authoritative records.

## Tests and troubleshooting

Run only synthetic local browser fixtures (no live registry access, no production API, and no real contractor data):

```powershell
npm run test:synthetic
```

An API authorization error stops the worker. An uncertain API submission also stops rather than claiming another request, because the prior POST may have committed. For an existing lock, verify that the old worker process has ended before removing the lock file. Restart an existing process after code changes; code-hash reporting flags a stale running instance.
