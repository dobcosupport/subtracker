# SubTracker Compliance Sync — RPA Integration (Phase 1)

Server-side endpoints for a future Microsoft Power Automate Desktop (PAD) flow to retrieve contractors requiring NJ/NY compliance verification and submit results into the Compliance Sync review pipeline.

> **Phase 1 scope:** the PAD flow itself is not built yet. These endpoints are ready for it.

---

## Compliance Logic Lock

**Active Compliance Records remain the sole authoritative source** for dashboard counts, Missing Information, 90/60/30 Day, Expired, contractor status, reports, and reminders.

The RPA pipeline writes **only** to:

- Synced Compliance Records (`compliance_records.synced_*` columns — display-only)
- `compliance_sync_runs`
- `compliance_sync_review_queue`
- `compliance_sync_exceptions`
- `administration_audit_log`

It **never** modifies Active Compliance Records. Approving a review-queue entry records a decision only; automatic writes to Active Compliance Records remain disabled until the RPA workflow is validated (see *Auto Approve* below).

---

## Required environment variable

| Variable | Scope | Description |
|---|---|---|
| `COMPLIANCE_SYNC_RPA_KEY` | **Server-only** | Shared secret the RPA must send on every request. |

Generate a strong random value and set it in the server environment (e.g. `.env.local` for local dev, or your hosting provider's secret store for production). **Never** prefix it with `NEXT_PUBLIC_`, commit it to source control, or expose it to the browser.

```
# .env.local (server-side only)
COMPLIANCE_SYNC_RPA_KEY="generate-a-long-random-string-here"
```

---

## Authentication

Every RPA endpoint requires the key in an HTTP header:

```
x-subtracker-rpa-key: <COMPLIANCE_SYNC_RPA_KEY>
```

- Missing or invalid key → **HTTP 401** `{"error":"Unauthorized."}`
- Each rejected attempt writes an `administration_audit_log` entry **without** logging the key value.

Do **not** pass the key in URL query parameters.

---

## Endpoints

Base path: `/api/integrations/compliance-sync`

### 1. GET `/work-items`

Returns active contractors that have at least one enabled sync type.

**Query parameters**
- `limit` (optional) — positive integer, server-capped at 500. Default 100.

**Response** `200 OK`
```json
{
  "work_items": [
    {
      "contractor_id": 12,
      "company_name": "Acme Construction",
      "address_1": "123 Main St",
      "address_2": null,
      "city": "Newark",
      "state": "NJ",
      "zip_code": "07102",
      "nj_pwc_number": "PWC-12345",
      "nj_brc_number": "BRC-6789",
      "ny_pwc_number": null,
      "ny_brc_number": null,
      "brc_name_control": "ACME",
      "compliance_types_to_check": ["NJ BRC", "NJ PWC"]
    }
  ]
}
```

Notes:
- Only the fields the RPA needs are returned.
- Only enabled compliance types (from Compliance Sync Settings) are included, sorted alphabetically.
- Inactive contractors are excluded; contractors are sorted by company name.

---

### 2. POST `/runs`

Starts a sync run.

**Request**
```json
{
  "sync_source": "RPA",
  "initiated_by_name": "PAD Bot v1",
  "bot_version": "1.0.0"
}
```
`sync_source` must be one of `RPA`, `Manual`, `API`. For this integration use `RPA`.

**Response** `200 OK`
```json
{ "sync_run_id": 42, "started_at": "2026-10-02T14:03:11.000Z" }
```

Creates a `compliance_sync_runs` row with `run_status = Running` and zeroed counters.

---

### 3. POST `/results`

Submits a single verification result.

**Request**
```json
{
  "sync_run_id": 42,
  "contractor_id": 12,
  "compliance_type": "NJ PWC",
  "searched_registration_number": "PWC-12345",
  "matched_registration_number": "PWC-12345",
  "matched_company_name": "Acme Construction",
  "synced_status": "Active",
  "synced_effective_date": "2026-01-01",
  "synced_expiration_date": "2027-01-01",
  "last_verified": "2026-10-02T14:05:00.000Z",
  "source_url": "https://nj.gov/labor/...",
  "result_status": "Match Found",
  "error_message": null,
  "raw_result_summary": "NJ DOL lookup returned a single active registration."
}
```

**Allowed `compliance_type`:** `NJ PWC`, `NJ BRC`, `NY PWC`, `NY BRC`

**Allowed `result_status`:**

| Status | Meaning |
|---|---|
| `Match Found` | A single matching registration was found |
| `No Match Found` | No registration matched |
| `Multiple Matches` | More than one registration matched |
| `Invalid Search` | The search input was invalid |
| `Website Error` | The source website errored |
| `RPA Error` | The RPA process itself errored |

**Validation (400/404 on failure)**
- `sync_run_id` invalid or not found → 400 / 404
- `contractor_id` invalid or contractor missing → 400 / 404
- `compliance_type` unsupported → 400
- `result_status` missing/invalid → 400
- expiration/effective date invalid → 400

No arbitrary table or column names are accepted; all values map to fixed columns.

**Match Found behavior**
1. Creates/updates the contractor's display-only Synced Compliance Record (`synced_*` columns on the matching `compliance_records` row).
2. Creates a `compliance_sync_review_queue` entry storing current vs. proposed values.
3. `status = pending` (Review Status = Pending Review) by default.

**Auto Approve (Phase 1 safety lock):** if the compliance type's Approval Mode is `auto_approve`, the entry is still created with `status = pending` and `approval_source = "Auto Approve Requested"`. **Active Compliance Records are not updated.** Automatic writes stay disabled until the RPA workflow is validated.

**Non-match/error statuses:** an exception is created, the run's failed counter is incremented, Active Compliance Records are untouched, and diagnostics are preserved.

**Response (Match Found)** `200 OK`
```json
{ "review_queue_id": 101, "review_status": "pending", "approval_source": null, "change_detected": true, "result_key": "42:12:NJ PWC" }
```

**Response (non-match)** `200 OK`
```json
{ "exception_created": true, "result_status": "No Match Found", "result_key": "42:12:NJ PWC" }
```

---

### 4. POST `/runs/{id}/complete`

Marks a run finished.

**Request**
```json
{
  "records_checked": 25,
  "changes_detected": 4,
  "records_failed": 1,
  "error_message": null
}
```

**Run status rules**

| Condition | run_status |
|---|---|
| `records_failed = 0` | `Completed` |
| `records_failed > 0` but run finished | `Completed With Errors` |
| Overall process failed before completion | `Failed` |

**Response** `200 OK`
```json
{ "sync_run_id": 42, "run_status": "Completed With Errors", "completed_at": "2026-10-02T14:20:00.000Z" }
```

---

## Idempotency / Retry behavior

Results are deduplicated by `(sync_run_id, contractor_id, compliance_type)` — a unique partial index enforces this. Re-submitting the same result for the same run returns the existing review entry (`duplicate: true`) instead of creating a duplicate, so PAD retries are safe.

The server accepts an internally generated `result_key` of the form `sync_run_id:contractor_id:compliance_type`.

---

## Error handling

| Code | Meaning |
|---|---|
| 400 | Validation failure (bad field value) |
| 401 | Missing/invalid RPA key |
| 404 | Referenced run/contractor not found |
| 500 | Unexpected server error |

All error responses are `{"error": "..."}`. Retryable network/5xx errors may be retried by PAD; idempotency prevents duplicate review entries.

---

## Power Automate Desktop field mapping

| PAD action | Endpoint | Key fields |
|---|---|---|
| `Invoke web service` (GET) | `/work-items` | loop `work_items[]` |
| Loop each `compliance_types_to_check` | — | drive website lookup |
| Start run | `/runs` (POST) | capture `sync_run_id` |
| Per lookup | `/results` (POST) | map search/match fields above |
| End of run | `/runs/{id}/complete` (POST) | totals from loop counters |

Set the header `x-subtracker-rpa-key` on every `Invoke web service` action. Store the key as a PAD sensitive variable; do not hardcode it in the flow.

---

## Testing

The Compliance Sync admin page (Administration → Compliance Sync) includes an **RPA Integration (Testing)** section:

- Copy buttons for each endpoint URL
- **Test Connection** — confirms the endpoint is reachable, the caller is authenticated, the RPA key is configured, and the required tables exist. No website lookup is performed.

The actual key is never displayed after being stored.
