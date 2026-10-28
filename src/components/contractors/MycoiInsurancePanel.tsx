"use client";

import { useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
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
  return <div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr>
    {["Insurance Type", "Policy Number", "Expiration Date", "Status"].map((heading) => <th key={heading} className="whitespace-nowrap py-1 pr-3">{heading}</th>)}
  </tr></thead><tbody>{policies.map((policy) => <tr key={policy.id} className="border-t border-slate-100">
    <td className="py-1 pr-3">{policy.policy_line}</td><td className="py-1 pr-3">{policy.policy_number ?? "Not provided"}</td>
    <td className="whitespace-nowrap py-1 pr-3">{policy.expiration_date ?? "Not provided"}</td>
    <td className="py-1">{policy.expired === true ? "Expired" : policy.expired === false ? "Current" : "Not provided"}</td>
  </tr>)}</tbody></table></div>;
}

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
    const group = projects.get(mapped.project_id) ?? { label: `${mapped.project.project_number} - ${mapped.project.project_name}`, divisionIds: new Set<number>(), statuses: new Set<string>() };
    group.divisionIds.add(division.id);
    group.statuses.add(division.compliance_status ?? "Status not provided");
    projects.set(mapped.project_id, group);
  }
  const assignedPolicies = new Set<number>();
  const projectSections = [...projects.entries()].sort(([, left], [, right]) => left.label.localeCompare(right.label, "en", { numeric: true })).map(([id, group]) => {
    const policies = currentPolicies.filter((policy) => policy.divisions.some((link) => group.divisionIds.has(link.contractor_division_id)));
    policies.forEach((policy) => assignedPolicies.add(policy.id));
    return { id, ...group, policies };
  });

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

  return <section aria-labelledby="mycoi-insurance-heading" className="mt-6 border-t border-slate-200 pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 id="mycoi-insurance-heading" className="text-sm font-semibold text-slate-700">COI / myCOI Insurance</h3>
      <span title="Source: myCOI imports" className="rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-700">Imported</span>
    </div>
    <p className="mt-1 text-xs text-slate-500">Insurance information is maintained through myCOI imports.</p>
    {!canView ? <p className="mt-3 text-xs text-slate-500">You do not have permission to view insurance information.</p> : <>
      {loading ? <p className="mt-3 text-xs text-slate-500">Loading myCOI insurance...</p> : error ? <p role="alert" className="mt-3 text-xs text-red-600">{error}</p> : <>
        {vendors.length === 0 ? <p className="mt-3 text-xs text-slate-500">No myCOI vendor mapping has been established.</p> : vendors.map((vendor) => <div key={vendor.id} className="mt-3 space-y-1 text-xs text-slate-700">
          <p className="break-words"><span className="font-medium">myCOI Vendor Name:</span> {vendor.raw_vendor_name}</p>
          {vendor.vendor_email ? <p className="break-words"><span className="font-medium">myCOI Vendor Email:</span> {vendor.vendor_email}</p> : null}
          {vendor.vendor_phone ? <p><span className="font-medium">myCOI Vendor Phone:</span> {vendor.vendor_phone}</p> : null}
          {vendor.last_imported_at ? <p>Last myCOI Import: {new Date(vendor.last_imported_at).toLocaleString()}</p> : null}
        </div>)}
        <div className="mt-3 space-y-2 text-xs text-slate-700">
          {projectSections.length ? <h4 className="font-semibold">Project Insurance</h4> : null}
          {projectSections.map((project) => <details key={project.id} open={[...project.statuses].some((status) => status !== "Compliant Finalized") || project.policies.some((policy) => policy.expired === true)}>
            <summary className="cursor-pointer py-1"><strong>{project.label}</strong><span className="block">{[...project.statuses].join(" | ")} | {project.policies.length} {project.policies.length === 1 ? "Policy" : "Policies"}</span></summary>
            <p>myCOI Status: {[...project.statuses].join(" | ")}</p>
            {project.policies.length ? <PolicyTable policies={project.policies} /> : <p>No current policies associated with this project.</p>}
          </details>)}
          {currentPolicies.some((policy) => !assignedPolicies.has(policy.id)) ? <details open>
            <summary className="cursor-pointer py-1 font-semibold">Other / Unassigned Insurance</summary>
            <PolicyTable policies={currentPolicies.filter((policy) => !assignedPolicies.has(policy.id))} />
          </details> : null}
          {!currentPolicies.length && vendors.length ? <p>No current myCOI policies have been imported.</p> : null}
        </div>
      </>}
    </>}
  </section>;
}
