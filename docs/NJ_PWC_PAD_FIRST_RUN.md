# SubTracker — NJ PWC PAD First Run (Phase 2, Sprint 3)

The first **operational** Power Automate Desktop flow. Scope is intentionally narrow: **open the NJ PWC Power BI report, search one company, and extract the single result row.** Nothing is posted to SubTracker.

> **Sprint 3 scope: extraction only.** No queue polling, no result POST, no SubTracker changes. Success = the flow captures all nine fields for the target test into variables and a debug log.
>
> **Target test:** `ABCO Electric, LLC` → single match.
>
> **Deferred:** queue polling and submission (already specified in `docs/NJ_PWC_PAD_BUILD.md`), `Website Error` / `RPA Error` classification, retries.

---

## Success criteria

For `ABCO Electric, LLC`, the flow populates these nine variables from the result row:

| Variable | Captured |
|---|---|
| `BusinessName` | ✔ |
| `CertificateNumber` | ✔ |
| `RegistrationDate` | ✔ |
| `ExpirationDate` | ✔ |
| `Address` | ✔ |
| `City` | ✔ |
| `State` | ✔ |
| `ZipCode` | ✔ |
| `County` | ✔ |

All nine must be non-blank in the debug log for the run to pass.

---

## Variables

Declared once at the top of the flow.

| Variable | Type | Initial value | Notes |
|---|---|---|---|
| `ReportUrl` | Text | the NJ PWC Power BI URL (below) | |
| `SearchTerm` | Text | `ABCO Electric, LLC` | the attended test input |
| `Browser` | Browser | *(empty)* | set by Launch Edge |
| `ResultRow` | Custom object | *(empty)* | the extracted table row |
| `BusinessName` | Text | `""` | extraction targets |
| `CertificateNumber` | Text | `""` | |
| `RegistrationDate` | Text | `""` | |
| `ExpirationDate` | Text | `""` | |
| `Address` | Text | `""` | |
| `City` | Text | `""` | |
| `State` | Text | `""` | |
| `ZipCode` | Text | `""` | keep as text — preserve leading zeros |
| `County` | Text | `""` | |
| `StartTime` | DateTime | *(empty)* | |
| `EndTime` | DateTime | *(empty)* | |
| `LogPath` | Text | `%SpecialFolder_Documents%\NJ_PWC_PAD_debug.log` | debug log file |

NJ PWC Power BI URL:

```
https://app.powerbigov.us/view?r=eyJrIjoiZmY1YmVjMzktMjc5ZS00NzQxLWFkMWQtYjYzZGRmN2JhNTViIiwidCI6IjUwNzZjM2QxLTM4MDItNGI5Zi1iMzZhLWUwYTQxYmQ2NDJhNyJ9
```

---

## Edge launch configuration

| Setting | Value |
|---|---|
| Action | **Launch new Microsoft Edge** |
| Initial URL | `%ReportUrl%` |
| Launch mode | **New instance** |
| Window state | **Normal** (visible — this run must be observable; do not run headless) |
| Clear cache / cookies | **Yes** (clean report state) |
| Output | Browser instance → `Browser` |

---

## Report load wait conditions

The report renders inside an embedded iframe on an asynchronous canvas. **Never use fixed delays or screen coordinates** — wait on the visual surface itself.

| Step | Wait condition | Timeout |
|---|---|---|
| After launch | **Wait for web page content** — the report visual container element is rendered | 60 s |
| After search submit | **Wait for web page content** — the result table's loading indicator clears and the grid shows at least one row | 60 s |

If the visual container never appears, the run fails — record it in the debug log and stop (error classification is a later sprint).

---

## Exact PAD actions

Numbered in build order.

| # | PAD action | Configuration |
|---|---|---|
| 1 | **Set variable** `StartTime` | `%CurrentDateTime%` |
| 2 | **Write debug** | `--- RUN %StartTime% search="%SearchTerm%" ---` |
| 3 | **Launch new Microsoft Edge** | per Edge launch configuration above |
| 4 | **Wait for web page content** | report visual container; 60 s |
| 5 | **Write debug** | `report loaded` |
| 6 | **Populate text field** | business-name search box ← `%SearchTerm%` |
| 7 | **Click / press Enter** | the search apply control |
| 8 | **Wait for web page content** | result table refreshed; 60 s |
| 9 | **Extract data from web page** | first result row → `ResultRow` (see Row extraction mapping) |
| 10 | **Set variables** | assign each `ResultRow` column into its variable (mapping below) |
| 11 | **Set variable** `EndTime` | `%CurrentDateTime%` |
| 12 | **Write debug** | full extraction block (see Debug logging) |
| 13 | **Close Edge** | Browser `Browser` |

---

## Search-box interaction

1. **Locate the business-name search box** via its UI element selector (see Selector notes).
2. **Populate text field** — set its value to `%SearchTerm%` exactly (no normalization here; the test term is already exact).
3. **Apply the search** — click the search/apply control **or** send `{Enter}` into the box, whichever the live report responds to. Confirm which works during the first attended run and keep that one.
4. **Wait** for the table refresh condition above before extracting.

### Selector notes

Capture selectors with the PAD **UI element** recorder against the live report. Prefer, in order: `data-*` attributes → stable `id` / `name` → `role` + `aria-label`. **Avoid** positional/index paths and anything with dynamic session tokens.

| UI element | Selector anchor |
|---|---|
| Search box | `input` in the search/slicer visual; anchor on `aria-label` / placeholder |
| Apply control | button adjacent to the search box; accessible name |
| Result table | `role="grid"` / table container by its visual title |
| Loading indicator | the report's busy/spinner element (used for waits) |

Record the final selectors actually used at the bottom of this document after the first successful run.

---

## Row extraction mapping

Use **Extract data from web page** against the result-table visual. For a single match, extract the first data row into `ResultRow`, then map columns:

| `ResultRow` column | → Variable | Rule |
|---|---|---|
| Business Name | `BusinessName` | trimmed |
| Certificate Number | `CertificateNumber` | text; preserve leading zeros |
| Registration Date | `RegistrationDate` | keep displayed value as text; convert to `YYYY-MM-DD` in the submission sprint |
| Expiration Date | `ExpirationDate` | same; `""` if not displayed — never fabricated |
| Address | `Address` | trimmed |
| City | `City` | trimmed |
| State | `State` | trimmed |
| ZIP Code | `ZipCode` | text; preserve leading zeros |
| County | `County` | trimmed |

Read cells via the accessible UI tree — **never OCR or pixel scraping**. If any expected column is missing from the table, the layout changed: log it and stop rather than capturing partial data.

---

## Debug logging

Append to `%LogPath%` (plain text). One block per run.

**Start line** (step 2):

```
--- RUN 2026-10-06T13:04:02 search="ABCO Electric, LLC" ---
```

**Extraction block** (step 12):

```
result: ok
  BusinessName      = "ABCO ELECTRIC, LLC"
  CertificateNumber = "064321"
  RegistrationDate  = "2024-03-15"
  ExpirationDate    = "2026-03-31"
  Address           = "123 RAHWAY AVE"
  City              = "AVENEL"
  State             = "NJ"
  ZipCode           = "07001"
  County            = "MIDDLESEX"
  duration          = 29s
```

**Failure line** (any step that throws):

```
result: FAILED at step <n>: <error message>
```

**Never log:** credentials, tokens, cookies, or any future API key. This sprint has no keys, but keep the rule for consistency.

---

## Definition of done

1. Flow launches Edge, loads the report, and waits on the visual container (no fixed delays).
2. Search for `ABCO Electric, LLC` applies and the table refreshes.
3. The first result row is extracted into `ResultRow`.
4. All nine variables are non-blank in the debug log.
5. The browser closes cleanly.
6. The selectors actually used are recorded in Selector notes above.

Once this passes three consecutive attended runs, proceed to queue polling and result submission per `docs/NJ_PWC_PAD_BUILD.md`.
