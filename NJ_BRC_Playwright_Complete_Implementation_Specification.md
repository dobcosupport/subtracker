# NJ BRC Playwright Worker: Complete Implementation Specification

## Instruction to VS Copilot

Begin implementation of the NJ BRC Playwright worker now.

Do not perform another broad architecture-only pass. Inspect the existing NJ PWC worker and existing NJ BRC scaffolding, then implement the NJ BRC workflow end to end using the requirements below.

Work through reasonable implementation details without repeatedly stopping for confirmation. Only stop if a human-verification challenge must be completed manually, production SQL must be approved, or a destructive or unrecoverable action would be required.

Do not apply production migrations, commit, push, or enable Auto Approve without approval.

---

## 1. Target Website

NJ BRC website:

https://www1.state.nj.us/TYTR_BRC/jsp/BRCLoginJsp.jsp

---

## 2. Primary Goal

Create a separate NJ BRC Playwright worker that:

1. Retrieves queued NJ BRC requests from SubTracker.
2. Opens the NJ BRC website.
3. Uses the contractor's approved NJ BRC lookup inputs.
4. Handles the human-verification state safely.
5. Extracts the Business Registration Certificate.
6. Sends the extracted result and sanitized evidence back to SubTracker.
7. Creates a Review Required item.
8. Allows approved NJ BRC data to populate a non-expiring authoritative compliance record.
9. Reports telemetry to Worker Health.
10. Does not modify NJ PWC extraction logic.

---

## 3. Implementation Strategy

Reuse the existing NJ PWC operational framework where practical:

- Worker folder structure
- Environment loading
- Queue polling
- Atomic request claiming
- Structured logging
- Worker Health telemetry
- Instance identifiers
- Code-hash and Restart Required detection
- Test Worker readiness acknowledgement
- Error reporting
- Review Queue integration
- Compliance Sync permissions
- Manual restart documentation

Keep NJ BRC website selectors, form logic, result extraction, and field mapping in a separate NJ BRC adapter.

Do not place NJ BRC selectors inside the NJ PWC adapter.

Create a separate worker folder:

```text
worker/nj-brc
```

Do not create a second NJ PWC process or combine the two workers into one browser process unless the existing architecture absolutely requires it and the reason is documented.

---

## 4. NJ BRC Lookup Inputs

Use these three separate contractor fields.

### 4.1 NJ BRC Number

Database field:

```text
nj_brc_number
```

Meaning:

```text
Business Entity ID
```

Website field:

```text
Business Entity ID
```

Runtime handling:

Direct text mapping unless attended website validation proves a specific formatting rule is required.

### 4.2 BRC Name Control

Database field:

```text
brc_name_control
```

Meaning:

```text
Name Control
```

Website field:

```text
Name Control
```

Runtime handling:

Direct mapping. Preserve the contractor's stored value.

### 4.3 Taxpayer ID (FEIN)

Database field:

```text
federal_tax_id
```

Meaning:

Federal Employer Identification Number used to produce the NJ BRC Taxpayer ID submission value.

Website field:

```text
Taxpayer ID
```

These three values must remain separate and must never overwrite or substitute for one another.

---

## 5. FEIN Transformation Rule

Create one dedicated helper:

```text
normalizeFederalTaxIdForNjBrcLookup()
```

Rules:

1. Treat FEIN as text, never as a number.
2. Remove dashes, spaces, and other formatting.
3. Preserve leading zeros.
4. Validate that the normalized stored FEIN contains exactly 9 digits.
5. Append three zeros.
6. Submit the resulting 12-digit value to the NJ BRC website.
7. Never save the transformed value back to SubTracker.

Examples:

```text
Stored:      12-3456789
Normalized:  123456789
Submitted:   123456789000
```

```text
Stored:      001234567
Submitted:   001234567000
```

```text
Stored:      00-1234567
Normalized:  001234567
Submitted:   001234567000
```

Invalid FEIN values must not be submitted.

Return a clear validation result:

```text
Invalid Taxpayer ID (FEIN): expected 9 digits before NJ BRC formatting.
```

Never:

- Save the transformed value to `federal_tax_id`
- Overwrite `nj_brc_number`
- Overwrite `brc_name_control`
- Convert FEIN to a number
- Alter imports or exports during request submission
- Use FEIN in compliance-status calculations
- Use FEIN in expiration calculations
- Use FEIN for reminder generation

---

## 6. Human Verification and CAPTCHA

The first lookup during an active NJ BRC browser session may display a human-verification checkbox.

Required behavior:

1. Detect the challenge.
2. Do not bypass or automate the human-verification control.
3. Keep the browser session open.
4. Report worker state:

```text
Human Verification Required
```

5. Display that state in Compliance Sync Worker Health.
6. Do not classify the request as:
   - No Match Found
   - Registration invalid
   - Website Error
7. Allow an authorized person at the worker machine to complete the checkbox manually.
8. After verification succeeds, continue the pending request in the same browser session.
9. Reuse the verified active session for later requests until the website presents another challenge.
10. If verification is not completed within a bounded configurable period, keep the request recoverable and report a clear timeout.
11. Do not convert a verification timeout to No Match.

Never attempt to bypass CAPTCHA, Incapsula, or other site protections.

Operational states must distinguish:

- Ready
- Busy
- Human Verification Required
- Website Error
- Offline
- Restart Required

---

## 7. Attended Website Validation

Implement an attended validation or capture mode before finalizing live selectors.

The attended mode must:

1. Launch the NJ BRC site with a visible browser.
2. Allow manual human verification.
3. Use an explicitly approved known contractor.
4. Identify the actual input controls.
5. Identify the actual submit control.
6. Identify certificate-result labels and values.
7. Identify explicit no-result and invalid-input messages.
8. Detect website or protection-script pages.
9. Save sanitized selector diagnostics and screenshots locally for implementation evidence.
10. Avoid logging or capturing secrets beyond what is essential and approved.

Prefer robust Playwright locators:

- Associated labels
- Accessible roles
- Stable names
- Stable form attributes

Avoid brittle positional CSS selectors when better locators exist.

Do not claim live extraction works until one attended successful lookup has been completed.

---

## 8. Successful Result Page

A successful certificate page may contain:

```text
STATE OF NEW JERSEY
BUSINESS REGISTRATION CERTIFICATE
```

Observed or expected labels include:

- Taxpayer Name
- Trade Name
- Address
- Certificate Number
- Effective Date
- Date of Issuance
- For Office Use Only

Extract only fields confirmed on the live source.

Do not invent values.

---

## 9. Approved Result Mapping

### Taxpayer Name

Use as identity and review evidence.

Do not automatically rename the contractor.

### Trade Name

Use as review evidence.

Do not automatically overwrite contractor data.

### Address

Use as reviewable match evidence.

Do not automatically overwrite the contractor address.

### Certificate Number

After approval, store as:

```text
Compliance Record Registration Number
```

### Effective Date

After approval, store as:

```text
Compliance Record Effective Date
```

### Date of Issuance

Store as verification evidence if the existing staging schema safely supports it.

Do not use Date of Issuance as Effective Date.

### For Office Use Only

Treat as source evidence only.

Do not use it as:

- Registration Number
- Business Entity ID
- Compliance status

### Expiration Date

Always:

```text
NULL
```

---

## 10. Critical Identifier Rule

Contractor master:

```text
nj_brc_number = Business Entity ID used in the lookup
```

Compliance record:

```text
registration_number = Certificate Number returned by New Jersey after approval
```

Business Entity ID and Certificate Number must remain separate.

Never overwrite or substitute one for the other.

The contractor values below remain unchanged after lookup and approval:

- `nj_brc_number`
- `federal_tax_id`
- `brc_name_control`

---

## 11. NJ BRC Business Rules

NJ BRC is non-expiring.

Required rules:

- Expiration Date is `NULL`.
- No expiration date is required.
- No 90/60/30-day reminders.
- Missing expiration must not reduce compliance status.
- Effective Date does not imply expiration.
- Website failure does not invalidate existing NJ BRC data.
- Human verification does not invalidate existing NJ BRC data.
- No Match does not automatically remove or deactivate existing NJ BRC data.
- A failed lookup must preserve existing authoritative records.
- NJ BRC must not contribute expiration-related warnings or reminder queues.

Validate all deployed status and reminder consumers so they respect non-expiring compliance types. Do not silently rewrite historical records.

---

## 12. Search Request and Queue

Use a typed NJ BRC request tied to a specific contractor.

Snapshot these inputs when the request is created:

- `contractor_id`
- `company_name`
- `nj_brc_number`
- `brc_name_control`
- `federal_tax_id`
- Normalized 12-digit Taxpayer ID used for submission
- Request creation time

Do not allow later contractor edits to silently change an already queued request.

Prevent duplicate active NJ BRC requests for the same contractor where practical.

Use explicit request states:

- `pending`
- `claimed`
- `processing`
- `human_verification_required`
- `review_required`
- `completed`
- `no_match`
- `invalid_input`
- `identity_mismatch`
- `ambiguous_result`
- `website_error`
- `failed`

Do not create a second active request when the same contractor already has an NJ BRC request in:

- `pending`
- `claimed`
- `processing`
- `human_verification_required`
- `review_required`

Show the existing request and status instead.

If the existing shared request table safely supports NJ BRC, extend it using typed fields and constraints.

If it cannot preserve the NJ BRC input snapshot safely, create a narrow migration rather than overloading NJ PWC fields.

---

## 13. Worker-Side Claiming

Ensure one request is processed by one worker instance.

Do not merely retrieve the first pending request without claiming it.

Requirements:

1. Atomically claim the request before browser processing begins.
2. Record:
   - Worker key
   - Worker instance ID
   - Claim time
   - Processing start time
3. Prevent two NJ BRC workers from processing the same request concurrently.
4. Make repeated claims by the same worker idempotent where appropriate.
5. Detect abandoned claims after a reviewed timeout.
6. Do not automatically retry a request that may have successfully submitted the website form unless page state is known.
7. Preserve the request for investigation when claim recovery is uncertain.

If claiming requires an RPC or migration, include it in the proposed migration and test it in isolation.

---

## 14. Result Classification

### Successful Certificate

A Business Registration Certificate was returned and extracted.

### No Match

The website explicitly states that no certificate or registration was found for the submitted inputs.

No Match must be based on explicit source evidence, not the absence of an expected element.

### Invalid Input

The website rejects the Business Entity ID, Name Control, Taxpayer ID, or required format.

### Identity Mismatch

The returned taxpayer or business identity conflicts with the intended contractor.

### Ambiguous Result

The returned page contains incomplete or conflicting identity evidence.

### Human Verification Required

The website requires manual verification.

### Website Error

The expected form or result could not be reached because of:

- Source failure
- Changed markup
- Protection page
- Network failure
- Extraction failure
- Unexpected navigation state

### Failed

An internal worker or SubTracker processing failure occurred after bounded retries.

Never convert any of the following into No Match:

- Human Verification Required
- Website Error
- Extraction failure
- Navigation timeout
- Protection or challenge page
- Ambiguous Result
- Identity Mismatch
- Internal failure

---

## 15. Review Required Mode

Initial production mode must be:

```text
Review Required
```

Do not enable functional Auto Approve during the initial rollout.

A successful extraction must create a review item containing:

### Current Contractor Data

- Contractor ID
- Company name
- NJ BRC Number / Business Entity ID
- BRC Name Control
- Taxpayer ID (FEIN), masked

### Submitted Lookup Data

- Business Entity ID
- Name Control
- 12-digit Taxpayer ID, masked
- Request creation time

### Returned Certificate

- Taxpayer Name
- Trade Name
- Address
- Certificate Number
- Effective Date
- Date of Issuance
- Verification timestamp
- Source URL
- Match rationale
- Discrepancy warnings

Do not display or log full FEIN or full submitted 12-digit Taxpayer ID in ordinary UI, event history, or logs.

---

## 16. Approval

Implement NJ BRC-specific approval logic.

Do not reuse NJ PWC labels, expiration assumptions, or mappings unchanged.

Approval must:

1. Verify the review item belongs to the intended contractor.
2. Verify the compliance type is NJ BRC.
3. Verify the review item is still pending and has not already been processed.
4. Verify the extracted result represents a successful certificate.
5. Recheck permitted identity evidence.
6. Create or update the authoritative NJ BRC compliance record transactionally.
7. Preserve historical records.
8. Prevent uncontrolled duplicate active/current NJ BRC records.
9. Mark the review item approved only after the compliance-record transaction succeeds.
10. Record verification source, verified date, and audit information.

Approved compliance-record mapping:

```text
registration_number = Certificate Number
effective_date      = Certificate Effective Date
expiration_date     = NULL
active              = true, subject to existing authoritative-record rules
is_current          = true, subject to existing authoritative-record rules
```

Do not use Date of Issuance as Effective Date.

Do not use For Office Use Only as Registration Number.

Never overwrite:

- `contractor.nj_brc_number`
- `contractor.federal_tax_id`
- `contractor.brc_name_control`
- Contractor company name
- Contractor address

If no NJ BRC compliance record exists, approval must be able to create one safely.

If a current NJ BRC record exists, follow established history/current-record rules. Do not create multiple uncontrolled current records.

---

## 17. Rejection and Exceptions

Rejecting a review item must not remove existing authoritative contractor or compliance data.

The following must never automatically deactivate an existing NJ BRC compliance record:

- No Match
- Website Error
- Human Verification Required
- Invalid Input
- Identity Mismatch
- Ambiguous Result
- Failed

Preserve the evidence and reason for review disposition.

---

## 18. Auto Approve

Keep the setting visible if it already exists, but treat operational Auto Approve as locked or unverified during initial deployment.

Do not automatically write through NJ BRC results until Review Required works end to end.

Later, Auto Approve may be enabled only when:

1. The setting is explicitly enabled.
2. Exactly one successful certificate result exists.
3. Returned identity evidence satisfies approved deterministic rules.
4. Submitted identifiers still match the request snapshot.
5. No contractor or identifier conflict exists.
6. No conflicting current NJ BRC compliance record exists.
7. The result is not synthetic or test mode.
8. The result is not:
   - No Match
   - Invalid Input
   - Identity Mismatch
   - Ambiguous Result
   - Human Verification Required
   - Website Error
   - Failed
9. The same transactional approval operation used by manual approval succeeds.

Any uncertainty must fall back to Review Required.

---

## 19. Worker Health

Add a live NJ BRC Worker card to Compliance Sync Worker Health.

Worker key:

```text
nj-brc
```

Display name:

```text
NJ BRC Worker
```

Telemetry must include:

- Running / Degraded / Offline
- Ready / Busy / Human Verification Required
- Last heartbeat
- Browser connected
- Last successful queue poll
- Current request ID
- Last successful lookup
- Last result
- Last error
- Worker start time
- Loaded code hash
- Current code hash
- Restart Required
- Test Worker acknowledgement
- Recent sanitized logs

The NJ BRC Worker must have its own identity and must not reuse the NJ PWC worker identity.

Keep these planned cards unchanged:

- NY Worker
- Reminder Automation Worker
- Email Notification Worker

---

## 20. Test Worker

The NJ BRC Test Worker action must confirm:

- Worker is reporting telemetry.
- Browser is connected.
- Queue polling is working.
- Worker can acknowledge the diagnostic request.
- Current instance is responsive.

Test Worker must not:

- Submit a real NJ BRC lookup.
- Trigger human verification.
- Create a review item.
- Modify contractor data.
- Modify compliance data.

---

## 21. Logging

Use structured logs for:

- `worker_start`
- `worker_stop`
- `heartbeat`
- `queue_poll`
- `request_claimed`
- `request_processing`
- `human_verification_required`
- `human_verification_completed`
- `request_processed`
- `no_match`
- `invalid_input`
- `identity_mismatch`
- `ambiguous_result`
- `website_error`
- `extraction_error`
- `result_posted`
- `test_acknowledged`

Sanitize all logs.

Never log:

- Full FEIN
- Full submitted 12-digit Taxpayer ID
- Secrets
- Cookies
- Session tokens
- Browser storage
- Full source HTML containing sensitive information
- Full unredacted certificates

Use masked values or one-way fingerprints when correlation is needed.

---

## 22. Evidence

Store only sanitized evidence needed for review and troubleshooting.

Allowed evidence may include:

- Returned taxpayer name
- Trade name
- Returned address
- Certificate Number
- Effective Date
- Date of Issuance
- Source URL
- Verification timestamp
- Sanitized result summary
- Selector or adapter version metadata

Do not store:

- Cookies
- Session tokens
- Browser storage
- Raw protection-page data
- Full unredacted FEIN
- Full submitted Taxpayer ID
- Unrestricted page HTML

If screenshots are supported, restrict access and redact or avoid sensitive taxpayer identifiers.

---

## 23. Error and Retry Behavior

Use bounded retries for transient failures.

Before each retry:

1. Reacquire the browser page and locators.
2. Confirm current page state.
3. Do not reuse stale ElementHandle objects.
4. Determine whether the prior submission may already have succeeded.
5. Do not blindly resubmit the form.
6. Log the attempt safely.
7. Stop after the configured retry limit.

A changed or protected website must produce a clear Website Error or Human Verification Required state, not a false No Match.

---

## 24. Session Management

Use a persistent Playwright browser context during the worker session so manually completed human verification can remain effective while permitted by the source.

Requirements:

- Keep the browser visible when attended human verification is required.
- Reuse the verified session for later requests.
- Detect when a new challenge appears.
- Close page, browser context, and browser cleanly on shutdown.
- Do not export session storage or cookies outside the controlled worker environment.
- Do not attempt to bypass website protections.

---

## 25. Configuration

Create a dedicated NJ BRC `.env` and `.env.example`.

Use environment variables for:

- SubTracker base URL
- Worker authentication and reporting credentials
- Poll interval
- Headless mode
- Retry limit
- Navigation timeout
- Human-verification timeout
- Log location
- Attended validation mode
- Evidence location, if approved

Do not hard-code credentials.

Keep NJ BRC worker credentials and telemetry identity distinguishable from NJ PWC.

---

## 26. Documentation

Document:

- Installation
- npm dependencies
- Playwright browser installation
- Environment configuration
- Attended validation mode
- Human-verification workflow
- Worker start command
- Manual restart command
- Worker Health behavior
- Queue states
- Review Required workflow
- Approval mapping
- Non-expiring NJ BRC rules
- FEIN transformation
- Troubleshooting
- Known website limitations
- Duplicate-instance warning
- Deployment order

Use this supported manual start command:

```powershell
powershell -ExecutionPolicy Bypass -File "D:\subtracker\worker\nj-brc\start-worker.ps1"
```

Warn administrators to stop an existing worker before starting another instance.

---

## 27. Expected Implementation Areas

Use existing project conventions. Expected areas include:

- `worker/nj-brc/package.json`
- `worker/nj-brc/worker.js`
- `worker/nj-brc/health.js`
- `worker/nj-brc/start-worker.ps1`
- `worker/nj-brc/.env.example`
- `worker/nj-brc/README.md`
- NJ BRC request and queue API
- NJ BRC result-ingestion API
- NJ BRC worker-health registration and telemetry
- NJ BRC Review Queue UI
- NJ BRC approval transaction
- Compliance Sync settings
- Contractor Detail NJ BRC action
- Add/Edit Contractor validation
- Supabase migrations
- Supabase acceptance tests
- Worker unit tests
- Synthetic browser fixture tests
- Application documentation

---

## 28. Preserve Existing Systems

Do not modify:

- NJ PWC extraction behavior
- Follow-Up Related Item behavior
- Saved Export Templates
- Custom Export
- Tiered Sub Relationships
- Existing insurance calculations
- Existing reminder rules
- Dashboard calculations

Do not introduce expiration or reminder behavior for NJ BRC.

Do not automatically rename contractors or overwrite contractor addresses.

---

## 29. Validation

Implement and validate as much as possible before requesting more input.

Required tests:

1. FEIN normalization with formatting removed.
2. Leading zeros preserved.
3. Invalid FEIN rejected before website submission.
4. Business Entity ID preserved.
5. Name Control preserved.
6. Human-verification challenge detected.
7. Challenge never classified as No Match.
8. Same-session continuation after manual verification.
9. Successful certificate parsing using approved synthetic fixtures.
10. Certificate Number mapped to Registration Number.
11. Effective Date parsed correctly.
12. Date of Issuance not substituted for Effective Date.
13. Expiration remains NULL.
14. No Match classified only from explicit source evidence.
15. Invalid Input classified correctly.
16. Identity Mismatch classified correctly.
17. Ambiguous Result classified correctly.
18. Website Error classified correctly.
19. Atomic queue claim.
20. Duplicate active-request prevention.
21. Duplicate-worker protection where supported.
22. Result-ingestion idempotency.
23. Review Required item creation.
24. Transactional NJ BRC approval.
25. Missing NJ BRC compliance record created on approval.
26. Existing NJ BRC record updated using approved history/current rules.
27. Contractor master identifiers remain unchanged.
28. Unauthorized approval blocked.
29. Auto Approve remains locked or unverified.
30. Worker Health telemetry.
31. Human Verification Required shown in Worker Health.
32. Test Worker acknowledgement.
33. Sanitized logging.
34. No full taxpayer identifier appears in logs.
35. Existing NJ PWC regression tests.
36. TypeScript.
37. Changed-file lint.
38. Isolated production build.

Use synthetic fixtures for automated source-page parsing tests.

Do not use production contractors for automated tests.

---

## 30. Deployment Gates

Before production deployment, provide:

1. Exact SQL for every migration.
2. Complete modified-file list.
3. Exact confirmed site selectors.
4. Selectors still pending attended validation.
5. Test results.
6. Remaining source-site uncertainties.
7. Confirmation that NJ PWC behavior is unchanged.
8. Confirmation that NJ BRC remains non-expiring.
9. Confirmation that taxpayer identifiers are sanitized.
10. Manual attended-validation instructions.
11. Database deployment order.
12. Application deployment order.
13. Worker installation and start order.
14. Worker Health verification steps.
15. Review Required acceptance-test steps.
16. Rollback guidance.

Do not apply production migrations without approval.

Do not commit or push without approval.

Do not enable Auto Approve.

Do not claim live NJ BRC extraction works until an attended successful lookup has been completed.

---

## 31. Expected Manual Interruptions

Continue implementation without repeated confirmation except when one of these occurs:

1. The NJ website presents human verification that must be completed manually.
2. Production SQL is ready and requires approval before application.
3. A destructive or unrecoverable operation would be required.
4. A source-site behavior makes the approved mapping impossible or materially different.

For non-destructive implementation details, make the safest choice consistent with existing SubTracker conventions, document the choice, and continue.
