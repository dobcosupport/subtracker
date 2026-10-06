# SubTracker — NJ PWC PAD First Live Extraction (Phase 2, Sprint 4)

Build spec for the first **working** Power Automate Desktop flow that extracts a **live** row from the NJ Public Works Power BI report.

> **Sprint 4 objective:** prove PAD can extract a real row. **No queue polling, no API posting, no SubTracker integration.** SubTracker is fully validated and is **not** modified.
>
> **Flow name:** `SubTracker - NJ PWC Extraction Test`
> **Test company:** `ABCO Electric, LLC` (single match)

---

## Field mapping (destination of record)

These mappings are proven in the validated SubTracker pipeline; the extraction must capture every field so the data can flow to them in a later sprint.

| Power BI column | PAD variable | SubTracker destination |
|---|---|---|
| Business Name | `BusinessName` | match field (not stored) |
| Certificate # | `CertificateNumber` | `contractors.nj_pwc_number` |
| Reg Date | `RegistrationDate` | `compliance_records.effective_date` |
| Exp Date | `ExpirationDate` | `compliance_records.expiration_date` |
| Address | `Address` | `contractors.address_1` |
| City | `City` | `contractors.city` |
| State | `State` | `contractors.state` |
| Zip | `ZipCode` | `contractors.zip_code` |
| County | `County` | `contractors.county` |

**Business Name is the match field** — it is used for the search and to confirm the returned row is the intended company; it is not itself written downstream.

---

## Variables

Declared once at the top of the flow. All extraction targets are **Text** to preserve leading zeros and displayed formatting.

| Variable | Type | Initial value |
|---|---|---|
| `ReportUrl` | Text | NJ PWC Power BI URL (below) |
| `SearchTerm` | Text | `ABCO Electric, LLC` |
| `Browser` | Browser | *(empty)* |
| `ResultRow` | Custom object | *(empty)* |
| `BusinessName` | Text | `""` |
| `CertificateNumber` | Text | `""` |
| `RegistrationDate` | Text | `""` |
| `ExpirationDate` | Text | `""` |
| `Address` | Text | `""` |
| `City` | Text | `""` |
| `State` | Text | `""` |
| `ZipCode` | Text | `""` |
| `County` | Text | `""` |
| `StartTime` | DateTime | *(empty)* |
| `EndTime` | DateTime | *(empty)* |
| `LogPath` | Text | `%SpecialFolder_Documents%\NJ_PWC_PAD_extraction.log` |

NJ PWC Power BI URL:

```
https://app.powerbigov.us/view?r=eyJrIjoiZmY1YmVjMzktMjc5ZS00NzQxLWFkMWQtYjYzZGRmN2JhNTViIiwidCI6IjUwNzZjM2QxLTM4MDItNGI5Zi1iMzZhLWUwYTQxYmQ2NDJhNyJ9
```

---

## Exact PAD actions

| # | PAD action | Configuration |
|---|---|---|
| 1 | **Set variable** `StartTime` | `%CurrentDateTime%` |
| 2 | **Write text to file** (debug) | `--- RUN %StartTime% search="%SearchTerm%" ---` → `%LogPath%` (append) |
| 3 | **Launch new Microsoft Edge** | Initial URL `%ReportUrl%`; Launch mode **New instance**; Window state **Normal** (visible — must be observable); Clear cache/cookies **Yes**; Output → `Browser` |
| 4 | **Wait for web page content** | Browser `Browser`; wait until the report visual container is rendered; Timeout **60 s** |
| 5 | **Write text to file** (debug) | `report loaded` → `%LogPath%` |
| 6 | **Populate text field** | Browser `Browser`; UI element = business-name search box; Text `'%SearchTerm%'` |
| 7 | **Click / Send keys** | apply the search (click the search/apply control, or `{Enter}` in the box — confirm which works on the live report and keep that one) |
| 8 | **Wait for web page content** | Browser `Browser`; wait until the result table finishes refreshing (loading indicator clears, ≥ 1 row present); Timeout **60 s** |
| 9 | **Extract data from web page** | Browser `Browser`; target = result table visual; mode = **table**; extract the first data row → `ResultRow` |
| 10 | **Set variables** | assign each `ResultRow` column to its variable (mapping table above) |
| 11 | **Set variable** `EndTime` | `%CurrentDateTime%` |
| 12 | **Write text to file** (debug) | full extraction block → `%LogPath%` |
| 13 | **Close Edge** | Browser `Browser` |

---

## Report load & table refresh waits

The report is an embedded Power BI iframe on an asynchronous canvas. **Never use fixed delays or screen coordinates.**

| Stage | Wait condition | Timeout |
|---|---|---|
| After launch (step 4) | report visual container rendered | 60 s |
| After search (step 8) | table loading indicator clears and ≥ 1 row present | 60 s |

---

## Search-box interaction

1. Locate the **business-name search box** by its UI element selector.
2. **Populate** it with `%SearchTerm%` exactly as given.
3. **Apply** the search (click apply or send `{Enter}` — whichever the live report honors; confirm on first run).
4. **Wait** for the table refresh condition before extracting.

### Selector guidance

Capture with the PAD **UI element** recorder against the live report, preferring: `data-*` → stable `id`/`name` → `role`+`aria-label`. Avoid positional/index paths and dynamic session tokens.

| UI element | Anchor |
|---|---|
| Search box | `input` in the search/slicer visual; `aria-label` / placeholder |
| Apply control | adjacent button; accessible name |
| Result table | `role="grid"` / table container by visual title |
| Loading indicator | report busy/spinner element (for waits) |

Record the selectors actually used in the table below after the first successful run.

---

## Row extraction mapping

Use **Extract data from web page** (table mode) against the result-table visual. For this single-match test, extract the **first data row** into `ResultRow`, then map:

| `ResultRow` column | → Variable | Rule |
|---|---|---|
| Business Name | `BusinessName` | trimmed; must equal the searched company |
| Certificate # | `CertificateNumber` | text; preserve leading zeros |
| Reg Date | `RegistrationDate` | displayed value as text (ISO conversion happens in the submission sprint) |
| Exp Date | `ExpirationDate` | displayed value as text; `""` if not shown — never fabricated |
| Address | `Address` | trimmed |
| City | `City` | trimmed |
| State | `State` | trimmed |
| Zip | `ZipCode` | text; preserve leading zeros |
| County | `County` | trimmed |

Read via the accessible UI tree — **no OCR or pixel scraping**. If an expected column is absent, the layout changed: log it and stop rather than capture partial data.

---

## Debug logging

Append plain text to `%LogPath%`. One block per run.

**Start** (step 2):
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

**Failure** (any step that throws):
```
result: FAILED at step <n>: <error message>
```

---

## Definition of done

1. Edge launches, the report loads, and the wait fires on the visual container (no fixed delays).
2. The search for `ABCO Electric, LLC` applies and the table refreshes.
3. The first row is extracted into `ResultRow`.
4. All nine variables are non-blank in the debug log.
5. `BusinessName` matches the searched company.
6. The browser closes cleanly; the selectors used are recorded above.

After three consecutive attended passes, proceed to queue polling and submission per `docs/NJ_PWC_PAD_BUILD.md`.
