import { parseMycoiPolicies } from "@/lib/mycoi-parser";
import { normalizeCompanyName } from "@/lib/contractor-matching";
import type { DivisionReview, ImportDecisions, ImportPreview, ImportReference, SourceRow, VendorPlan } from "@/types/mycoi-import";

// Match the foundation's generated lower(btrim(...)) keys without discarding raw tabs.
export const mycoiKey = (value: string) => value.replace(/^ +| +$/g, "").toLowerCase();
export const policyLineKey = (value: string) => mycoiKey(value).replace(/\s+/g, " ");
export const blankDecisions = (): ImportDecisions => ({ vendors: {}, divisions: {}, contacts: {}, ignored: [], addContractors: [] });
const statuses = new Set(["Compliant Finalized", "Compliant In-Progress", "Non-Compliant Finalized", "Non-Compliant In-Progress", "Undecided In-Progress", "Unregistered"]);
export const placeholderEmail = (value: string) => value.trim().toLowerCase() === "vendorasagent@mycoitracking.com";
export const safeEmail = (value: string) => !placeholderEmail(value) && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value.trim());
export function safePhone(value: string): boolean {
  const base = value.trim().replace(/\s*(?:ext\.?|x)\s*\d{1,6}$/i, "");
  if (!/^\+?[\d ().-]+$/.test(base) || (base.match(/\(/g)?.length ?? 0) !== (base.match(/\)/g)?.length ?? 0)
    || /[()]/.test(base.replace(/\(\d{3}\)/g, ""))) return false;
  const digits = base.replace(/\D/g, "");
  return base.startsWith("+") ? digits.length >= 8 && digits.length <= 15 : digits.length === 10 || (digits.length === 11 && digits.startsWith("1"));
}
const distinct = (values: string[]) => [...new Set(values.filter((value) => value.trim()))];
const similar = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export const policyIdentity = (contractor: number, line: string, number: string, expiration: string) =>
  JSON.stringify([contractor, policyLineKey(line), mycoiKey(number), expiration]);

export function buildMycoiPreview(rows: SourceRow[], decisions: ImportDecisions, reference: ImportReference, imported: number[] = []): ImportPreview {
  const pending = rows.filter((row) => !imported.includes(row.row) && !decisions.ignored.includes(row.row));
  const preview: ImportPreview = {
    summary: { rowsRead: rows.length, uniqueVendors: 0, matchedVendors: 0, vendorsRequiringReview: 0, matchedDivisions: 0, divisionsRequiringReview: 0, policiesParsed: 0, policyParseErrors: 0, contactChanges: 0, insuranceChanges: 0, readyRows: 0, unresolvedRows: 0, ignoredRows: rows.filter((row) => decisions.ignored.includes(row.row)).length },
    vendors: [], divisions: [], issues: [], rowPolicies: {}, ready: [],
  };
  const issue = (category: ImportPreview["issues"][number]["category"], reason: string, source: SourceRow[]) =>
    preview.issues.push({ category, reason, rows: source.map((row) => row.row) });
  const divisionMap = new Map<string, DivisionReview>();
  for (const row of pending) {
    const key = mycoiKey(row["Division Name"]);
    if (divisionMap.has(key)) continue;
    const saved = reference.divisions.find((item) => item.active && mycoiKey(item.raw_division_name) === key);
    const number = /^([0-9]+)(?:\s|$|-)/.exec(row["Division Name"].trim())?.[1];
    const exactCandidates = number ? reference.projects.filter((project) => project.project_number === number) : [];
    const formattedNumber = number && /^\d{5}$/.test(number) ? `${number.slice(0, 2)}-${number.slice(2)}` : null;
    const candidates = exactCandidates.length ? exactCandidates
      : formattedNumber ? reference.projects.filter((project) => project.project_number === formattedNumber) : [];
    const automaticProject = candidates.length === 1 ? candidates[0] : null;
    const selected = saved?.project_id ?? decisions.divisions[key] ?? automaticProject?.id;
    const projectId = reference.projects.some((project) => project.id === selected) ? selected! : null;
    divisionMap.set(key, { key, raw: row["Division Name"], projectId, saved: saved?.project_id != null,
      automatic: saved?.project_id == null && decisions.divisions[key] == null && automaticProject !== null,
      suggestions: candidates.map((project) => ({ id: project.id, label: `${project.project_number} - ${project.project_name}`, reason: candidates.length === 1 ? exactCandidates.length ? "Exact unique project number" : "Unique YYNNN to YY-NNN project number" : "Ambiguous project number" })) });
  }
  preview.divisions = [...divisionMap.values()];
  const groups = new Map<string, SourceRow[]>();
  for (const row of pending) {
    const key = mycoiKey(row["Vendor Name"]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const [key, source] of groups) {
    const saved = reference.vendors.find((vendor) => vendor.active && mycoiKey(vendor.raw_vendor_name) === key);
    const selected = saved?.contractor_id ?? decisions.vendors[key];
    const contractorId = reference.contractors.some((contractor) => contractor.id === selected) ? selected! : null;
    const duplicateCandidates = reference.contractors.filter((contractor) =>
      normalizeCompanyName(contractor.company_name) === normalizeCompanyName(source[0]["Vendor Name"]));
    const addContractor = !saved && !contractorId && (decisions.addContractors ?? []).includes(key);
    const exactCandidates = reference.contractors.filter((contractor) => mycoiKey(contractor.company_name) === key);
    const candidates = exactCandidates.length ? exactCandidates : reference.contractors.filter((contractor) =>
      duplicateCandidates.includes(contractor) || similar(contractor.company_name) === similar(source[0]["Vendor Name"]));
    const emails = distinct(source.map((row) => row["Vendor Email"]));
    const phones = distinct(source.map((row) => row["Vendor Phone"]));
    preview.vendors.push({ key, raw: source[0]["Vendor Name"], rows: source, contractorId, addContractor, saved: !!saved,
      suggestions: candidates.map((contractor) => ({ id: contractor.id, label: contractor.company_name, reason: candidates.length === 1 ? exactCandidates.length ? "Exact Name Match" : "Normalized spelling similarity; manual acceptance required" : "Ambiguous normalized name" })),
      emailValues: emails, phoneValues: phones, existingEmail: saved?.vendor_email ?? null, existingPhone: saved?.vendor_phone ?? null });
    const startIssues = preview.issues.length;
    if (!key.trim() || (!contractorId && !addContractor)) issue("Vendor Review Required", !key.trim() ? "Missing Vendor Name" : candidates.length > 1 ? "Ambiguous contractor match; choose an existing contractor" : "Unmapped Vendor Name; match an existing contractor or explicitly choose Add Contractor", source);
    if (addContractor && (!normalizeCompanyName(source[0]["Vendor Name"]) || source[0]["Vendor Name"].trim().length > 250
      || duplicateCandidates.length > 0)) issue("Vendor Review Required",
      duplicateCandidates.length ? "A contractor with a matching normalized company name already exists. Match Existing Contractor instead."
        : "A reliable company name of at most 250 characters is required.", source);
    if (addContractor && [...groups.keys()].some((other) => other !== key && (decisions.addContractors ?? []).includes(other)
      && normalizeCompanyName(other) === normalizeCompanyName(key))) issue("Vendor Review Required",
      "Multiple source names would create the same company. Create one first, then match the other source name.", source);
    let email: string | null = null;
    let phone: string | null = null;
    for (const field of ["email", "phone"] as const) {
      const values = field === "email" ? emails : phones;
      const explicit = decisions.contacts[key]?.[field];
      const valid = field === "email" ? safeEmail : safePhone;
      const needsReview = values.length > 1 || values.some((value) => !valid(value));
      let chosen: string | null = null;
      if (explicit === "__KEEP__") chosen = null;
      else if (explicit !== undefined && values.includes(explicit) && valid(explicit)) chosen = explicit;
      else if (needsReview || explicit !== undefined) issue("Contact Review Required", `${field === "email" ? "Vendor Email" : "Vendor Phone"}: ${values.some(placeholderEmail) ? "myCOI placeholder; not useful contact information" : "conflicting or unsafe source values"}; accept one safe source value or keep the existing contact`, source);
      else chosen = values[0] ?? null;
      if (field === "email") email = chosen;
      else phone = chosen;
    }
    const plan: VendorPlan = { key, raw: source[0]["Vendor Name"], contractorId: contractorId ?? 0,
      ...(addContractor ? { createContractor: true } : {}), email, phone, rows: source.map((row) => row.row), divisions: [], policies: [] };
    for (const row of source) {
      const divisionKey = mycoiKey(row["Division Name"]);
      const division = divisionMap.get(divisionKey)!;
      if (!divisionKey.trim() || !division.projectId) issue("Project Review Required", !divisionKey.trim() ? "Missing Division Name" : division.suggestions.length > 1 ? "Ambiguous project match" : "Division needs an accepted existing project mapping", [row]);
      if (!statuses.has(row["Compliance Status"])) issue("Source Review Required", `Unexpected Compliance Status: ${row["Compliance Status"] || "(blank)"}`, [row]);
      const existingStatus = plan.divisions.find((item) => item.key === divisionKey);
      if (existingStatus && existingStatus.status !== row["Compliance Status"]) issue("Source Review Required", "Conflicting statuses for the same vendor and division", source.filter((item) => mycoiKey(item["Division Name"]) === divisionKey));
      if (!existingStatus) plan.divisions.push({ key: divisionKey, raw: row["Division Name"], projectId: division.projectId ?? 0, status: row["Compliance Status"] });
      const parsed = parseMycoiPolicies(row["Policy Expiration Dates"]);
      preview.rowPolicies[row.row] = parsed;
      preview.summary.policiesParsed += parsed.policies.length;
      preview.summary.policyParseErrors += parsed.errors.length;
      for (const error of parsed.errors) issue("Policy Parse Errors", error, [row]);
      for (const policy of parsed.policies) for (const line of policy.policyLines) {
        const identity = policyIdentity(plan.contractorId, line, policy.policyNumber, policy.expirationDate);
        const existing = plan.policies.find((item) => policyIdentity(plan.contractorId, item.line, item.number, item.expiration) === identity);
        if (existing && existing.expired !== policy.isExpired) issue("Policy Parse Errors", "Conflicting isExpired flags for the same exact policy", source);
        if (existing) {
          if (!existing.divisions.includes(divisionKey)) existing.divisions.push(divisionKey);
        } else plan.policies.push({ line, number: policy.policyNumber, expiration: policy.expirationDate, expired: policy.isExpired, divisions: [divisionKey] });
      }
    }
    if (startIssues === preview.issues.length) preview.ready.push(plan);
  }
  preview.summary.uniqueVendors = new Set(rows.map((row) => mycoiKey(row["Vendor Name"]))).size;
  preview.summary.matchedVendors = preview.vendors.filter((vendor) => vendor.contractorId !== null).length;
  preview.summary.vendorsRequiringReview = preview.vendors.filter((vendor) => vendor.contractorId === null
    && !preview.ready.some((plan) => plan.key === vendor.key && plan.createContractor)).length;
  preview.summary.matchedDivisions = preview.divisions.filter((division) => division.projectId !== null).length;
  preview.summary.divisionsRequiringReview = preview.divisions.length - preview.summary.matchedDivisions;
  preview.summary.readyRows = preview.ready.reduce((sum, vendor) => sum + vendor.rows.length, 0);
  preview.summary.unresolvedRows = pending.length - preview.summary.readyRows;
  for (const vendor of preview.ready) {
    const mapping = reference.vendors.find((item) => item.active && mycoiKey(item.raw_vendor_name) === vendor.key);
    if (vendor.email !== null && vendor.email !== mapping?.vendor_email) preview.summary.contactChanges++;
    if (vendor.phone !== null && vendor.phone !== mapping?.vendor_phone) preview.summary.contactChanges++;
    for (const division of vendor.divisions) {
      const mappedDivision = reference.divisions.find((item) => item.active && mycoiKey(item.raw_division_name) === division.key);
      if (!reference.statuses.some((item) => item.active && item.is_current && item.vendor_mapping_id === mapping?.id && item.division_mapping_id === mappedDivision?.id && item.compliance_status === division.status)) preview.summary.insuranceChanges++;
    }
    for (const policy of vendor.policies) {
      if (!reference.policies.some((item) => item.vendor_mapping_id === mapping?.id && item.active && item.is_current && policyIdentity(item.contractor_id, item.policy_line, item.policy_number ?? "", item.expiration_date ?? "") === policyIdentity(vendor.contractorId, policy.line, policy.number, policy.expiration) && item.expired === policy.expired)) preview.summary.insuranceChanges++;
    }
  }
  return preview;
}
