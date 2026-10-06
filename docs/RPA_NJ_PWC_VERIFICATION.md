# SubTracker RPA — NJ PWC Verification (Phase 1)

Field mapping, Power Automate Desktop (PAD) flow sequence, and payload contracts for the **NJ Public Works Contractor Registration** (NJ PWC) lookup workflow. **NJ PWC only** — NJ BRC is covered by `docs/RPA_NJ_BRC_VERIFICATION.md`; NY PWC / NY BRC automation are out of scope for this phase.

> The website automation runs in Power Automate Desktop (PAD) on a workstation, outside this codebase. This document is the contract between the PAD flow and SubTracker's server-side endpoints.

---

## Purpose

Search the NJ Public Works Contractor Registration Power BI report for a contractor being added in SubTracker, return candidate matches, and let the user select the correct match in the existing **NJ PWC Registry Matches** candidate modal — without affecting authoritative compliance data.

Workflow:

```
Pending Request (compliance_sync_search_requests, status = 'pending')
→ PAD Worker (polls for pending requests)
→ NJ PWC Power BI Report (app.powerbigov.us)
→ Candidate Modal (user selects the correct match)
```

---

## NJ PWC source URL

```
https://app.powerbigov.us/view?r=eyJrIjoiZmY1YmVjMzktMjc5ZS00NzQxLWFkMWQtYjYzZGRmN2JhNTViIiwidCI6IjUwNzZjM2QxLTM4MDItNGI5Zi1iMzZhLWUwYTQxYmQ2NDJhNyJ9
```

The RPA opens this report in a supported web browser. It is a published Power BI report (embedded iframe), not a standard HTML form.

### Search behavior

| Search input | Result |
|---|---|
| `ABCO` | Multiple candidate matches — all rows are returned as candidates |
| `ABCO Electric, LLC` | A specific match with the full field set |

A specific match returns these report fields:

- Business Name
- Registration Date
- Expiration Date
- Address
- City
- State
- Zip Code
- County
- Certificate Number

All returned rows (one or many) are captured and submitted as candidates. SubTracker never pre-filters the candidate list — the user selects the correct match in the candidate modal.

---

## SubTracker field mapping

Lookup inputs come from the **search request row**, created by the Add Contractor form — never from an Active Compliance Record.

| Search request field | Source | Use in the Power BI report |
|---|---|---|
| `searched_company_name` | Add Contractor form (exact-normalized: trimmed, single-spaced, uppercased) | Entered into the report's business-name search/filter |
| `searched_city` | Add Contractor form (optional) | Disambiguation context only — not a required filter |
| `searched_state` | Add Contractor form (optional) | Disambiguation context only |
| `searched_zip_code` | Add Contractor form (optional) | Disambiguation context only |

- Compliance Name: `NJ PWC`
- Result classification: `Match Found` / `No Match Found` / `Multiple Matches` / `Invalid Search` / `Website Error` / `RPA Error`

---

## Queue polling payload

**Endpoint:** `GET /api/integrations/compliance-sync/search-requests`

**Query parameters**

| Parameter | Required | Default | Notes |
|---|---|---|---|
| `compliance_name` | No | `NJ PWC` | Always `NJ PWC` for this flow |
| `limit` | No | `25` | Positive integer, server-capped at 100 |

**Auth header:** `x-subtracker-rpa-key: <COMPLIANCE_SYNC_RPA_KEY>`

**Response** `200 OK`

```json
{
  "search_requests": [
    {
      "id": 17,
      "compliance_name": "NJ PWC",
      "searched_company_name": "ABCO ELECTRIC, LLC",
      "searched_zip_code": "07001",
      "searched_city": "AVENEL",
      "searched_state": "NJ",
      "created_at": "2026-10-06T13:02:41.000Z"
    }
  ]
}
```

Notes:

- Only `status = 'pending'` requests are returned, oldest first.
- PAD processes one request at a time; do not mark requests complete except via the results POST.
- If the array is empty, wait and poll again (recommended interval: 10–30 seconds).

---

## Return-results payload (result payload contract)

**Endpoint:** `POST /api/integrations/compliance-sync/search-requests`

**Auth header:** `x-subtracker-rpa-key: <COMPLIANCE_SYNC_RPA_KEY>`

**Request**

```json
{
  "search_request_id": 17,
  "result_status": "Multiple Matches",
  "candidates": [
    {
      "business_name": "ABCO ELECTRIC, LLC",
      "certificate_number": "64321",
      "registration_date": "2024-03-15",
      "expiration_date": "2026-03-31",
      "address": "123 RAHWAY AVE",
      "city": "AVENEL",
      "state": "NJ",
      "zip_code": "07001",
      "county": "MIDDLESEX",
      "source_url": "https://app.powerbigov.us/view?r=..."
    }
  ],
  "error_message": null,
  "source_url": "https://app.powerbigov.us/view?r=..."
}
```

### Field rules

| Field | Type | Rules |
|---|---|---|
| `search_request_id` | integer | **Required.** Must reference an existing search request → 400/404 otherwise |
| `result_status` | string | **Required.** One of: `Match Found`, `No Match Found`, `Multiple Matches`, `Invalid Search`, `Website Error`, `RPA Error` → 400 otherwise |
| `candidates` | array | 0–50 items (server-capped). Items without a `business_name` are dropped. Required conceptually when `result_status` is `Match Found` (exactly 1 candidate) or `Multiple Matches` (2+) |
| `error_message` | string \| null | Required when `result_status` is `Invalid Search`, `Website Error`, or `RPA Error` |
| `source_url` | string \| null | URL of the report page the results were read from |

### Candidate object schema

| Key | Type | Power BI source column |
|---|---|---|
| `business_name` | string | **Business Name** — required; rows without it are discarded |
| `certificate_number` | string \| null | **Certificate Number** — text, preserve leading zeros, never a number |
| `registration_date` | date `YYYY-MM-DD` \| null | **Registration Date** |
| `expiration_date` | date `YYYY-MM-DD` \| null | **Expiration Date** |
| `address` | string \| null | **Address** |
| `city` | string \| null | **City** |
| `state` | string \| null | **State** |
| `zip_code` | string \| null | **Zip Code** |
| `county` | string \| null | **County** |
| `source_url` | string \| null | Report URL (optional per-row; the top-level `source_url` is sufficient) |

**Dates:** convert the report's displayed date to ISO `YYYY-MM-DD` before posting. Never fabricate an expiration date — if the report does not display one, send `null`; this is not an RPA failure.

### Server-side status mapping

| `result_status` | Stored `status` | Downstream behavior |
|---|---|---|
| `Match Found` | `completed` | Candidate modal shows 1 match |
| `Multiple Matches` | `completed` | Candidate modal shows all candidates |
| `No Match Found` | `no_match` | Add Contractor form shows "no match" |
| `Invalid Search` / `Website Error` / `RPA Error` | `failed` | Error message surfaced in the form |

**Response** `200 OK`

```json
{ "ok": true, "search_request_id": 17, "status": "completed", "candidate_count": 1 }
```

Every submission writes an `administration_audit_log` entry (`NJ_PWC_SEARCH_RESULT_SUBMITTED`). No secrets or keys are ever logged.

---

## Candidate mapping schema

The candidate object is the single shared schema across the whole pipeline:

```
Power BI row
  → PAD candidate object (POST /search-requests)
  → compliance_sync_search_requests.candidates JSONB
  → GET /api/contractors/nj-pwc-search/[id] | /latest (candidate modal polling)
  → NjPwcCandidate type (Add Contractor modal)
  → POST /api/contractors/nj-pwc-import (selected candidate)
```

- Server normalization lives in `normalizeCandidate` in `src/app/api/integrations/compliance-sync/search-requests/route.ts` — the fixed key set above is the only accepted shape.
- The client type is `NjPwcCandidate` in `src/app/contractors/page.tsx`.
- `county` is captured and displayed in the candidate modal to disambiguate matches. It is **display-only** in Phase 1: it is not imported into the contractor record (no `county` column exists) and does not appear in the import comparison table.

---

## Required Power BI interactions

The source is a published Power BI report rendered inside an embedded iframe — there is no stable HTML form. The PAD flow must use **UI-automation / CSS selectors relative to the report surface**, never fixed screen coordinates. Selectors for the items below must be captured and documented in the PAD flow.

1. **Open browser** — launch Microsoft Edge, navigate to the NJ PWC source URL.
2. **Wait for report load** — wait until the report canvas and its filter/search visuals are rendered (Power BI reports load asynchronously; wait on the visual container, not a fixed delay).
3. **Enter the search term** — set the business-name search/filter visual to the exact `searched_company_name` from the polling payload.
4. **Apply the filter** — trigger the visual's apply/confirm action and wait for the result table to refresh.
5. **Read the result table** — enumerate all visible rows; for each row capture Business Name, Registration Date, Expiration Date, Address, City, State, Zip Code, County, Certificate Number.
6. **Handle pagination** — if the table visual pages, iterate all pages before submitting (candidate cap: 50).
7. **Classify the outcome**:
   - 1 row → `Match Found`
   - 2+ rows → `Multiple Matches`
   - 0 rows → `No Match Found`
   - Report fails to load / visuals time out → `Website Error`
   - Search input invalid or cannot be set → `Invalid Search`
   - Any PAD-side failure → `RPA Error`
8. **Reset the filter** — clear the search visual before processing the next request.
9. **Post results** — submit the return-results payload for the current `search_request_id`.

### Power BI cautions

- Do not scrape the visual canvas by pixel position; use the accessible UI tree.
- If Microsoft changes the report layout, selectors break: detect missing result fields, submit `Website Error` with a descriptive `error_message`, and stop rather than posting partial data.
- Do not attempt to defeat any access control, sign-in prompt, or human-verification challenge if one ever appears; record `RPA Error` and escalate, per the same hard rules as NJ BRC.

---

## Power Automate Desktop flow

Flow name: **`SubTracker - NJ PWC Search`**

This flow is **request-driven** (it polls a queue), unlike the scheduled NJ BRC flow.

1. Loop forever (poll every 10–30 seconds):
2. Call `GET /search-requests?compliance_name=NJ PWC&limit=25` with the auth header
3. If no pending requests, wait and poll again
4. For each pending request:
   1. Open a new Microsoft Edge browser instance
   2. Navigate to the NJ PWC Power BI source URL
   3. Perform the **Required Power BI interactions** above using `searched_company_name`
   4. Build the candidate list from all result rows
   5. Call `POST /search-requests` with the return-results payload
   6. On network/5xx failure, retry with backoff; on 4xx, do not retry without correction
   7. Close the browser
5. Continue polling

Store `COMPLIANCE_SYNC_RPA_KEY` as a PAD sensitive variable; never hardcode it in the flow, put it in URL query parameters, or log it.

---

## Input validation (before opening the report)

A lookup is allowed only when **all** of the following hold:

1. The search request exists and `status = 'pending'`
2. `searched_company_name` is non-blank

If the company name is unusable → submit `result_status = "Invalid Search"` with an `error_message` describing the problem; do not open the report.

---

## Result handling

For every submitted result:

1. The search request row is updated: `status`, `result_status`, `candidates`, `error_message`, `source_url`, `completed_at`
2. The Add Contractor form polls `GET /api/contractors/nj-pwc-search/[id]` (or `/latest`) and renders the **existing candidate modal** — unchanged by this integration
3. The user selects a match; on contractor save, `POST /api/contractors/nj-pwc-import` creates a display-only Synced Compliance Record and a pending Review Queue entry
4. **Active Compliance Records are never modified** by this pipeline

---

## Test Mode

The Administrator-only **Create Test NJ PWC Result** action (Administration → Compliance Sync) remains available. It simulates PAD output for a pending request without running PAD, writing `is_test = true` rows only to `compliance_sync_search_requests`. Use it to validate the end-to-end flow while the PAD flow is under construction. Simulated candidates follow the same schema (including `county`).

---

## Compliance Logic Lock

Active Compliance Records remain the sole authoritative source for All Companies, 90/60/30 Day, Expired, Missing Information, contractor compliance status, reports, and reminders. NJ PWC search results write only to `compliance_sync_search_requests` and (after user selection + import) to display-only Synced Compliance Records and the Review Queue.

---

## Explicitly unchanged

This integration does **not** change:

- The **Review Queue** (columns, statuses, Approve/Reject behavior)
- **Sync History** (`compliance_sync_runs` display)
- The **approval workflow** (Auto Approve safety lock stays in force — no write-through to Active Compliance Records)
- The **candidate modal** layout and selection flow (county is additive display only)
