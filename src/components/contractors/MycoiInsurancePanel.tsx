"use client";

import { useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { getMycoiInsurance } from "@/services/mycoi";
import type { InsuranceTracking } from "@/types/database";
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

export default function MycoiInsurancePanel({ contractorId, legacy }: {
  contractorId: number;
  legacy: InsuranceTracking | null;
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
  const hasDetails = data && (data.policies.length > 0 || data.divisions.length > 0 || data.vendors.some((vendor) => !vendor.active));

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
          <Provenance value={vendor} />
        </div>)}
        {currentDivisions.length > 0 ? <div className="mt-3 space-y-1 text-xs text-slate-700">
          <h4 className="font-semibold">Project Compliance (myCOI)</h4>
          {currentDivisions.map((division) => <p key={division.id} className="break-words">
            {division.division?.project ? `${division.division.project.project_number} - ${division.division.project.project_name}` : division.division?.project_id ? "Project unavailable" : "Unmapped division - review required"}
            {division.compliance_status ? `: ${division.compliance_status}` : ": Status not provided"}
          </p>)}
        </div> : null}
        {currentPolicies.length > 0 ? <div className="mt-3 space-y-1 text-xs text-slate-700">
          <h4 className="font-semibold">Current Insurance</h4>
          <div className="overflow-x-auto"><table className="w-full text-left"><thead><tr>{["Insurance Type", "Policy Number", "Expires"].map((heading) => <th key={heading} className="py-1 pr-2">{heading}</th>)}</tr></thead><tbody>
            {currentPolicies.map((policy) => <tr key={policy.id} className="border-t border-slate-100">
              <td className="py-1 pr-2">{policy.policy_line}</td><td className="break-words py-1 pr-2">{policy.policy_number ?? "Not provided"}</td>
              <td className="py-1">{policy.expiration_date ?? "Not provided"}<span className="block text-[10px] text-slate-500">{policy.expired === true ? "Expired (myCOI)" : policy.expired === false ? "Not expired (myCOI)" : "Expired flag not provided"}</span></td>
            </tr>)}
          </tbody></table></div>
        </div> : vendors.length > 0 ? <p className="mt-3 text-xs text-slate-500">No current myCOI policies have been imported.</p> : null}
        {hasDetails ? <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium">myCOI Details / History</summary>
          <div className="mt-2 space-y-3">
            {data.vendors.filter((vendor) => !vendor.active).map((vendor) => <div key={vendor.id}>
              <p className="break-words">Historical myCOI Vendor Name: {vendor.raw_vendor_name}</p>
              {vendor.vendor_email ? <p className="break-words">myCOI Vendor Email: {vendor.vendor_email}</p> : null}
              {vendor.vendor_phone ? <p>myCOI Vendor Phone: {vendor.vendor_phone}</p> : null}
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
              {policy.divisions.map((link) => {
                const division = data.divisions.find((item) => item.id === link.contractor_division_id);
                return <p key={link.contractor_division_id} className="whitespace-pre-wrap break-words">Raw Division Name: {division?.division?.raw_division_name ?? "Unavailable"}</p>;
              })}
              <Provenance value={policy} />
            </div>)}
          </div>
        </details> : null}
      </>}
      {legacy ? <div className="mt-3 space-y-1 border-t border-slate-100 pt-3 text-xs text-slate-600">
        <h4 className="font-semibold text-slate-700">Legacy / Manual Insurance</h4>
        <p>Certificate Of Insurance: {legacy.certificate_on_file ? "On file" : "Not on file"}</p>
        <p>General Liability: {legacy.general_liability_on_file ? "On file" : "Not on file"}{legacy.general_liability_expiration_date ? ` | Expires ${legacy.general_liability_expiration_date}` : ""}</p>
        <p>Worker&apos;s Comp: {legacy.workers_comp_on_file ? "On file" : "Not on file"}{legacy.workers_comp_expiration_date ? ` | Expires ${legacy.workers_comp_expiration_date}` : ""}</p>
        {legacy.last_verified_date ? <p>Last verified: {legacy.last_verified_date}</p> : null}
        {legacy.notes ? <p className="whitespace-pre-wrap break-words">{legacy.notes}</p> : null}
        <p className="text-slate-500">Existing verification history remains in Company History. Legacy compliance calculations are unchanged.</p>
      </div> : null}
    </>}
  </section>;
}
