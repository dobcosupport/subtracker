import { normalizeCompanyName } from "@/lib/contractor-matching";
import type { ProcoreCompany, ProcoreContact, ProcoreDecisions, ProcoreIdentityMatches, ProcoreIdentityStatus, ProcorePreview, ProcoreReference, ProcoreRow } from "@/types/procore-import";

export const procoreVendorKey = normalizeCompanyName;
export const procoreContactNameKey = (name: string) => name.trim().toLowerCase().replace(/\s+/g, " ");
export const blankProcoreDecisions = (): ProcoreDecisions => ({ vendors: {} });
const unique = (values: string[]) => [...new Set(values.map((v) => v.trim()).filter(Boolean))];
const companyFields = {
  phone: "Company (Vendor) > Business Phone", address_1: "Company (Vendor) > Address",
  city: "Company (Vendor) > City", state: "Company (Vendor) > State", zip_code: "Company (Vendor) > Zip",
} as const;

/** Company identity for one vendor group: first row's name; other fields only when every row agrees. */
export function procoreCompany(source: ProcoreRow[]): { company: ProcoreCompany; conflicts: (keyof typeof companyFields)[] } {
  const company: ProcoreCompany = { company_name: source[0]["Company (Vendor) > Name"].trim(),
    phone: null, address_1: null, city: null, state: null, zip_code: null };
  const conflicts: (keyof typeof companyFields)[] = [];
  for (const [field, heading] of Object.entries(companyFields) as [keyof typeof companyFields, typeof companyFields[keyof typeof companyFields]][]) {
    const values = unique(source.map((r) => r[heading]));
    company[field] = values.length === 1 ? values[0] : null;
    if (values.length > 1) conflicts.push(field);
  }
  return { company, conflicts };
}

/**
 * Candidates for the central contractor identity matcher: every vendor not already bound to a
 * contractor by a saved Procore vendor mapping.
 */
export function procoreIdentityCandidates(rows: ProcoreRow[], reference: ProcoreReference) {
  const groups = new Map<string, ProcoreRow[]>();
  for (const row of rows) {
    const key = procoreVendorKey(row["Company (Vendor) > Name"]);
    if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const mapped = new Set(reference.vendors.map((v) => v.vendor_key));
  return [...groups].filter(([key]) => !mapped.has(key))
    .map(([key, source]) => ({ candidate_key: key, source: "PROCORE", procore_vendor_key: key, ...procoreCompany(source).company }));
}

const describeMatch = (m: { contractor_id: number; company_name: string; signals: string[]; active: boolean }) =>
  `${m.company_name} (#${m.contractor_id}${m.active ? "" : ", inactive"}; ${m.signals.join(", ").replaceAll("_", " ")})`;

export function buildProcorePreview(rows: ProcoreRow[], decisions: ProcoreDecisions, reference: ProcoreReference, imported: number[] = [],
  identityByVendor?: ProcoreIdentityMatches): ProcorePreview {
  const importedSet = new Set(imported);
  const projects = new Map<string, ProcorePreview["projects"][number]>();
  const groups = new Map<string, ProcoreRow[]>();
  for (const row of rows) {
    const key = procoreVendorKey(row["Company (Vendor) > Name"]);
    const group = groups.get(key) ?? [];
    group.push(row); groups.set(key, group);
    const number = row["Project > Number"].trim();
    const project = projects.get(number);
    if (project) project.rows.push(row.row);
    else {
      const mapping = reference.projectMappings?.find((p) => p.source_number === number);
      const matches = reference.projects.filter((p) => mapping ? p.id === mapping.project_id : p.project_number === number && !!number);
      projects.set(number, { number, projectId: matches.length === 1 ? matches[0].id : null,
        mapped: !!mapping, targetNumber: matches.length === 1 ? matches[0].project_number : undefined, rows: [row.row] });
    }
  }
  const preview: ProcorePreview = {
    summary: { sourceRows: rows.length, contractors: groups.size, projects: projects.size, contacts: 0,
      assignments: 0, readyAssignments: 0, importedRows: imported.length, unresolvedRows: 0 },
    vendors: [], projects: [...projects.values()], contacts: [], ready: [],
  };
  const allAssignments = new Set<string>();
  const readyAssignments = new Set<string>();
  const allContacts = new Set<string>();
  const allContractors = new Set<string>();
  const readyRows = new Set<number>(imported);
  const contractorForVendor = (key: string) => {
    const choice = Object.hasOwn(decisions.vendors, key) ? decisions.vendors[key] : undefined;
    const selected = choice?.action === "UNMATCHED" ? null : choice?.action === "MATCH" ? choice.contractorId
      : reference.vendors.find((v) => v.vendor_key === key)?.contractor_id;
    return reference.contractors.find((c) => c.id === selected);
  };
  const contactSources = new Map<string, ProcoreRow[]>();
  const reviewedContacts = new Set<string>();
  for (const [key, source] of groups) {
    const contractor = contractorForVendor(key);
    const identity = contractor ? `id:${contractor.id}` : `vendor:${key}`;
    contactSources.set(identity, [...(contactSources.get(identity) ?? []), ...source]);
  }
  for (const [key, source] of groups) {
    const issues: string[] = [];
    const { company, conflicts } = procoreCompany(source);
    const companyConflict = conflicts.length > 0;
    for (const field of conflicts) issues.push(`Conflicting company ${field}; Add Contractor requires a consistent value. Existing company data will not be changed.`);
    const choice = Object.hasOwn(decisions.vendors, key) ? decisions.vendors[key] : undefined;
    const saved = reference.vendors.find((v) => v.vendor_key === key);
    const contractor = contractorForVendor(key);
    const candidates = reference.contractors.filter((c) => procoreVendorKey(c.company_name) === key);
    const addContractor = choice?.action === "ADD" && !saved;
    const override = choice?.action === "ADD" ? choice.duplicateOverride : undefined;
    const overrideValid = !!override && candidates.length === 1 && candidates[0].id === override.contractorId &&
      candidates[0].company_name === override.companyName && !!override.approvedBy && !!override.approvedAt;
    // Central identity matches (server-supplied); without them the legacy exact-name rule applies unchanged.
    const identityMatches = identityByVendor && Object.hasOwn(identityByVendor, key) ? identityByVendor[key] : undefined;
    let identityStatus: ProcoreIdentityStatus | undefined;
    if (identityMatches) {
      const blocking = identityMatches.filter((m) => m.disposition === "use_existing" || m.disposition === "hard_block");
      const required = identityMatches.filter((m) => m.disposition === "review_required");
      const matchIds = identityMatches.map((m) => m.contractor_id);
      const review = choice?.action === "ADD" ? choice.identityReview : undefined;
      const reviewValid = !!review && !override && !!review.decisionId && !!review.approvedBy && !!review.approvedAt &&
        required.every((m) => review.candidateIds.includes(m.contractor_id)) && review.candidateIds.every((id) => matchIds.includes(id));
      const legacyValid = !!override && overrideValid && required.every((m) => m.contractor_id === override.contractorId);
      identityStatus = blocking.length ? "blocked" : !required.length ? "clear" : reviewValid || legacyValid ? "approved" : "review_required";
      if (addContractor && identityStatus === "blocked") {
        issues.push(`SubTracker found an existing contractor for this company: ${blocking.map(describeMatch).join("; ")}. Accept Match; a separate contractor cannot be created.`);
      } else if (addContractor && identityStatus === "review_required") {
        issues.push(review || override
          ? "The different-company review is out of date because the possible existing contractors changed. Review the current possible matches again before Add Contractor."
          : `Possible existing contractor: ${required.map(describeMatch).join("; ")}. Accept Match, choose another contractor, or confirm this is a different company with a reason.`);
      }
    }
    if (!key || company.company_name.length > 250) issues.push("A reliable company name of at most 250 characters is required.");
    if (!identityMatches && addContractor && (override ? !overrideValid : candidates.length)) issues.push(override
      ? "Duplicate-name override is stale or unverified. Review the current suggestion and approve Add Contractor again."
      : "A matching normalized contractor already exists. Accept Match, choose another contractor, or explicitly approve creating a separate contractor.");
    if (!contractor && !addContractor) issues.push("Leave Unmatched, or explicitly approve Match Contractor / Add Contractor.");
    for (const number of new Set(source.filter((r) => !importedSet.has(r.row)).map((r) => r["Project > Number"].trim()))) {
      if (projects.get(number)?.projectId == null) {
        issues.push(`Unmatched project number ${number || "(blank)"}; rows for this project are not import-ready. An exact existing Project Number or approved Procore project mapping is required; no project will be created.`);
      }
    }
    const addReady = identityMatches ? identityStatus === "clear" || identityStatus === "approved"
      : override ? overrideValid : !candidates.length;
    const canImport = !!key && company.company_name.length <= 250 &&
      (!!contractor || (addContractor && addReady && !companyConflict));
    preview.vendors.push({ key, name: company.company_name, sourceRows: source.map((r) => r.row),
      contractorId: contractor?.id ?? null, addContractor, company, issues,
      suggestions: identityMatches
        ? identityMatches.filter((m) => m.disposition !== "informational").map((m) => ({ id: m.contractor_id, label: m.company_name }))
        : candidates.map((c) => ({ id: c.id, label: c.company_name })),
      ...(identityMatches ? { identityMatches, identityStatus } : {}) });
    const identity = contractor ? `id:${contractor.id}` : `vendor:${key}`;
    allContractors.add(identity);
    const contactGroups = new Map<string, ProcoreRow[]>();
    const sourceRows = new Set(source.map((r) => r.row));
    const validSource = source.filter((r) => projects.get(r["Project > Number"].trim())?.projectId != null);
    for (const row of source) {
      const number = row["Project > Number"].trim();
      const projectId = projects.get(number)?.projectId;
      allAssignments.add(`${identity}:${projectId == null ? `number:${number}` : `project:${projectId}`}`);
    }
    for (const row of contactSources.get(identity) ?? source) {
      const email = row["User > Email Address"].trim().toLowerCase();
      const name = procoreContactNameKey(row["User > Full Name"]);
      if (!email && !name) continue;
      const contactKey = email ? `email:${email}` : `name:${name}`;
      const group = contactGroups.get(contactKey) ?? [];
      group.push(row); contactGroups.set(contactKey, group);
    }
    const ambiguousNames = new Set<string>();
    for (const [contactKey, nameRows] of contactGroups) {
      if (!contactKey.startsWith("name:")) continue;
      const name = contactKey.slice(5);
      const emailGroups = [...contactGroups].filter(([key, group]) => key.startsWith("email:") &&
        group.some((r) => procoreContactNameKey(r["User > Full Name"]) === name));
      if (emailGroups.length === 1) {
        emailGroups[0][1].push(...nameRows);
        contactGroups.delete(contactKey);
      } else if (emailGroups.length > 1) ambiguousNames.add(name);
    }
    const contacts: ProcoreContact[] = [];
    for (const [contactKey, contactRows] of contactGroups) {
      const names = unique(contactRows.map((r) => r["User > Full Name"]));
      const emails = unique(contactRows.map((r) => r["User > Email Address"].toLowerCase()));
      const business = unique(contactRows.map((r) => r["User > Business Phone"]));
      const mobile = unique(contactRows.map((r) => r["User > Cell Phone"]));
      const contact: ProcoreContact = { contact_name: names[0] ?? "", email: emails[0] ?? null,
        business_phone: business[0] ?? null, mobile_phone: mobile[0] ?? null, rows: contactRows.map((r) => r.row) };
      let matches = contractor ? reference.contacts.filter((c) => c.contractor_id === contractor.id &&
        (contact.email ? c.email?.trim().toLowerCase() === contact.email
          : procoreContactNameKey(c.contact_name) === procoreContactNameKey(contact.contact_name))) : [];
      if (!matches.length && contractor && contact.email) matches = reference.contacts.filter((c) =>
        c.contractor_id === contractor.id && !c.email?.trim() &&
        procoreContactNameKey(c.contact_name) === procoreContactNameKey(contact.contact_name));
      const contactIdentity = `${identity}:${matches.length === 1 ? `existing:${matches[0].id}` : contactKey}`;
      allContacts.add(contactIdentity);
      let issue: string | null = null;
      if ((!contact.email && ambiguousNames.has(procoreContactNameKey(contact.contact_name))) ||
        !contact.contact_name || new Set(names.map(procoreContactNameKey)).size > 1 || business.length > 1 || mobile.length > 1 ||
        (contact.email && !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(contact.email))) {
        issue = "Contact is missing a name or has conflicting/invalid values; contact skipped, project assignment still qualifies.";
      } else if (matches.length > 1) {
        issue = "Multiple existing contacts match; contact skipped, project assignment still qualifies.";
      } else if (matches.length === 1) {
        issue = "Existing contact retained unchanged (including inactive status and communication preferences). Review any source differences in Contacts.";
      }
      if (!reviewedContacts.has(contactIdentity)) {
        preview.contacts.push({ ...contact, vendor: company.company_name, existingId: matches.length === 1 ? matches[0].id : null, issue });
        reviewedContacts.add(contactIdentity);
      }
      const importableRows = contactRows.filter((r) => sourceRows.has(r.row) && !importedSet.has(r.row) &&
        projects.get(r["Project > Number"].trim())?.projectId != null);
      if ((!issue || (matches.length === 1 && issue.startsWith("Existing contact"))) && importableRows.length) {
        contacts.push({ ...contact, rows: importableRows.map((r) => r.row) });
      }
    }
    const pending = validSource.filter((r) => !importedSet.has(r.row));
    if (canImport && pending.length) {
      const assignments = [...new Set(pending.map((r) => r["Project > Number"].trim()))].map((number) => ({
        projectId: projects.get(number)!.projectId!, number,
        rows: pending.filter((r) => r["Project > Number"].trim() === number).map((r) => r.row),
      }));
      for (const row of pending) readyRows.add(row.row);
      for (const assignment of assignments) readyAssignments.add(`${identity}:${assignment.projectId}`);
      preview.ready.push({ key, company, contractorId: contractor?.id ?? null, createContractor: !contractor && addContractor,
        assignments, contacts, rows: pending.map((r) => r.row) });
    }
  }
  preview.summary.contacts = allContacts.size;
  preview.summary.contractors = allContractors.size;
  preview.summary.assignments = allAssignments.size;
  preview.summary.readyAssignments = readyAssignments.size;
  preview.summary.unresolvedRows = rows.filter((r) => !readyRows.has(r.row)).length;
  return preview;
}
