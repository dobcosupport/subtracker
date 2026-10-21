"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import type { ComplianceHistoryRecord } from "@/types/database";
import type { ComplianceUnlinkHistory } from "@/types/registration-unlink";

export default function ComplianceHistory({ contractorId, records }: {
  contractorId: number; records: ComplianceHistoryRecord[];
}) {
  const [unlinks, setUnlinks] = useState<ComplianceUnlinkHistory[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await adminFetch(`/api/contractors/${contractorId}/compliance-history`, { signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error ?? "Unable to load administrative compliance history.");
        if (!controller.signal.aborted) setUnlinks(result.unlinks);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Unable to load administrative compliance history.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [contractorId]);
  const cell = "border border-slate-200 px-4 py-3 text-sm";
  return <div className="overflow-x-auto">
    {loading ? <p role="status" className="p-3 text-sm">Loading administrative compliance history...</p> : null}
    {error ? <p role="alert" className="p-3 text-sm text-red-700">{error}</p> : null}
    <table aria-label="Compliance History" className="min-w-[1000px] border-collapse text-left">
      <thead className="bg-slate-50"><tr>{["Compliance Type", "Registration Number", "Effective Date", "Expiration Date", "Active Status", "Current Status", "Administrative History"].map((heading) =>
        <th key={heading} className={`${cell} font-semibold`}>{heading}</th>)}</tr></thead>
      <tbody>{records.map((record) => {
        const unlink = unlinks.find((entry) => entry.record_id === record.id);
        return <tr key={record.id}>
          <td className={`${cell} font-medium`}>{record.compliance_name}<p className="text-xs text-slate-500">Record #{record.id}</p></td>
          <td className={cell}>{record.registration_number || "-"}</td>
          <td className={cell}>{record.effective_date || "-"}</td>
          <td className={cell}>{record.compliance_name === "NJ BRC" ? "Non-expiring" : record.expiration_date || "-"}</td>
          <td className={cell}>{unlink ? "Archived / Administratively unlinked" : record.active ? "Active" : "Inactive"}</td>
          <td className={cell}>{unlink ? "Not current - previously linked" : record.calculated_status}</td>
          <td className={`${cell} min-w-80`}>
            {unlink ? <div className="space-y-1">
              <p>Previously linked; administratively removed/unlinked.</p>
              <p>Business/company: {record.matched_company_name ?? unlink.record_company_name ?? "Not retained"}</p>
              <p>Retained registry status: {record.registry_status ?? "Not recorded"}</p>
              <p>Retained sync status: {record.sync_status ?? record.synced_status ?? "Not recorded"}</p>
              <p>Unlinked: {new Date(unlink.unlinked_at).toLocaleString()}</p>
              <p>Administrator: {unlink.administrator}</p>
              <p>Reason: {unlink.reason}</p>
              {unlink.identifiers ? <p>Contractor identifier: {unlink.identifiers.previous ?? "(none)"} &rarr; {unlink.identifiers.resulting ?? "(cleared)"}</p> : null}
              <p>Source/provider: {[record.verification_source, record.sync_source].filter(Boolean).join(" / ") || "Not retained"}</p>
              {record.verified_date ? <p>Verified: {record.verified_date}{record.verified_by ? ` by ${record.verified_by}` : ""}</p> : null}
              {record.source_url ? <p className="break-all">Source URL: {record.source_url}</p> : null}
            </div> : "-"}
          </td>
        </tr>;
      })}</tbody>
    </table>
    {!records.length ? <p className="p-5 text-sm text-slate-500">No compliance history found.</p> : null}
  </div>;
}
