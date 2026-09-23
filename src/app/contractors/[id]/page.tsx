"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getActivityForContractor } from "@/services/activity";
import { getAssignmentsForContractor } from "@/services/assignments";
import { getComplianceRecordsForContractor } from "@/services/compliance";
import { getContractorById } from "@/services/contractors";
import type { ActivityLog, Assignment, ComplianceStatus, ComplianceStatusRecord, Contractor } from "@/types/database";

const complianceNames = [
  "Public Works Registration",
  "Insurance Certificate",
  "W9",
  "Business Registration",
  "Safety Certification",
];

const statusStyles: Record<ComplianceStatus, string> = {
  Active: "bg-emerald-100 text-emerald-700",
  "90 Day": "bg-amber-100 text-amber-700",
  "60 Day": "bg-orange-100 text-orange-700",
  "30 Day": "bg-red-100 text-red-700",
  Expired: "bg-[#7f1d1d] text-white",
  "Missing Information": "bg-sky-100 text-sky-700",
};

const getOverallStatus = (records: ComplianceStatusRecord[]) => {
  if (records.some((record) => record.calculated_status === "Expired")) return "Expired";
  if (records.some((record) => record.calculated_status === "Missing Information")) return "Missing Information";
  if (records.some((record) => ["90 Day", "60 Day", "30 Day"].includes(record.calculated_status))) return "Expiring Soon";
  return "Compliant";
};

export default function ContractorDetailPage() {
  const params = useParams<{ id: string }>();
  const contractorId = Number(params.id);
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [complianceRecords, setComplianceRecords] = useState<ComplianceStatusRecord[]>([]);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!Number.isFinite(contractorId)) {
      setError("Invalid contractor ID.");
      setLoading(false);
      return;
    }

    const loadDetails = async () => {
      setLoading(true);
      setError(null);
      const [{ data: contractorData, error: contractorError }, { data: assignmentData, error: assignmentsError }, { data: complianceData, error: complianceError }, { data: activityData, error: activityError }] = await Promise.all([
        getContractorById(contractorId),
        getAssignmentsForContractor(contractorId),
        getComplianceRecordsForContractor(contractorId),
        getActivityForContractor(contractorId),
      ]);

      const loadError = contractorError || assignmentsError || complianceError || activityError;
      if (loadError || !contractorData) {
        setError(loadError?.message || "Contractor not found.");
        setLoading(false);
        return;
      }

      setContractor(contractorData);
      setAssignments(assignmentData ?? []);
      setComplianceRecords(complianceData ?? []);
      setActivity(activityData ?? []);
      setLoading(false);
    };

    void loadDetails();
  }, [contractorId]);

  const complianceByName = useMemo(
    () => new Map(complianceRecords.map((record) => [record.compliance_name, record])),
    [complianceRecords]
  );

  if (loading) {
    return <main className="min-h-screen bg-[#f5f7fb] p-8 text-sm text-slate-500">Loading contractor...</main>;
  }

  if (error || !contractor) {
    return <main className="min-h-screen bg-[#f5f7fb] p-8"><div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{error || "Contractor not found."}</div></main>;
  }

  const overallStatus = getOverallStatus(complianceRecords);
  const overallStyle = overallStatus === "Compliant" ? "bg-emerald-100 text-emerald-700" : overallStatus === "Expiring Soon" ? "bg-amber-100 text-amber-700" : overallStatus === "Expired" ? "bg-[#7f1d1d] text-white" : "bg-sky-100 text-sky-700";

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl space-y-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><Link href="/contractors" className="text-sm font-medium text-indigo-600 hover:text-indigo-800">Back to Contractors</Link><p className="mt-4 text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Contractor Profile</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{contractor.company_name}</h1></div><span className={`inline-flex w-fit rounded-full px-3 py-1.5 text-sm font-semibold ${overallStyle}`}>{overallStatus}</span></div>
+
+        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-xl font-semibold text-slate-900">Company Information</h2><div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Company Name</p><p className="mt-1 text-sm text-slate-700">{contractor.company_name}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Trade</p><p className="mt-1 text-sm text-slate-700">{contractor.trade || "—"}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Contact Name</p><p className="mt-1 text-sm text-slate-700">{contractor.contact_name || "—"}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Email</p><p className="mt-1 text-sm text-slate-700">{contractor.email || "—"}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Phone</p><p className="mt-1 text-sm text-slate-700">{contractor.phone || "—"}</p></div><div className="sm:col-span-2 lg:col-span-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notes</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{contractor.notes || "—"}</p></div></div></section>
+
+        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Project Assignments</h2></div>{assignments.length === 0 ? <p className="p-5 text-sm text-slate-500">No project assignments found.</p> : <div className="overflow-x-auto"><table className="min-w-[650px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Project Number</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Project Name</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Assigned Date</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Active</th></tr></thead><tbody>{assignments.map((assignment) => <tr key={assignment.id}><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_number || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_name || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.assigned_date}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.active ? "Active" : "Inactive"}</td></tr>)}</tbody></table></div>}</section>
+
+        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Compliance Summary</h2></div><div className="overflow-x-auto"><table className="min-w-[780px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Requirement</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Expiration Date</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Days Remaining</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Current Status</th></tr></thead><tbody>{complianceNames.map((name) => { const record = complianceByName.get(name); const status = record?.calculated_status || "Missing Information"; return <tr key={name}><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{name}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record?.expiration_date || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record?.days_remaining ?? "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[status]}`}>{status}</span></td></tr>; })}</tbody></table></div></section>
+
+        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Recent Activity</h2></div>{activity.length === 0 ? <p className="p-5 text-sm text-slate-500">No recent activity found.</p> : <div className="divide-y divide-slate-100">{activity.map((item) => <div key={item.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[140px_160px_1fr]"><span className="text-sm text-slate-500">{item.activity_date}</span><span className="text-sm font-medium text-slate-700">{item.activity_type}</span><span className="text-sm text-slate-600">{item.notes || "—"}</span></div>)}</div>}</section>
+      </div>
+    </main>
+  );
+}
