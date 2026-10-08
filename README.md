This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open the URL configured by `APP_URL` with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Dashboard Custom Export

The Dashboard **Export** button opens Custom Export. Choose the current
Dashboard results (the current card and search), or all accessible contractors,
including inactive contractors. Select fields and download Excel or CSV.
Exports have one row per contractor. Dates are `YYYY-MM-DD`; repeated project
names and numbers are semicolon-separated. Project assignments and tiered-sub
relationships include active relationships only.

Compliance numbers, dates, and statuses use active, current compliance records
and active compliance types, never synced records or contractor master
registration numbers. Conflicting active/current records do not block export:
the affected compliance fields are blank, and the default-selected **Data Warning**
field in **Data Quality** describes each conflict, separated by semicolons.
The completion message counts affected contractors, not individual conflicts.
When Data Warning is deselected, a warning and explicit download confirmation
are shown before downloading a file that omits the warnings. The dialog stays
open after download to show the completion message. Latest follow-up uses follow-up date
descending, then creation date descending, matching the contractor detail page.

All retrieval uses the signed-in Supabase client and Row Level Security.
Additional row data is loaded only when Export is confirmed; the dialog loads
only an exact contractor count on opening. Active/current compliance is checked
on every export, even when compliance fields are deselected, so warnings are
not silently missed. Closing aborts pending requests.
Excel uses one `Contractors` worksheet, text-preserving cells, and bounded
column widths. CSV includes a UTF-8 BOM and protects formula-like text.
Header freezing is not supported by the installed SheetJS export API.

DBA, EIN, Website, insurance carriers/policy numbers, Automobile/Umbrella
coverage, and a next follow-up date are omitted because they are not available
in the verified contractor/export models. Stable field IDs and the export
configuration support future presets; no templates or schema changes are
implemented.

Run the isolated export tests with `node scripts\test-custom-export.mjs`.
These tests use synthetic data and do not access Supabase.

## Saved Export Templates

Apply `supabase\20261008_saved_export_templates.sql` after the existing user
management migrations. It creates template storage, RLS, personal preferences,
and two protected system templates: **Contractor Master Export** (26 fields,
Contractors category) and **Insurance Expiration Export** (10 fields, Insurance
category). Both default to Excel, All Contractors, and company-name order.
No existing contractor, compliance, insurance, or import records are changed.

Manage templates in the **Saved Export Templates** section of Import / Export.
Create, edit, duplicate, and delete use the existing imports Add/Edit/Delete
permissions; ownership is also enforced by RLS. System templates can only be
duplicated. Only administrators may publish shared templates. Category organizes
templates (Contractors, Compliance, Insurance, Projects, Executive, Personal);
it does not grant access. Personal category is independent of private visibility.
Favorites and the single default template are per user.

Dashboard Export lists templates grouped/filterable by category and offers
**Run**, **Review settings**, and **Create Custom Export**. Reviewing changes
settings for that run only; save permanent changes in Import / Export.
Current Dashboard Results uses the current visible IDs, never saved IDs.
All Contractors ignores Dashboard filters. Additional filters narrow the export
scope only: status/vendor equality, case-insensitive state equality, and
case-insensitive city/name contains, combined with AND.
Sorting supports company name, Sage ERP ID, city, state, and ZIP; contractor ID
breaks ties. Column order is saved with stable field IDs, independent of labels.
Invalid/retired fields or unsupported versions require explicit review/repair
before execution; they are never silently omitted.

New templates default-select Data Warning. Deliberate removal is preserved, and
the pre-download warning confirmation remains in place. Compliance stays
active/current-authoritative, ambiguous fields stay blank, and one contractor's
conflict does not block other rows. Templates do not elevate source-data access.
A missing migration shows an explicit loading error while ad hoc export remains
available.

Run `node scripts\test-custom-export.mjs` and
`node scripts\test-export-templates.mjs` for synthetic unit tests.
Run `supabase\tests\saved_export_templates.sql` only against an isolated test
database with the migration installed; its synthetic fixtures are rolled back.

## Contractor Active Follow-Ups

The right side of Contractor Detail lists **Active Follow-Ups** with Open or
Waiting Response status. Each keyboard-accessible card opens the existing
follow-up editor, including date, method, related compliance record, subject,
notes, and status. Confirmed saves update the list immediately; Closed and
Resolved items leave the active list but remain in Follow-Up History.
Failed saves leave the editor open and the active item unchanged.
The Related Compliance Record selector groups all loaded active/current and
historical compliance records, including registration numbers. It preserves an
existing historical or unavailable record association in `compliance_record_id`;
None is selected only when no association exists or the user chooses it.
Empty groups are hidden; contractors without saved compliance records see an
explanation rather than selectable-looking type headings.
Insurance follow-ups use Subject and Notes (for example, "General Liability
Expiring" or "Workers Compensation Missing"), with no dedicated insurance link.
Related Item categories are approved for the next focused Follow-Ups Phase 1
feature, but are not implemented in this checkpoint. The roadmap uses primary
**Related Item** (None/General, existing compliance types, Certificate of
Insurance, General Liability, Workers Compensation) and optional **Specific
Compliance Record**, without insurance-record relationships. Its migration,
specification, and deployment plan require final review before implementation.
Successful updates do not require a returned row: the edited values
update local state, followed by the existing database reload. Zero-row updates
are reported as errors, rather than displaying a successful local edit.
Existing history filters and database audit behavior are preserved.

If production has only the original development SELECT/INSERT policies,
apply `supabase\20261008_contractor_followups_update_policy.sql` after verifying
the granular user-management permission function is installed. This transactional,
re-runnable repair restores only the authenticated UPDATE policy, using
`user_has_module_permission('followups', 'edit')` for both USING and WITH CHECK.
It changes no records, relationship fields, other policies, or audit triggers.
Live status-transition verification succeeded after the repair. The live audit
query returned no entries for those test updates; production audit recording
remains an outstanding verification item, not a claimed result of this repair.

Run `node scripts\test-active-followups.mjs` for synthetic tests without
database access.

## Tiered Sub Relationships

Contractor Detail displays active parent/sub relationships on the right.
Contractor names link to Contractor Detail. **Shared Assigned Projects** are
the intersection of the parent's and sub's active project assignments, regardless
of project status; they do not establish project-specific subcontracting.
Project numbers link to the existing Projects detail modal using `projectId`.
Manage Tiered Subs retains assignment/removal controls, and Tiered Subs History
remains unchanged.

Supplemental Compliant/Expiring/Non-Compliant badges reuse the Dashboard's
existing compliance and insurance record-building and company-status logic.
The panel batches compliance, insurance, and project-assignment reads for all
displayed subs; there are no per-row requests. Large batches are chunked and
multi-row results are paginated. Status failures do not block relationship
navigation or project links and display an explicit unavailable message.
No synced compliance records are used and no schema changes are required.

Run `node scripts\test-tiered-sub-relationships.mjs` for synthetic tests.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
