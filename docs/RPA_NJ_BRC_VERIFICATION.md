# SubTracker RPA — NJ BRC Verification (Phase 1)

Field mapping, Power Automate Desktop flow sequence, and SubTracker behavior for the **NJ Business Registration Certificate** (NJ BRC) lookup workflow. **NJ BRC only** — NJ PWC, NY PWC, and NY BRC automation are out of scope for this phase.

> The website automation runs in Power Automate Desktop (PAD) on a workstation, outside this codebase. This document is the contract between the PAD flow and SubTracker's server-side endpoints.

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
| **Business Entity ID** | `contractors.nj_brc_number` |

- Compliance Type: `NJ BRC`
- Sync Source: `RPA`

---

## Input validation (before opening the website)

A lookup is allowed only when **all** of the following hold:

1. Contractor is active
2. NJ BRC sync is enabled (Compliance Sync Settings)
3. BRC Name Control exists
4. NJ BRC # exists

**Blank BRC Name Control** → do not search; create exception `Missing BRC Name Control`; Review Status = Failed.
**Blank NJ BRC #** → do not search; create exception `Missing NJ BRC Number`; Review Status = Failed.

### Name Control rules
- Trim leading/trailing spaces
- Convert to uppercase
- Use four characters
- Never overwrite a manually maintained stored value
- Do not send spaces or unsupported punctuation
- Preserve an allowed ampersand `&` or hyphen `-` present in the stored value
- **Log the exact normalized Name Control used** (returned on the work item as `nj_brc_lookup.brc_name_control`)

### Business Entity ID rules
- Trim spaces
- Remove display formatting (spaces, dashes)
- Preserve leading zeros
- Treat as text, never convert to a number

If the normalized value is invalid for the website field → do not submit; create an `Invalid Business Entity ID` exception preserving the original value.

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
7. Wait until the Name Control and Business Entity ID inputs are available
8. Enter the normalized BRC Name Control into **Name Control**
9. Enter the normalized NJ BRC # into **Business Entity ID**
10. Submit the search
11. Wait for the result page
12. Capture the result information visibly returned by the NJ website
13. Submit that result to the SubTracker **Compliance Sync Results** endpoint
14. Continue to the next contractor
15. Complete the Sync Run after every work item is processed
16. Close the browser

**Use stable web elements (CSS / UI-automation selectors), not fixed screen coordinates.** Document the selectors chosen for the Name Control input, Business Entity ID input, submit control, and the result fields.

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

For **Match Found**, capture when available: Contractor ID, Compliance Type = NJ BRC, Searched Name Control, Searched Business Entity ID, Matched Company Name, Matched Business Entity ID, Certificate Number, registration/certificate status, Effective Date (if displayed), Expiration Date (only if displayed by the source), Verification Date, Source URL, Raw Result Summary.

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

NJ BRC items display: Contractor (links to `/contractors/[contractor_id]`), BRC Name Control Used, Business Entity ID Used, Matched Company Name, Certificate Number, Synced Status, Existing/Proposed Registration Number, Existing/Proposed Expiration Date, Last Verified, Sync Source, Review Status, Exception Message, View Contractor, Approve, Reject.

**Approve** records the decision only: `approved_by`, `approved_at`, `approval_source = Manual Review`, Review Status = Approved. It does not update Active Compliance Records.
**Reject** requires a reason and stores `rejected_by`, `rejected_at`, `rejection_reason`, Review Status = Rejected.

Every review record is preserved.

---

## Auto Approve preparation

The NJ BRC approval mode setting (Review Required / Auto Approve) is preserved. During Phase 1, even when Auto Approve is selected: do not write to Active Compliance Records, mark the item Pending Review, and store `approval_source = Auto Approve Requested`. Write-through is enabled only after the NJ BRC RPA workflow is tested and approved.

---

## Exception behavior

Exceptions are created for: Missing BRC Name Control, Missing NJ BRC Number, Invalid BRC Name Control, Invalid Business Entity ID, NJ Website Unavailable, Search Form Not Found, Search Timed Out, No Match Found, Multiple Matches, Result Page Changed, Result Fields Could Not Be Read, SubTracker Submission Failed.

Stored: `contractor_id`, `company_name`, `compliance_type`, `exception_type`, `error_message`, `source_url`, `sync_run_id`, `created_at`, `resolved`, `resolved_by`, `resolved_at`.

**Never logged:** RPA API keys, Supabase service-role keys, passwords, authentication tokens.

---

## Retry rules

Results are idempotent per `(sync_run_id, contractor_id, compliance_type)`. Retrying the same lookup returns the existing review entry (`duplicate: true`) rather than creating a duplicate. Network/5xx errors may be retried; validation (4xx) errors should not be retried without correction.

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

The NJ BRC website now presents an anti-bot **human-verification challenge** ("Additional security check is required" / "I am human") after submitting Name Control and Business Entity ID. **Do not automate, solve, or bypass this challenge.**

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

