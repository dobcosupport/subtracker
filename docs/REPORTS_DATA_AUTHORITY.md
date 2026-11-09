# Reports data authority

The Reports workspace retains the selected project ID across all seven tabs.
Project labels use `Project Number - Project Name`. Filtering and assignment
projection never change stored assignments.

## Project Compliance

For a selected project, the report reuses the existing Compliance Status
FEIN / NJ BRC / NJ PWC assessment. Only active assignments to that project form
the population. Another project's Public Works eligibility cannot qualify the
selected project. Unknown authority remains Needs Review, not Compliant.

The existing columns remain Contractor, Status, Assigned Projects, Compliance
Issues and Insurance Issues. The screen/PDF identify the selected project once
in the report header and use "Selected project" in the assignment column.
CSV/XLSX retain the actual selected project label. All Projects retains the
report's existing broader aggregate behavior.

Insurance Issues are existing MyCOI coverage observations, not evidence that a
project imposes an insurance requirement. Material Only retains its authoritative
classification; observations remain visible without inventing applicability.

## Insurance

The existing MyCOI policy reader and coverage aggregation remain authoritative:
active/current policies, active matching vendor mapping, and latest qualifying
General Liability / Workers Compensation expiration. Project selection scopes
the contractor population through active assignments only. It does not create
project-specific insurance requirements.

The Insurance report uses the shared inclusive calendar-day expiration classifier:
0-30 red, 31-60 orange, 61-90 yellow, 91+ Current; before today is Expired.
The existing source observation "Active Compliance Records" remains unchanged
and is not presented as an insurance requirement.

## Follow-Up: project attribution unavailable

`contractor_followups` has a contractor foreign key and an optional
`compliance_record_id`. The related-item migration also supports
`compliance_type_id` and `insurance_item_key`. Neither the table model nor its
related-item validation establishes a project ID or follow-up-to-project link.
Compliance records and insurance item keys are contractor-level, too.

Evidence:

- [Original table](../supabase/20260924_contractor_followups.sql)
- [Related-item validation](../supabase/20261008_followup_related_items.sql)
- [Application model](../types/database.ts)
- [Follow-Up reader and workflow](../services/followups.ts)

A contractor assignment alone cannot attribute a particular Follow-Up to a
project. Subject/notes text is not an authoritative relationship.

With a project (or Unassigned) selected, Reports keeps that selection but displays
an explicit attribution-unavailable notice instead of guessing or silently
showing All Projects records. CSV/XLSX and scoped Custom Export are disabled.
The PDF contains the selected context, original column headers and the limitation
notice, with no attributed rows. It is not a claim that the project has zero
Follow-Ups.

All Projects retains the existing contractor-level records, columns, dates,
status/search filters and exports. The underlying Follow-Up workflow is unchanged.
Enabling genuine project scoping would require an approved authoritative
follow-up/project relationship, population/backfill rules and access validation.
No database or workflow changes are included here.
