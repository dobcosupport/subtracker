"use client";

import { useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import styles from "@/components/style3/style3.module.css";
import Style3Icon from "@/components/style3/Style3Icon";
import Style3Chevron from "@/components/style3/Style3Chevron";
import panelStyles from "./MycoiInsurancePanel.module.css";
import { getMycoiInsurance } from "@/services/mycoi";
import type { MycoiInsurance, MycoiPolicy, MycoiProvenance } from "@/types/mycoi";

function Provenance({ value }: { value: MycoiProvenance }) {
  return <>
    {value.last_imported_at ? <p>Last myCOI Import: {new Date(value.last_imported_at).toLocaleString()}</p> : null}
    {value.import_reference ? <p className="break-words">Source: {value.import_reference}</p> : null}
    {value.import_history_id !== null ? <p>Import reference #{value.import_history_id}</p> : null}
  </>;
}

function PolicySummary({ policy }: { policy: MycoiPolicy }) {
  return <p className="break-words">
    <span className="font-medium">{policy.policy_line}</span>
    {policy.policy_number ? ` | ${policy.policy_number}` : ""}
    {policy.expiration_date ? ` | Expires ${policy.expiration_date}` : " | Expiration not provided"}
    {policy.expired === true ? " | Expired (myCOI)" : policy.expired === false ? " | Not expired (myCOI)" : ""}
  </p>;
}

function PolicyTable({ policies }: { policies: MycoiPolicy[] }) {
  return <div className="overflow-x-auto"><table className={`${styles.operationalTable} ${panelStyles.policyTable}`}><thead><tr>
    {["Insurance Type", "Policy Number", "Expiration Date", "Status"].map((heading) => <th key={heading} className="whitespace-nowrap py-1 pr-3">{heading}</th>)}
  </tr></thead><tbody>{policies.map((policy) => <tr key={policy.id} className="border-t border-slate-100">
    <td>{policy.policy_line}</td><td>{policy.policy_number ?? "Not provided"}</td>
    <td className="whitespace-nowrap">{policy.expiration_date ?? "Not provided"}</td>
    <td><span className={`${styles.badge} ${policy.expired === true ? styles.red : policy.expired === false ? styles.good : styles.neutral}`}>{policy.expired === true ? "Expired" : policy.expired === false ? "Current" : "Not provided"}</span></td>
  </tr>)}</tbody></table></div>;
}

function PolicyCounts({ policies }: { policies: MycoiPolicy[] }) {
  return <p className={panelStyles.policyCounts}>
    <strong>{policies.length} {policies.length === 1 ? "Policy" : "Policies"}</strong>
    <span className="text-emerald-700">{policies.filter((policy) => policy.expired === false).length} Current</span>
    <span className="text-red-600">{policies.filter((policy) => policy.expired === true).length} Expired</span>
  </p>;
}

type ProjectFilter = "all" | "expired" | "current" | "empty";

export default function MycoiInsurancePanel({ contractorId, historyOnly = false }: {
  contractorId: number;
  historyOnly?: boolean;
}) {
  const profile = useSessionProfile();
  const canView = profile.permissions.some((permission) => permission.module === "insurance" && permission.can_view);
  const [result, setResult] = useState<{
    contractorId: number;
    data: MycoiInsurance | null;
    error: string | null;
  } | null>(null);
  const currentResult = result?.contractorId === contractorId ? result : null;
  const data = currentResult?.data ?? null;
  const error = currentResult?.error ?? null;
  const loading = currentResult === null;
  const [projectFilter, setProjectFilter] = useState<ProjectFilter>("all");
  const [projectSearch, setProjectSearch] = useState("");

  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    void getMycoiInsurance(contractorId).then((result) => {
      if (cancelled) return;
      setResult({ contractorId, data: result.data, error: result.error?.message ?? null });
    }).catch((reason: unknown) => {
      if (cancelled) return;
      setResult({ contractorId, data: null, error: reason instanceof Error ? reason.message : "Unable to load myCOI insurance." });
    });
    return () => { cancelled = true; };
  }, [contractorId, canView]);

  const vendors = data?.vendors.filter((vendor) => vendor.active) ?? [];
  const activeVendorIds = new Set(vendors.map((vendor) => vendor.id));
  const currentPolicies = data?.policies.filter((policy) => policy.active && policy.is_current && activeVendorIds.has(policy.vendor_mapping_id))
    .sort((left, right) => Number(left.expired !== false) - Number(right.expired !== false)
      || (left.expiration_date ?? "").localeCompare(right.expiration_date ?? "")
      || left.policy_line.localeCompare(right.policy_line)) ?? [];
  const currentDivisions = data?.divisions.filter((division) => division.active && division.is_current && activeVendorIds.has(division.vendor_mapping_id)) ?? [];
  const projects = new Map<number, { label: string; divisionIds: Set<number>; statuses: Set<string> }>();
  for (const division of currentDivisions) {
    const mapped = division.division;
    if (!mapped?.project || mapped.project_id === null) continue;
    const group = projects.get(mapped.project_id) ?? { label: `${mapped.project.project_number} · ${mapped.project.project_name}`, divisionIds: new Set<number>(), statuses: new Set<string>() };
    group.divisionIds.add(division.id);
    group.statuses.add(division.compliance_status ?? "Status not provided");
    projects.set(mapped.project_id, group);
  }
  const assignedPolicies = new Set<number>();
  const projectSections = [...projects.entries()].sort(([, left], [, right]) => left.label.localeCompare(right.label, "en", { numeric: true })).map(([id, group]) => {
    const policies = currentPolicies.filter((policy) => policy.divisions.some((link) => group.divisionIds.has(link.contractor_division_id)));
    policies.forEach((policy) => assignedPolicies.add(policy.id));
    return { id, ...group, policies, expiredCount: policies.filter((policy) => policy.expired === true).length };
  });
  const projectFilters: { id: ProjectFilter; label: string; count: number }[] = [
    { id: "all", label: "All Projects", count: projectSections.length },
    { id: "expired", label: "Has Expired Policies", count: projectSections.filter((project) => project.expiredCount > 0).length },
    { id: "current", label: "Current Only", count: projectSections.filter((project) => project.policies.length > 0 && project.policies.every((policy) => policy.expired === false)).length },
    { id: "empty", label: "No Policies", count: projectSections.filter((project) => project.policies.length === 0).length },
  ];
  const visibleProjects = projectSections.filter((project) => {
    const matchesFilter = projectFilter === "all"
      || (projectFilter === "expired" && project.expiredCount > 0)
      || (projectFilter === "current" && project.policies.length > 0 && project.policies.every((policy) => policy.expired === false))
      || (projectFilter === "empty" && project.policies.length === 0);
    return matchesFilter && project.label.toLocaleLowerCase().includes(projectSearch.trim().toLocaleLowerCase());
  });
  const unassignedPolicies = currentPolicies.filter((policy) => !assignedPolicies.has(policy.id));
  const accordionName = `mycoi-projects-${contractorId}`;

  if (historyOnly) return <div className="p-3 text-xs text-slate-600">
    {!canView ? <p>You do not have permission to view insurance information.</p> : loading ? <p>Loading myCOI history...</p> : error ? <p role="alert">{error}</p> : data ? <div className="space-y-3">
      {!data.vendors.length ? <p>No myCOI import history available.</p> : null}
      {data.vendors.map((vendor) => <div key={vendor.id}>
        <p>myCOI Vendor Name: {vendor.raw_vendor_name} | {vendor.active ? "Current" : "Historical"}</p>
        <p>myCOI Vendor Email: {vendor.vendor_email ?? "Not provided"}</p>
        <p>myCOI Vendor Phone: {vendor.vendor_phone ?? "Not provided"}</p>
        <Provenance value={vendor} />
      </div>)}
      {data.divisions.map((division) => <div key={division.id}>
        <p className="whitespace-pre-wrap break-words">Raw Division Name: {division.division?.raw_division_name ?? "Unavailable"}</p>
        <p>{division.active && division.is_current && activeVendorIds.has(division.vendor_mapping_id) ? "Current" : "Historical / Superseded"} | {division.compliance_status ?? "Status not provided"}</p>
        <Provenance value={division} />
      </div>)}
      {data.policies.map((policy) => <div key={policy.id}>
        <PolicySummary policy={policy} />
        <p>{policy.active && policy.is_current && activeVendorIds.has(policy.vendor_mapping_id) ? "Current" : "Historical / Superseded"} | Source: {policy.source}</p>
        {policy.divisions.map((link) => <p key={link.contractor_division_id}>Raw Division Name: {data.divisions.find((item) => item.id === link.contractor_division_id)?.division?.raw_division_name ?? "Unavailable"}</p>)}
        <Provenance value={policy} />
      </div>)}
    </div> : null}
  </div>;

  return <section aria-labelledby="mycoi-insurance-heading" className={`${styles.panel} m-0 p-4 sm:p-5`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-3"><span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-blue-50 text-blue-600"><Style3Icon name="Compliance" className="h-6 w-6" /></span><div><h2 id="mycoi-insurance-heading" className={styles.heading}>Insurance (myCOI)</h2><p className="mt-1 text-xs text-slate-500">Insurance information is maintained through myCOI imports.</p></div></div>
      <span title="Source: myCOI imports" className={`${styles.badge} ${styles.blue}`}>Imported</span>
    </div>
    {!canView ? <p className="mt-3 text-xs text-slate-500">You do not have permission to view insurance information.</p> : <>
      {loading ? <p className="mt-3 text-xs text-slate-500">Loading myCOI insurance...</p> : error ? <p role="alert" className="mt-3 text-xs text-red-600">{error}</p> : <>
        <dl aria-label="Imported myCOI summary" title="Contractor-level unique imported policy records, counted once across projects, not project-policy associations. Current and Expired use myCOI's imported flags, not today's date. Existing vendor-alias identities are preserved." className={panelStyles.metrics}>
          {[
            { label: "Projects", count: projectSections.length, color: "text-blue-600" },
            { label: "Unique Policies", count: currentPolicies.length, color: "text-[#345480]" },
            { label: "Current (Unique)", count: currentPolicies.filter((policy) => policy.expired === false).length, color: "text-emerald-700" },
            { label: "Expired (Unique)", count: currentPolicies.filter((policy) => policy.expired === true).length, color: "text-red-600" },
          ].map((metric) => <div key={metric.label} className={metric.color}><dt>{metric.label}</dt><dd>{metric.count}</dd></div>)}
        </dl>
        {vendors.length === 0 ? <p className="mt-3 text-xs text-slate-500">No myCOI vendor mapping has been established.</p> : vendors.map((vendor) => <dl key={vendor.id} aria-label="myCOI vendor information" className={panelStyles.vendorStrip}>
          <div><dt>Vendor</dt><dd>{vendor.raw_vendor_name}</dd></div>
          <div><dt>Phone</dt><dd>{vendor.vendor_phone || "—"}</dd></div>
          <div><dt>Email</dt><dd>{vendor.vendor_email ? <a href={`mailto:${vendor.vendor_email}`} className="text-blue-600 hover:underline">{vendor.vendor_email}</a> : "—"}</dd></div>
          <div><dt>Last Import</dt><dd>{vendor.last_imported_at ? new Date(vendor.last_imported_at).toLocaleString() : "—"}</dd></div>
        </dl>)}
        <div className={panelStyles.projectControls}>
          <div role="group" aria-label="Filter insurance projects" className={panelStyles.filters}>
            {projectFilters.map((filter) => <button key={filter.id} type="button" aria-pressed={projectFilter === filter.id} onClick={() => setProjectFilter(filter.id)} title={filter.id === "current" ? "Projects with policies all marked not expired by myCOI; excludes missing status and zero policies." : undefined}>{filter.label} ({filter.count})</button>)}
          </div>
          <label className={panelStyles.search}><Style3Icon name="Search" className="h-4 w-4 shrink-0" /><input type="search" aria-label="Search insurance projects" placeholder="Search insurance projects..." value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} /></label>
        </div>
        <div className={panelStyles.projects}>
          {visibleProjects.map((project) => <details key={project.id} name={accordionName} className={`${panelStyles.project} group/rail`}>
            <summary className={panelStyles.projectHeader}>
              <span className={panelStyles.projectTitle}>{project.label}</span>
              <span className={panelStyles.statusGroup}>
                <span title="Imported myCOI workflow state, not policy validity" className={`${styles.badge} ${[...project.statuses].every((status) => status === "Compliant Finalized") ? styles.good : styles.neutral}`}>myCOI: {[...project.statuses].join(" | ")}</span>
                <span className={panelStyles.policyTotal}>{project.policies.length} Policies</span>
                <span className={`${styles.badge} ${project.expiredCount > 0 ? styles.red : styles.neutral}`}>{project.expiredCount} Expired</span>
                <Style3Chevron />
              </span>
            </summary>
            <div className={panelStyles.projectContent}>
              {project.policies.length > 0 && project.expiredCount === project.policies.length ? <p className={panelStyles.warning}><span aria-hidden="true">!</span>All {project.policies.length} imported {project.policies.length === 1 ? "policy for this project is" : "policies for this project are"} expired.</p> : <PolicyCounts policies={project.policies} />}
              {project.policies.length ? <PolicyTable policies={project.policies} /> : <p className="pb-2 text-xs text-slate-500">No current policies associated with this project.</p>}
            </div>
          </details>)}
          {!visibleProjects.length ? <p role="status" className="py-3 text-xs text-slate-500">No insurance projects match the selected filters.</p> : null}
          {unassignedPolicies.length && projectFilter === "all" && !projectSearch.trim() ? <details name={accordionName} className={`${panelStyles.project} group/rail`}>
            <summary className={panelStyles.projectHeader}><span className={panelStyles.projectTitle}>Other / Unassigned Insurance</span><span className={panelStyles.policyTotal}>{unassignedPolicies.length} {unassignedPolicies.length === 1 ? "Policy" : "Policies"}</span><Style3Chevron /></summary>
            <div className={panelStyles.projectContent}><PolicyCounts policies={unassignedPolicies} /><PolicyTable policies={unassignedPolicies} /></div>
          </details> : null}
          {!currentPolicies.length && vendors.length ? <p>No current myCOI policies have been imported.</p> : null}
        </div>
      </>}
    </>}
  </section>;
}
