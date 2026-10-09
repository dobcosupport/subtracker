/*

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getActivityForContractor } from "@/services/activity";
import { createAssignment, deactivateAssignment, getAssignmentHistoryForContractor, getAssignmentsForContractor } from "@/services/assignments";
import { getComplianceHistoryForContractor } from "@/services/compliance";
import { getContractorById, updateContractor } from "@/services/contractors";
import { adminFetch } from "@/lib/admin-client";
import { getProjects } from "@/services/projects";
import type { ActivityLog, Assignment, ComplianceStatus, ComplianceStatusRecord, Contractor, Project } from "@/types/database";

type NjPwcCandidate = {
  business_name: string | null;
  certificate_number: string | null;
  registration_date: string | null;
  expiration_date: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  county: string | null;
  source_url?: string | null;
};

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [complianceRecords, setComplianceRecords] = useState<ComplianceStatusRecord[]>([]);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isDeactivateOpen, setIsDeactivateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState({
    company_name: "",
    trade: "",
    contact_name: "",
    email: "",
    phone: "",
    notes: "",
    active: true,
  });

  useEffect(() => {
    if (!Number.isFinite(contractorId)) {
      setError("Invalid contractor ID.");
      setLoading(false);
      return;
    }

    const loadDetails = async () => {
      setLoading(true);
      setError(null);
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState({
    project_id: "",
    assigned_date: new Date().toISOString().slice(0, 10),
  });
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
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

  const openEdit = () => {
    if (!contractor) return;
    setForm({
      company_name: contractor.company_name,
      trade: contractor.trade ?? "",
      contact_name: contractor.contact_name ?? "",
      email: contractor.email ?? "",
      phone: contractor.phone ?? "",
      notes: contractor.notes ?? "",
      active: contractor.active,
    });
    setFormError(null);
    setSuccessMessage(null);
    setIsEditOpen(true);
  };

  const handleUpdate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!form.company_name.trim()) {
      setFormError("Company Name is required.");
      return;
    }
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setFormError("Enter a valid email address.");
      return;
    }

    setSaving(true);
    setFormError(null);
    const { data, error: updateError } = await updateContractor(contractorId, {
      company_name: form.company_name.trim(),
      trade: form.trade.trim() || null,
      contact_name: form.contact_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      notes: form.notes.trim() || null,
      active: form.active,
    });

    if (updateError) {
      setFormError(updateError.message || "Unable to update contractor.");
      setSaving(false);
      return;
    }

    const { data: refreshedContractor } = await getContractorById(contractorId);
    setContractor(refreshedContractor ?? data?.[0] ?? null);
    setIsEditOpen(false);
    setSaving(false);
    setSuccessMessage("Contractor updated successfully.");
  };

  const handleDeactivate = async () => {
    setSaving(true);
    const { data, error: deactivateError } = await updateContractor(contractorId, { active: false });

    if (deactivateError) {
      setError(deactivateError.message || "Unable to deactivate contractor.");
      setSaving(false);
      return;
    }

    const { data: refreshedContractor } = await getContractorById(contractorId);
        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Recent Activity</h2></div>{activity.length === 0 ? <p className="p-5 text-sm text-slate-500">No recent activity found.</p> : <div className="divide-y divide-slate-100">{activity.map((item) => <div key={item.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[140px_160px_1fr]"><span className="text-sm text-slate-500">{item.activity_date}</span><span className="text-sm font-medium text-slate-700">{item.activity_type}</span><span className="text-sm text-slate-600">{item.notes || "—"}</span></div>)}</div>}</section>
        {isEditOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-semibold text-slate-900">Edit Contractor</h2><button type="button" onClick={() => setIsEditOpen(false)} className="text-sm text-slate-500">Close</button></div><form onSubmit={handleUpdate} className="space-y-4"><input aria-label="Company Name" placeholder="Company Name" value={form.company_name} onChange={(event) => setForm((current) => ({ ...current, company_name: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><input aria-label="Trade" placeholder="Trade" value={form.trade} onChange={(event) => setForm((current) => ({ ...current, trade: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><input aria-label="Contact Name" placeholder="Contact Name" value={form.contact_name} onChange={(event) => setForm((current) => ({ ...current, contact_name: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><input aria-label="Email" type="email" placeholder="Email" value={form.email} onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><input aria-label="Phone" placeholder="Phone" value={form.phone} onChange={(event) => setForm((current) => ({ ...current, phone: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div><textarea aria-label="Notes" placeholder="Notes" rows={4} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} />Active</label>{formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setIsEditOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white disabled:opacity-70">{saving ? "Saving..." : "Save Changes"}</button></div></form></div></div> : null}
        {assignmentModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Assign Project</h2><form onSubmit={saveAssignment} className="mt-5 space-y-4"><select aria-label="Project" value={assignmentForm.project_id} onChange={(event) => setAssignmentForm((current) => ({ ...current, project_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.project_number} - {project.project_name}</option>)}</select><input aria-label="Assigned Date" type="date" value={assignmentForm.assigned_date} onChange={(event) => setAssignmentForm((current) => ({ ...current, assigned_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={assignmentForm.active} onChange={(event) => setAssignmentForm((current) => ({ ...current, active: event.target.checked }))} />Active</label>{assignmentError ? <p className="text-sm text-red-600">{assignmentError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setAssignmentModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Assign Project"}</button></div></form></div></div> : null}
          {assignmentModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Assign Project</h2><form onSubmit={saveAssignment} className="mt-5 space-y-4"><select aria-label="Project" value={assignmentForm.project_id} onChange={(event) => setAssignmentForm((current) => ({ ...current, project_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.project_number} - {project.project_name}</option>)}</select><input aria-label="Assigned Date" type="date" value={assignmentForm.assigned_date} onChange={(event) => setAssignmentForm((current) => ({ ...current, assigned_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={assignmentForm.active} onChange={(event) => setAssignmentForm((current) => ({ ...current, active: event.target.checked }))} />Active</label>{assignmentError ? <p className="text-sm text-red-600">{assignmentError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setAssignmentModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Assign Project"}</button></div></form></div></div> : null}
        {isDeactivateOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold text-slate-900">Deactivate Contractor?</h2><p className="mt-3 text-sm leading-6 text-slate-600">This will mark {contractor.company_name} inactive without deleting the record.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setIsDeactivateOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="button" onClick={() => void handleDeactivate()} disabled={saving} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm text-white disabled:opacity-70">{saving ? "Deactivating..." : "Deactivate"}</button></div></div></div> : null}
        {assignmentModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Assign Project</h2><form onSubmit={saveAssignment} className="mt-5 space-y-4"><select aria-label="Project" value={assignmentForm.project_id} onChange={(event) => setAssignmentForm((current) => ({ ...current, project_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.project_number} - {project.project_name}</option>)}</select><input aria-label="Assigned Date" type="date" value={assignmentForm.assigned_date} onChange={(event) => setAssignmentForm((current) => ({ ...current, assigned_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={assignmentForm.active} onChange={(event) => setAssignmentForm((current) => ({ ...current, active: event.target.checked }))} />Active</label>{assignmentError ? <p className="text-sm text-red-600">{assignmentError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setAssignmentModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Assign Project"}</button></div></form></div></div> : null}
    setSaving(false);
    setSuccessMessage("Contractor deactivated successfully.");
  };

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
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><Link href="/contractors" className="text-sm font-medium text-indigo-600 hover:text-indigo-800">Back to Contractors</Link><p className="mt-4 text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Contractor Profile</p><h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{contractor.company_name}</h1></div><div className="flex items-center gap-3"><button type="button" onClick={openEdit} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800">Edit Contractor</button>{contractor.active ? <button type="button" onClick={() => setIsDeactivateOpen(true)} className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50">Deactivate</button> : null}<span className={`inline-flex w-fit rounded-full px-3 py-1.5 text-sm font-semibold ${overallStyle}`}>{overallStatus}</span></div></div>
        {successMessage ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}

        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-xl font-semibold text-slate-900">Company Information</h2><div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Company Name</p><p className="mt-1 text-sm text-slate-700">{contractor.company_name}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Trade</p><p className="mt-1 text-sm text-slate-700">{contractor.trade || "—"}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Contact Name</p><p className="mt-1 text-sm text-slate-700">{contractor.contact_name || "—"}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Email</p><p className="mt-1 text-sm text-slate-700">{contractor.email || "—"}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Phone</p><p className="mt-1 text-sm text-slate-700">{contractor.phone || "—"}</p></div><div className="sm:col-span-2 lg:col-span-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notes</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{contractor.notes || "—"}</p></div></div></section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Project Assignments</h2></div>{assignments.length === 0 ? <p className="p-5 text-sm text-slate-500">No project assignments found.</p> : <div className="overflow-x-auto"><table className="min-w-[650px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Project Number</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Project Name</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Assigned Date</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Active</th></tr></thead><tbody>{assignments.map((assignment) => <tr key={assignment.id}><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_number || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_name || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.assigned_date}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.active ? "Active" : "Inactive"}</td></tr>)}</tbody></table></div>}</section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Compliance Summary</h2></div><div className="overflow-x-auto"><table className="min-w-[780px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Requirement</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Expiration Date</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Days Remaining</th><th className="border border-slate-200 px-4 py-3 text-sm font-semibold">Current Status</th></tr></thead><tbody>{complianceNames.map((name) => { const record = complianceByName.get(name); const status = record?.calculated_status || "Missing Information"; return <tr key={name}><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{name}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record?.expiration_date || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record?.days_remaining ?? "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[status]}`}>{status}</span></td></tr>; })}</tbody></table></div></section>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold text-slate-900">Recent Activity</h2></div>{activity.length === 0 ? <p className="p-5 text-sm text-slate-500">No recent activity found.</p> : <div className="divide-y divide-slate-100">{activity.map((item) => <div key={item.id} className="grid gap-2 px-5 py-4 sm:grid-cols-[140px_160px_1fr]"><span className="text-sm text-slate-500">{item.activity_date}</span><span className="text-sm font-medium text-slate-700">{item.activity_type}</span><span className="text-sm text-slate-600">{item.notes || "—"}</span></div>)}</div>}</section>
      </div>
    </main>
  );
} */

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { Fragment, useEffect, useMemo, useState } from "react";
import TieredSubRelationshipsPanel from "@/components/contractors/TieredSubRelationshipsPanel";
import { getActivityForContractor, logContractorStatusChange, logProjectEvent } from "@/services/activity";
import { createAssignment, deactivateAssignment, getAssignmentHistoryForContractor, getAssignmentsForContractor } from "@/services/assignments";
import { archiveComplianceRecord, createComplianceRecord, getComplianceHistoryForContractor, getComplianceTypes, getSyncedComplianceRecordsForContractor, updateComplianceRecord, type SyncedComplianceRecord } from "@/services/compliance";
import { getContractorById, updateContractor } from "@/services/contractors";
import { adminFetch } from "@/lib/admin-client";
import { checkNjPwcWorker } from "@/lib/worker-health-client";
import { getInsuranceTracking, getInsuranceVerificationHistory, saveInsuranceTracking } from "@/services/insurance";
import { createFollowup, followupMethods, followupStatuses, getFollowupsForContractor, updateFollowup } from "@/services/followups";
import { followupRecordLabel, followupRelationshipPayload, getFollowupRelatedLabel, getFollowupRelatedValue, insuranceRelatedItems } from "@/lib/followup-related-item";
import { getProjects } from "@/services/projects";
import { assignTieredSub, deactivateTieredSub, getAvailableTieredSubContractors, getTieredSubHistoryForContractor, getTieredSubsForContractor } from "@/services/tieredSubs";
import type { ActivityLog, Assignment, ComplianceHistoryRecord, ComplianceStatus, ComplianceType, Contractor, ContractorFollowup, FollowupStatus, InsuranceTracking, InsuranceVerificationHistory, Project, TieredSubRecord } from "@/types/database";

type NjPwcCandidate = {
  business_name: string | null;
  certificate_number: string | null;
  registration_date: string | null;
  expiration_date: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip_code: string | null;
  county: string | null;
  source_url?: string | null;
};

const statusStyles: Record<ComplianceStatus, string> = { Active: "bg-emerald-100 text-emerald-700", "90 Day": "bg-amber-100 text-amber-700", "60 Day": "bg-orange-100 text-orange-700", "30 Day": "bg-red-100 text-red-700", Expired: "bg-[#7f1d1d] text-white", "Missing Information": "bg-sky-100 text-sky-700" };
const emptyForm = { company_name: "", trade: "", material_vendor_only: false, contact_name: "", email: "", phone: "", address_1: "", address_2: "", city: "", state: "", zip_code: "", county: "", nj_pwc_number: "", nj_brc_number: "", ny_pwc_number: "", ny_brc_number: "", sage_erp_id: "", brc_name_control: "", notes: "", active: true };

function getBrcNameControl(companyName: string) {
  return companyName.replace(/[^\p{L}]/gu, "").slice(0, 4).toUpperCase();
}
function CompanyField({ label, value }: { label: string; value: string | null | undefined }) {
  return <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{value || "—"}</p></div>;
}
function ContractorTextInput({ label, value, onChange, maxLength, type = "text" }: { label: string; value: string; onChange: (value: string) => void; maxLength?: number; type?: "text" | "email" }) {
  return <label className="block min-w-0"><span className="mb-1 block text-xs font-medium text-slate-500">{label}</span><input aria-label={label} type={type} value={value} maxLength={maxLength} onChange={(event) => onChange(event.target.value)} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></label>;
}

function overallStatus(records: ComplianceHistoryRecord[]) {
  const activeRecords = records.filter((record) => record.active);
  if (activeRecords.length === 0) return "Non-Compliant";
  if (activeRecords.some((record) => record.calculated_status === "Expired")) return "Expired";
  if (activeRecords.some((record) => record.calculated_status === "Missing Information")) return "Missing Information";
  if (activeRecords.some((record) => ["90 Day", "60 Day", "30 Day"].includes(record.calculated_status))) return "Expiring Soon";
  return "Compliant";
}

function ExpandIcon({ isOpen }: { isOpen: boolean }) {
  return <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`inline-block h-[1em] w-[1em] align-middle transition-transform ${isOpen ? "rotate-90" : ""}`}><path d="m9 6 6 6-6 6" /></svg>;
}

function CollapsibleSection({ title, isOpen, onToggle, children }: { title: string; isOpen: boolean; onToggle: () => void; children: React.ReactNode }) {
  return <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><button type="button" onClick={onToggle} aria-expanded={isOpen} className="flex w-full items-center justify-between px-5 py-4 text-left text-xl font-semibold text-slate-900"><span><ExpandIcon isOpen={isOpen} /> {title}</span></button>{isOpen ? <div className="border-t border-slate-200">{children}</div> : null}</section>;
}

export default function ContractorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const contractorId = Number(id);
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentHistory, setAssignmentHistory] = useState<Assignment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [records, setRecords] = useState<ComplianceHistoryRecord[]>([]);
  const [syncedRecords, setSyncedRecords] = useState<SyncedComplianceRecord[]>([]);
  const [insurance, setInsurance] = useState<InsuranceTracking | null>(null);
  const [insuranceHistory, setInsuranceHistory] = useState<InsuranceVerificationHistory[]>([]);
  const [followups, setFollowups] = useState<ContractorFollowup[]>([]);
  const [complianceTypes, setComplianceTypes] = useState<ComplianceType[]>([]);
  const [complianceTypesLoading, setComplianceTypesLoading] = useState(true);
  const [complianceTypesError, setComplianceTypesError] = useState<string | null>(null);
  const [activity, setActivity] = useState<ActivityLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDeactivate, setConfirmingDeactivate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [brcNameControlManuallyEdited, setBrcNameControlManuallyEdited] = useState(false);
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [togglingProjectId, setTogglingProjectId] = useState<number | null>(null);
  const [complianceModalOpen, setComplianceModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<ComplianceHistoryRecord | null>(null);
  const [complianceForm, setComplianceForm] = useState({ compliance_type_id: "", registration_number: "", effective_date: "", expiration_date: "" });
  const [complianceError, setComplianceError] = useState<string | null>(null);
  const [insuranceForm, setInsuranceForm] = useState({ certificate_on_file: false, general_liability_on_file: false, general_liability_expiration_date: "", workers_comp_on_file: false, workers_comp_expiration_date: "" });
  const [insuranceError, setInsuranceError] = useState<string | null>(null);
  const [followupModalOpen, setFollowupModalOpen] = useState(false);
  const [followupForm, setFollowupForm] = useState({ followup_date: new Date().toISOString().slice(0, 10), followup_method: "Email", related_item: "", compliance_record_id: "", subject: "", notes: "", status: "Open" });
  const [followupError, setFollowupError] = useState<string | null>(null);
  const [editingFollowup, setEditingFollowup] = useState<ContractorFollowup | null>(null);
  const [followupStatusFilter, setFollowupStatusFilter] = useState<FollowupStatus | null>(null);
  const [availableCompanies, setAvailableCompanies] = useState<Contractor[]>([]);
  const [tieredSubs, setTieredSubs] = useState<TieredSubRecord[]>([]);
  const [tieredSubHistory, setTieredSubHistory] = useState<TieredSubRecord[]>([]);
  const [tieredSubsLoading, setTieredSubsLoading] = useState(true);
  const [tieredSubsError, setTieredSubsError] = useState<string | null>(null);
  const [togglingTieredSubId, setTogglingTieredSubId] = useState<number | null>(null);
  const [tieredSubSearch, setTieredSubSearch] = useState("");
  const [openSections, setOpenSections] = useState({ tieredSubs: false, companyHistory: false, projectHistory: false, complianceHistory: false, insuranceHistory: false, followupHistory: false, tieredSubHistory: false, activity: false });
  const toggleSection = (key: keyof typeof openSections) => setOpenSections((current) => ({ ...current, [key]: !current[key] }));

  const loadDetails = async (background = false) => {
    if (!background) setLoading(true);
    setComplianceTypesLoading(true);
    setComplianceTypesError(null);
    const [{ data: contractorData, error: contractorError }, { data: assignmentData, error: assignmentsError }, { data: assignmentHistoryData, error: assignmentHistoryError }, { data: recordData, error: recordError }, { data: typeData, error: typesError }, { data: insuranceData, error: insuranceLoadError }, { data: insuranceHistoryData, error: insuranceHistoryLoadError }, { data: followupData, error: followupLoadError }, { data: activityData, error: activityError }, { data: projectData, error: projectsError }, { data: syncedData, error: syncedError }] = await Promise.all([getContractorById(contractorId), getAssignmentsForContractor(contractorId), getAssignmentHistoryForContractor(contractorId), getComplianceHistoryForContractor(contractorId), getComplianceTypes(), getInsuranceTracking(contractorId), getInsuranceVerificationHistory(contractorId), getFollowupsForContractor(contractorId), getActivityForContractor(contractorId), getProjects(), getSyncedComplianceRecordsForContractor(contractorId)]);
    const loadError = contractorError || assignmentsError || assignmentHistoryError || recordError || insuranceLoadError || insuranceHistoryLoadError || followupLoadError || activityError || projectsError || syncedError;
    setComplianceTypesLoading(false);
    if (typesError) {
      setComplianceTypes([]);
      setComplianceTypesError(typesError.message || "Unable to load compliance types.");
    }
    if (loadError || !contractorData) {
      setError(loadError?.message || "Contractor not found.");
    } else {
      setContractor(contractorData);
      setAssignments(assignmentData ?? []);
      setAssignmentHistory(assignmentHistoryData ?? []);
      setProjects(projectData ?? []);
      setRecords(recordData ?? []);
      // TEMP DEBUG (runtime inspection): raw records loaded for this contractor
      console.log("[DEBUG 392] contractorId", contractorId, "raw recordData", JSON.stringify(recordData));
      setSyncedRecords(syncedData ?? []);
      setComplianceTypes(typeData ?? []);
      setInsurance(insuranceData);
      setInsuranceHistory(insuranceHistoryData ?? []);
      setFollowups(followupData ?? []);
      setInsuranceForm({ certificate_on_file: insuranceData?.certificate_on_file ?? false, general_liability_on_file: insuranceData?.general_liability_on_file ?? false, general_liability_expiration_date: insuranceData?.general_liability_expiration_date ?? "", workers_comp_on_file: insuranceData?.workers_comp_on_file ?? false, workers_comp_expiration_date: insuranceData?.workers_comp_expiration_date ?? "" });
      setActivity(activityData ?? []);
    }
    setLoading(false);
  };

  const loadTieredSubs = async () => {
    setTieredSubsLoading(true);
    setTieredSubsError(null);
    const [{ data: availableData, error: availableError }, { data: activeData, error: activeError }, { data: historyData, error: historyError }] = await Promise.all([
      getAvailableTieredSubContractors(contractorId),
      getTieredSubsForContractor(contractorId),
      getTieredSubHistoryForContractor(contractorId),
    ]);
    const tieredSubsLoadError = availableError || activeError || historyError;
    if (tieredSubsLoadError) {
      setTieredSubsError(tieredSubsLoadError.message || "Unable to load Tiered Subs.");
    } else {
      setAvailableCompanies(availableData ?? []);
      setTieredSubs(activeData ?? []);
      setTieredSubHistory(historyData ?? []);
    }
    setTieredSubsLoading(false);
  };

  useEffect(() => { if (Number.isFinite(contractorId)) { void loadDetails(); void loadTieredSubs(); } else { setError("Invalid contractor ID."); setLoading(false); } }, [contractorId]);

  const activeRecords = useMemo(() => records.filter((record) => record.active), [records]);
  // TEMP DEBUG (runtime inspection): what activeRecords holds at render time
  console.log("[DEBUG 392] activeRecords", JSON.stringify(activeRecords.map((r) => ({ id: r.id, compliance_name: r.compliance_name, active: r.active, is_current: r.is_current, registration_number: r.registration_number, effective_date: r.effective_date, expiration_date: r.expiration_date, calculated_status: r.calculated_status }))));
  const followupSummary = useMemo(() => {
    const counts: Record<FollowupStatus, number> = { Open: 0, "Waiting Response": 0, Resolved: 0, Closed: 0 };
    followups.forEach((followup) => { counts[followup.status] += 1; });
    return counts;
  }, [followups]);
  const lastFollowup = useMemo(() => followups[0] ?? null, [followups]);
  const activeFollowups = useMemo(() => followups.filter((followup) => followup.status === "Open" || followup.status === "Waiting Response"), [followups]);
  const filteredFollowups = useMemo(() => followupStatusFilter ? followups.filter((followup) => followup.status === followupStatusFilter) : followups, [followups, followupStatusFilter]);
  // Sort project lists by project number in ascending numeric order (natural sort, so 24-101 follows 24-015).
  const sortByProjectNumber = <T extends { project_number?: string | null }>(list: T[]): T[] =>
    [...list].sort((left, right) => (left.project_number ?? "").localeCompare(right.project_number ?? "", undefined, { numeric: true, sensitivity: "base" }));
  const activeProjects = useMemo(() => sortByProjectNumber(projects.filter((project) => project.status === "Active")), [projects]);
  const sortedAssignmentHistory = useMemo(() =>
    [...assignmentHistory].sort((left, right) => (left.projects?.project_number ?? "").localeCompare(right.projects?.project_number ?? "", undefined, { numeric: true, sensitivity: "base" }))
  , [assignmentHistory]);
  const assignedProjectIds = useMemo(() => new Set(assignments.map((assignment) => assignment.project_id)), [assignments]);
  const assignedTieredSubIds = useMemo(() => new Set(tieredSubs.map((sub) => sub.tiered_sub_contractor_id)), [tieredSubs]);
  const filteredAvailableCompanies = useMemo(() => {
    const term = tieredSubSearch.trim().toLowerCase();
    if (!term) return availableCompanies;
    return availableCompanies.filter((company) => company.company_name.toLowerCase().includes(term));
  }, [availableCompanies, tieredSubSearch]);
  const summary = useMemo(() => ({
    activeProjects: assignments.length,
    activeCompliance: activeRecords.length,
    expiringCompliance: activeRecords.filter((record) => ["90 Day", "60 Day", "30 Day"].includes(record.calculated_status)).length,
    expiredCompliance: activeRecords.filter((record) => record.calculated_status === "Expired").length,
  }), [activeRecords, assignments.length]);
  const openEdit = () => { if (!contractor) return; setForm({ company_name: contractor.company_name, trade: contractor.trade ?? "", material_vendor_only: contractor.material_vendor_only ?? false, contact_name: contractor.contact_name ?? "", email: contractor.email ?? "", phone: contractor.phone ?? "", address_1: contractor.address_1 ?? "", address_2: contractor.address_2 ?? "", city: contractor.city ?? "", state: contractor.state ?? "", zip_code: contractor.zip_code ?? "", county: contractor.county ?? "", nj_pwc_number: contractor.nj_pwc_number ?? "", nj_brc_number: contractor.nj_brc_number ?? "", ny_pwc_number: contractor.ny_pwc_number ?? "", ny_brc_number: contractor.ny_brc_number ?? "", sage_erp_id: contractor.sage_erp_id ?? "", brc_name_control: contractor.brc_name_control ?? getBrcNameControl(contractor.company_name), notes: contractor.notes ?? "", active: contractor.active }); setBrcNameControlManuallyEdited(contractor.brc_name_control_is_manual ?? false); setFormError(null); setSuccess(null); setEditing(true); };
  const handleCompanyNameChange = (companyName: string) => { setForm((current) => ({ ...current, company_name: companyName, brc_name_control: brcNameControlManuallyEdited ? current.brc_name_control : getBrcNameControl(companyName) })); };
  const handleBrcNameControlChange = (value: string) => { setBrcNameControlManuallyEdited(true); setForm((current) => ({ ...current, brc_name_control: value.toUpperCase().slice(0, 4) })); };
  const [njPwcSearching, setNjPwcSearching] = useState(false);
  const [njPwcRequestId, setNjPwcRequestId] = useState<number | null>(null);
  const [njPwcCandidates, setNjPwcCandidates] = useState<NjPwcCandidate[]>([]);
  const [njPwcResultsOpen, setNjPwcResultsOpen] = useState(false);
  const [njPwcSelected, setNjPwcSelected] = useState<NjPwcCandidate | null>(null);
  const [njPwcImportOpen, setNjPwcImportOpen] = useState(false);
  const [njPwcMessage, setNjPwcMessage] = useState<string | null>(null);
  const [njPwcNoMatch, setNjPwcNoMatch] = useState(false);
  const [njPwcTrackingError, setNjPwcTrackingError] = useState<string | null>(null);
  const [njPwcImportChoices, setNjPwcImportChoices] = useState({ companyName: false, pwcNumber: false, address: false, city: false, state: false, zip: false, county: false, syncedRecord: true });

  // Start an NJ PWC attended search for THIS existing contractor. Uses the
  // contractor's stored company name; never creates a new contractor.
  // Start an NJ PWC attended search for THIS existing contractor. Reuses an
  // existing pending request for the exact company name instead of creating a
  // duplicate; only creates a new request when none is pending.
  const handleNjPwcSearch = async () => {
    if (!contractor) return;
    setNjPwcMessage(null);
    setNjPwcNoMatch(false);
    setNjPwcCandidates([]);
    setNjPwcSearching(true);
    const companyName = contractor.company_name.trim();
    try {
      // Reuse the latest pending/completed request for the exact company name.
      const latestResponse = await adminFetch(`/api/contractors/nj-pwc-search/latest?company_name=${encodeURIComponent(companyName)}`);
      if (latestResponse.ok) {
        const latest = await latestResponse.json() as { found?: boolean; search_request_id?: number; status?: string; candidates?: NjPwcCandidate[]; error_message?: string | null };
        if (latest.found && latest.search_request_id && latest.status === "pending") {
          const workerWarning = await checkNjPwcWorker();
          setNjPwcRequestId(latest.search_request_id);
          setNjPwcMessage(workerWarning ?? "An NJ PWC search is already pending for this contractor. Waiting for the registry search to complete.");
          return; // polling resumes via the useEffect on njPwcRequestId
        }
        if (latest.found && latest.search_request_id && latest.status === "completed") {
          setNjPwcRequestId(latest.search_request_id);
          const candidates = latest.candidates ?? [];
          setNjPwcSearching(false);
          if (candidates.length > 0) { setNjPwcCandidates(candidates); setNjPwcResultsOpen(true); }
          return;
        }
      }

      const workerWarning = await checkNjPwcWorker();
      const response = await adminFetch("/api/contractors/nj-pwc-search", {
        method: "POST",
        body: JSON.stringify({ company_name: companyName, zip_code: contractor.zip_code || undefined, city: contractor.city || undefined, state: contractor.state || undefined }),
      });
      const result = await response.json() as { search_request_id?: number; error?: string };
      if (!response.ok || !result.search_request_id) throw new Error(result.error ?? "Unable to start NJ PWC search.");
      setNjPwcRequestId(result.search_request_id);
      setNjPwcMessage(workerWarning ?? "NJ PWC search request created. Waiting for the registry search to complete.");
    } catch (reason) {
      setNjPwcSearching(false);
      setNjPwcMessage(reason instanceof Error ? reason.message : "Unable to start NJ PWC search.");
    }
  };

  // Abandon the current pending request and start a fresh search (confirmed).
  const handleNjPwcStartNew = async () => {
    const confirmed = window.confirm("Start a new NJ PWC search? This abandons the existing pending request.");
    if (!confirmed) return;
    setNjPwcRequestId(null);
    setNjPwcSearching(false);
    await handleNjPwcSearch();
  };

  // Poll the search request until the worker posts results back.
  useEffect(() => {
    if (njPwcRequestId === null) return;
    let cancelled = false;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const response = await adminFetch(`/api/contractors/nj-pwc-search/${njPwcRequestId}`);
        const result = await response.json() as { status?: string; candidates?: NjPwcCandidate[]; error_message?: string | null };
        if (cancelled) return;
        if (!response.ok) throw new Error("Unable to read NJ PWC search status.");
        if (result.status === "pending") {
          if (attempts < 60) { window.setTimeout(poll, 3000); return; }
          setNjPwcSearching(false);
          setNjPwcMessage("The NJ PWC search is still pending. The RPA worker may not be running. Use Check Search Status to poll again.");
          return;
        }
        const candidates = result.candidates ?? [];
        setNjPwcSearching(false);
        if (result.status === "completed" && candidates.length > 0) {
          setNjPwcCandidates(candidates);
          setNjPwcResultsOpen(true);
          setNjPwcMessage(null);
        } else if (result.status === "no_match" || (result.status === "completed" && candidates.length === 0)) {
          setNjPwcNoMatch(true);
          setNjPwcMessage(null);
        } else {
          setNjPwcMessage(result.error_message ?? "NJ PWC search did not complete.");
        }
      } catch (reason) {
        if (cancelled) return;
        setNjPwcSearching(false);
        setNjPwcMessage(reason instanceof Error ? reason.message : "Unable to read NJ PWC search status.");
      }
    };
    void poll();
    return () => { cancelled = true; };
  }, [njPwcRequestId]);

  // Candidate selected: build import choices (never auto-rename an existing
  // contractor; companyName opt-in only) and open the import comparison modal.
  const handleNjPwcSelect = (candidate: NjPwcCandidate) => {
    setNjPwcSelected(candidate);
    setNjPwcResultsOpen(false);
    setNjPwcImportChoices({
      companyName: false,
      pwcNumber: !contractor?.nj_pwc_number,
      address: !contractor?.address_1,
      city: !contractor?.city,
      state: !contractor?.state,
      zip: !contractor?.zip_code,
      county: !contractor?.county,
      syncedRecord: true,
    });
    setNjPwcImportOpen(true);
  };

  // Apply the chosen registry values to the edit form, save the existing
  // contractor, then create the synced record + review queue entry.
  const handleNjPwcImport = async () => {
    if (!njPwcSelected || !contractor) return;
    setNjPwcImportOpen(false);
    const updates: Record<string, string | null> = {};
    if (njPwcImportChoices.companyName && njPwcSelected.business_name) updates.company_name = njPwcSelected.business_name;
    if (njPwcImportChoices.pwcNumber && njPwcSelected.certificate_number) updates.nj_pwc_number = njPwcSelected.certificate_number;
    if (njPwcImportChoices.address && njPwcSelected.address) updates.address_1 = njPwcSelected.address;
    if (njPwcImportChoices.city && njPwcSelected.city) updates.city = njPwcSelected.city;
    if (njPwcImportChoices.state && njPwcSelected.state) updates.state = njPwcSelected.state;
    if (njPwcImportChoices.zip && njPwcSelected.zip_code) updates.zip_code = njPwcSelected.zip_code;
    if (njPwcImportChoices.county && njPwcSelected.county) updates.county = njPwcSelected.county;

    if (Object.keys(updates).length > 0) {
      const { error: updateError } = await updateContractor(contractorId, updates);
      if (updateError) { setNjPwcTrackingError(`Contractor update failed: ${updateError.message}`); return; }
    }

    // Create the synced compliance record + review queue entry for THIS contractor.
    try {
      const response = await adminFetch("/api/contractors/nj-pwc-import", {
        method: "POST",
        body: JSON.stringify({ contractor_id: contractorId, candidate: njPwcSelected, create_synced_record: njPwcImportChoices.syncedRecord, search_request_id: njPwcRequestId, import_choices: njPwcImportChoices }),
      });
      const body = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(body.error ?? "NJ PWC tracking failed.");
      setNjPwcTrackingError(null);
      setNjPwcMessage("NJ PWC information imported. A review queue entry was created for approval.");
      await loadDetails();
    } catch (reason) {
      setNjPwcTrackingError(`Contractor updated, but NJ PWC tracking could not be created. ${reason instanceof Error ? reason.message : "NJ PWC tracking failed."}`);
    }
  };

  const saveEdit = async (event: React.FormEvent) => { event.preventDefault(); if (!form.company_name.trim()) { setFormError("Company Name is required."); return; } if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setFormError("Enter a valid email address."); return; } setSaving(true); const { error: updateError } = await updateContractor(contractorId, { company_name: form.company_name.trim(), trade: form.trade.trim() || null, material_vendor_only: form.material_vendor_only, contact_name: form.contact_name.trim() || null, email: form.email.trim() || null, phone: form.phone.trim() || null, address_1: form.address_1.trim() || null, address_2: form.address_2.trim() || null, city: form.city.trim() || null, state: form.state.trim() || null, zip_code: form.zip_code.trim() || null, county: form.county.trim() || null, nj_pwc_number: form.nj_pwc_number.trim() || null, nj_brc_number: form.nj_brc_number.trim() || null, ny_pwc_number: form.ny_pwc_number.trim() || null, ny_brc_number: form.ny_brc_number.trim() || null, sage_erp_id: form.sage_erp_id.trim() || null, brc_name_control: form.brc_name_control.trim(), brc_name_control_is_manual: brcNameControlManuallyEdited, notes: form.notes.trim() || null, active: form.active }); if (updateError) { setFormError(updateError.message); setSaving(false); return; } await loadDetails(); setEditing(false); setSaving(false); setSuccess("Contractor updated successfully."); };
  const deactivate = async () => { setSaving(true); const { error: updateError } = await updateContractor(contractorId, { active: false }); if (updateError) { setError(updateError.message); setSaving(false); return; } await logContractorStatusChange(contractorId, contractor?.company_name ?? "Contractor", "Active", "Inactive"); await loadDetails(); setConfirmingDeactivate(false); setSaving(false); setSuccess("Contractor deactivated successfully. All history and records preserved."); };
  const activate = async () => { setSaving(true); const { error: updateError } = await updateContractor(contractorId, { active: true }); if (updateError) { setError(updateError.message); setSaving(false); return; } await logContractorStatusChange(contractorId, contractor?.company_name ?? "Contractor", "Inactive", "Active"); await loadDetails(); setConfirmingDeactivate(false); setSaving(false); setSuccess("Contractor activated successfully. All history and records preserved."); };
  const openComplianceCreate = () => { setEditingRecord(null); setComplianceForm({ compliance_type_id: "", registration_number: "", effective_date: "", expiration_date: "" }); setComplianceError(null); setComplianceModalOpen(true); };
  const toggleProjectAssignment = async (project: Project) => {
    setAssignmentError(null);
    setTogglingProjectId(project.id);
    const existingAssignment = assignments.find((assignment) => assignment.project_id === project.id);
    const { error: toggleError } = existingAssignment
      ? await deactivateAssignment(existingAssignment.id)
      : await createAssignment({ contractor_id: contractorId, project_id: project.id, assigned_date: new Date().toISOString().slice(0, 10), active: true });

    if (toggleError) {
      setAssignmentError(toggleError.message);
      setTogglingProjectId(null);
      return;
    }

    const companyName = contractor?.company_name ?? "Contractor";
    if (existingAssignment) {
      await logProjectEvent(project.id, "Contractor Removal", `${companyName} removed from project.`);
    } else {
      await logProjectEvent(project.id, "Contractor Assignment", `${companyName} assigned to project.`);
    }

    await loadDetails();
    setTogglingProjectId(null);
    setSuccess(existingAssignment ? "Project moved to history successfully." : "Project assigned successfully.");
  };
  const toggleTieredSub = async (company: Contractor) => {
    setTieredSubsError(null);
    setTogglingTieredSubId(company.id);
    const existingActive = tieredSubs.find((sub) => sub.tiered_sub_contractor_id === company.id);
    const { error: toggleError } = existingActive
      ? await deactivateTieredSub(existingActive.id)
      : await assignTieredSub(contractorId, company.id);

    if (toggleError) {
      setTieredSubsError(toggleError.message);
      setTogglingTieredSubId(null);
      return;
    }

    await loadTieredSubs();
    setTogglingTieredSubId(null);
    setSuccess(existingActive ? "Tiered Sub moved to history successfully." : "Tiered Sub assigned successfully.");
  };
  const openComplianceEdit = (record: ComplianceHistoryRecord) => { setEditingRecord(record); setComplianceForm({ compliance_type_id: String(record.compliance_type_id), registration_number: record.registration_number ?? "", effective_date: record.effective_date ?? "", expiration_date: record.expiration_date ?? "" }); setComplianceError(null); setComplianceModalOpen(true); };
  const saveCompliance = async (event: React.FormEvent) => { event.preventDefault(); if (!complianceForm.compliance_type_id) { setComplianceError("Compliance Type is required."); return; } setSaving(true); setComplianceError(null); const payload = { compliance_type_id: Number(complianceForm.compliance_type_id), registration_number: complianceForm.registration_number.trim() || null, effective_date: complianceForm.effective_date || null, expiration_date: complianceForm.expiration_date || null, verified_date: null, verified_by: null, verification_source: null, is_current: true, active: true, notes: null }; const result = editingRecord ? await updateComplianceRecord(editingRecord.id, payload) : await createComplianceRecord({ contractor_id: contractorId, ...payload }); if (result.error) { setComplianceError(result.error.message); setSaving(false); return; } await loadDetails(); setComplianceModalOpen(false); setSaving(false); setSuccess(editingRecord ? "Compliance record updated successfully." : "Compliance record added successfully."); };
  const archiveCompliance = async (recordId: number) => { setSaving(true); const { error: archiveError } = await archiveComplianceRecord(recordId); if (archiveError) { setError(archiveError.message); setSaving(false); return; } await loadDetails(); setSaving(false); setSuccess("Compliance record archived successfully."); };
  const saveInsurance = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setInsuranceError(null); const { error: saveError } = await saveInsuranceTracking(contractorId, { certificate_on_file: insuranceForm.certificate_on_file, general_liability_on_file: insuranceForm.general_liability_on_file, general_liability_expiration_date: insuranceForm.general_liability_expiration_date || null, workers_comp_on_file: insuranceForm.workers_comp_on_file, workers_comp_expiration_date: insuranceForm.workers_comp_expiration_date || null }); if (saveError) { setInsuranceError(saveError.message); setSaving(false); return; } await loadDetails(); setSaving(false); setSuccess("Insurance tracking updated successfully."); };
  const saveFollowup = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!followupForm.subject.trim()) {
      setFollowupError("Subject is required.");
      return;
    }
    setSaving(true);
    setFollowupError(null);
    let relationship: ReturnType<typeof followupRelationshipPayload>;
    try {
      relationship = followupRelationshipPayload(followupForm.related_item, followupForm.compliance_record_id);
    } catch (error) {
      setFollowupError(error instanceof Error ? error.message : "Invalid related item.");
      setSaving(false);
      return;
    }
    const payload = { ...relationship, followup_date: followupForm.followup_date, followup_method: followupForm.followup_method as ContractorFollowup["followup_method"], subject: followupForm.subject.trim(), notes: followupForm.notes.trim() || null, status: followupForm.status as ContractorFollowup["status"] };
    const { data: savedFollowups, error: saveError } = editingFollowup
      ? await updateFollowup(editingFollowup.id, payload)
      : await createFollowup({ contractor_id: contractorId, ...payload });
    if (saveError) {
      setFollowupError(saveError.message);
      setSaving(false);
      return;
    }
    const savedFollowup = savedFollowups?.[0] ?? (editingFollowup ? { ...editingFollowup, ...payload } : null);
    if (savedFollowup) {
      setFollowups((current) => [savedFollowup, ...current.filter((followup) => followup.id !== savedFollowup.id)]
        .sort((left, right) => right.followup_date.localeCompare(left.followup_date) || right.created_at.localeCompare(left.created_at)));
    }
    setFollowupForm({ followup_date: new Date().toISOString().slice(0, 10), followup_method: "Email", related_item: "", compliance_record_id: "", subject: "", notes: "", status: "Open" });
    setEditingFollowup(null);
    setFollowupModalOpen(false);
    setSuccess(editingFollowup ? "Follow-up updated successfully." : "Follow-up added successfully.");
    await loadDetails(true);
    setSaving(false);
  };
  const openFollowupEdit = (followup: ContractorFollowup) => { setEditingFollowup(followup); setFollowupForm({ followup_date: followup.followup_date, followup_method: followup.followup_method, related_item: getFollowupRelatedValue(followup, records), compliance_record_id: followup.compliance_record_id ? String(followup.compliance_record_id) : "", subject: followup.subject, notes: followup.notes ?? "", status: followup.status }); setFollowupError(null); setFollowupModalOpen(true); };
  const changeFollowupRelatedItem = (value: string) => {
    if (value === followupForm.related_item) return;
    if (followupForm.compliance_record_id && !window.confirm("Changing Related Item will clear the selected specific compliance record. Continue?")) return;
    setFollowupForm((current) => ({ ...current, related_item: value, compliance_record_id: "" }));
  };
  const matchingFollowupRecords = records.filter((record) => followupForm.related_item === `compliance:${record.compliance_type_id}`);
  const activeFollowupRecords = matchingFollowupRecords.filter((record) => record.active && record.is_current);
  const historicalFollowupRecords = matchingFollowupRecords.filter((record) => !record.active || !record.is_current);
  const followupRelatedFields = <div className="space-y-4">
    <div>
      <label htmlFor="followup_related_item" className="mb-1 block text-sm font-medium text-slate-700">Related Item</label>
      <select id="followup_related_item" value={followupForm.related_item} onChange={(event) => changeFollowupRelatedItem(event.target.value)} disabled={complianceTypesLoading} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
        <option value="">None / General Follow-Up</option>
        {followupForm.related_item.startsWith("legacy:") || (followupForm.related_item.startsWith("compliance:") && !complianceTypes.some((type) => followupForm.related_item === `compliance:${type.id}`)) ? <option value={followupForm.related_item}>{editingFollowup ? getFollowupRelatedLabel(editingFollowup, records, complianceTypes) : "Previously linked compliance item"} (Historical / unavailable)</option> : null}
        {complianceTypes.length > 0 ? <optgroup label="Compliance">
          {complianceTypes.filter((type) => type.active).map((type) => <option key={type.id} value={`compliance:${type.id}`}>{type.compliance_name}</option>)}
        </optgroup> : null}
        <optgroup label="Insurance">{insuranceRelatedItems.map((item) => <option key={item.key} value={`insurance:${item.key}`}>{item.label}</option>)}</optgroup>
      </select>
      {complianceTypesError ? <p role="alert" className="mt-1 text-xs text-red-600">Unable to load compliance types: {complianceTypesError}. Existing relationships are preserved.</p> : null}
    </div>
    {followupForm.related_item.startsWith("compliance:") || followupForm.related_item.startsWith("legacy:") ? <div>
      <label htmlFor="related_compliance_record" className="mb-1 block text-sm font-medium text-slate-700">Specific Compliance Record (Optional)</label>
      <select id="related_compliance_record" value={followupForm.compliance_record_id} onChange={(event) => setFollowupForm((current) => ({ ...current, compliance_record_id: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
        <option value="">No specific record</option>
        {followupForm.compliance_record_id && !matchingFollowupRecords.some((record) => String(record.id) === followupForm.compliance_record_id) ? <option value={followupForm.compliance_record_id}>Previously linked compliance record #{followupForm.compliance_record_id} (unavailable)</option> : null}
        {activeFollowupRecords.length > 0 ? <optgroup label="Active Compliance Records">{activeFollowupRecords.map((record) => <option key={record.id} value={record.id}>{followupRecordLabel(record)}</option>)}</optgroup> : null}
        {historicalFollowupRecords.length > 0 ? <optgroup label="Historical Compliance Records">{historicalFollowupRecords.map((record) => <option key={record.id} value={record.id}>{followupRecordLabel(record)}</option>)}</optgroup> : null}
      </select>
      {matchingFollowupRecords.length === 0 ? <p className="mt-1 text-xs text-slate-500">No matching saved compliance records. You can save a follow-up for this type without a specific record.</p> : null}
    </div> : null}
  </div>;
  const handleFollowupStatusClick = (status: FollowupStatus) => { setFollowupStatusFilter(status); setOpenSections((current) => ({ ...current, companyHistory: true, followupHistory: true })); };

  if (loading) return <main className="min-h-screen bg-[#f5f7fb] p-8 text-sm text-slate-500">Loading contractor...</main>;
  if (error || !contractor) return <main className="min-h-screen bg-[#f5f7fb] p-8"><div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{error || "Contractor not found."}</div></main>;
  const banner = overallStatus(records);
  const followupModal = followupModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
    <h2 className="text-xl font-semibold">{editingFollowup ? "Edit Follow-Up" : "Add Follow-Up"}</h2>
    <form onSubmit={saveFollowup} className="mt-5 space-y-4">
      <div><label htmlFor="followup_date" className="mb-1 block text-sm font-medium text-slate-700">Date</label><input id="followup_date" type="date" value={followupForm.followup_date} onChange={(event) => setFollowupForm((current) => ({ ...current, followup_date: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div><label htmlFor="followup_method" className="mb-1 block text-sm font-medium text-slate-700">Method</label><select id="followup_method" value={followupForm.followup_method} onChange={(event) => setFollowupForm((current) => ({ ...current, followup_method: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">{followupMethods.map((method) => <option key={method} value={method}>{method}</option>)}</select></div>
        <div><label htmlFor="followup_status" className="mb-1 block text-sm font-medium text-slate-700">Status</label><select id="followup_status" value={followupForm.status} onChange={(event) => setFollowupForm((current) => ({ ...current, status: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">{followupStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></div>
      </div>
      {followupRelatedFields}
      <div><label htmlFor="followup_subject" className="mb-1 block text-sm font-medium text-slate-700">Subject</label><input id="followup_subject" value={followupForm.subject} onChange={(event) => setFollowupForm((current) => ({ ...current, subject: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div>
      <div><label htmlFor="followup_notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label><textarea id="followup_notes" rows={4} value={followupForm.notes} onChange={(event) => setFollowupForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div>
      {followupError ? <p role="alert" className="text-sm text-red-600">{followupError}</p> : null}
      <div className="flex justify-end gap-3"><button type="button" onClick={() => { setFollowupModalOpen(false); setEditingFollowup(null); }} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving || complianceTypesLoading} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : editingFollowup ? "Save Changes" : "Save Follow-Up"}</button></div>
    </form>
  </div></div> : null;
  const complianceTypeField = complianceTypesLoading ? <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-500">Loading compliance types...</p> : complianceTypesError ? <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{complianceTypesError}</p> : complianceTypes.length === 0 ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">No active compliance types available.</p> : <select aria-label="Compliance Type" value={complianceForm.compliance_type_id} onChange={(event) => setComplianceForm((current) => ({ ...current, compliance_type_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"><option value="">Select compliance type</option>{complianceTypes.map((type) => <option key={type.id} value={type.id}>{type.compliance_name}</option>)}</select>;
  const complianceModal = complianceModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">{editingRecord ? "Edit Compliance Record" : "Add Compliance Record"}</h2><form onSubmit={saveCompliance} className="mt-5 space-y-4">{complianceTypeField}<input aria-label="Registration Number" placeholder="Registration Number" value={complianceForm.registration_number} onChange={(event) => setComplianceForm((current) => ({ ...current, registration_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><div className="grid gap-4 sm:grid-cols-2"><input aria-label="Effective Date" type="date" value={complianceForm.effective_date} onChange={(event) => setComplianceForm((current) => ({ ...current, effective_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><input aria-label="Expiration Date" type="date" value={complianceForm.expiration_date} onChange={(event) => setComplianceForm((current) => ({ ...current, expiration_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div>{complianceError ? <p className="text-sm text-red-600">{complianceError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setComplianceModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving || complianceTypesLoading || Boolean(complianceTypesError) || complianceTypes.length === 0} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : editingRecord ? "Save Changes" : "Add Record"}</button></div></form></div></div> : null;
  const bannerStyle = banner === "Compliant" ? "bg-emerald-100 text-emerald-700" : banner === "Expiring Soon" ? "bg-amber-100 text-amber-700" : banner === "Expired" ? "bg-[#7f1d1d] text-white" : banner === "Non-Compliant" ? "bg-red-100 text-red-700" : "bg-sky-100 text-sky-700";

  return <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-6 lg:p-8"><div className="mx-auto max-w-[1600px] space-y-6"><header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><Link href="/contractors" className="text-sm font-medium text-indigo-600">Back to Contractors</Link><h1 className="mt-4 text-3xl font-semibold text-slate-900">{contractor.company_name}</h1><p className="mt-1 text-sm text-slate-500">Contractor operations center</p></div><div className="flex flex-wrap items-center gap-3"><span className={`rounded-full px-3 py-1.5 text-sm font-semibold ${bannerStyle}`}>{banner}</span></div></header>{success ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div> : null}
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[{ label: "Active Projects", value: summary.activeProjects, tone: "text-indigo-700" }, { label: "Active Compliance Records", value: summary.activeCompliance, tone: "text-emerald-700" }, { label: "Expiring Compliance Records", value: summary.expiringCompliance, tone: "text-amber-700" }, { label: "Expired Compliance Records", value: summary.expiredCompliance, tone: "text-red-700" }].map((card) => <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">{card.label}</p><p className={`mt-3 text-3xl font-semibold ${card.tone}`}>{card.value}</p></div>)}</section>
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-6"><h2 className="text-xl font-semibold">Company Information</h2><div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px] xl:grid-cols-[minmax(0,1fr)_400px]"><div className="min-w-0"><div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{[["Company Name", contractor.company_name], ["Trade", contractor.trade], ["Material Vendor Only", contractor.material_vendor_only ? "Yes" : "No"], ["Contact Name", contractor.contact_name], ["Email", contractor.email], ["Phone", contractor.phone]].map(([label, value]) => <div key={label}><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{value || "—"}</p></div>)}</div><div className="mt-3 space-y-2"><CompanyField label="Address 1" value={contractor.address_1} /><CompanyField label="Address 2" value={contractor.address_2} /><div className="flex flex-wrap items-start gap-x-4 gap-y-3"><div className="min-w-[8rem]"><CompanyField label="City" value={contractor.city} /></div><div className="w-14"><CompanyField label="State" value={contractor.state} /></div><div className="w-20"><CompanyField label="Zip Code" value={contractor.zip_code} /></div><div className="min-w-[8rem]"><CompanyField label="County" value={contractor.county} /></div></div><div className="grid grid-cols-2 gap-3 min-[480px]:grid-cols-4"><CompanyField label="NJ PWC #" value={contractor.nj_pwc_number} /><CompanyField label="NJ BRC #" value={contractor.nj_brc_number} /><CompanyField label="NY PWC #" value={contractor.ny_pwc_number} /><CompanyField label="NY BRC #" value={contractor.ny_brc_number} /></div><div className="grid grid-cols-1 gap-3 min-[480px]:grid-cols-2"><CompanyField label="BRC Name Control" value={contractor.brc_name_control ?? getBrcNameControl(contractor.company_name)} /><CompanyField label="Sage ERP ID" value={contractor.sage_erp_id} /></div></div><div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{[["Notes", contractor.notes], ["Active Status", contractor.active ? "Active" : "Inactive"]].map(([label, value]) => <div key={label}><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{value || "—"}</p></div>)}</div><div className="mt-6 border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-700">Active Compliance Records</h3><div className="mt-2 overflow-x-auto"><table className="min-w-[750px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Compliance Type", "Registration Number", "Effective Date", "Expiration Date", "Current Status", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{activeRecords.map((record) => <tr key={record.id}><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{record.compliance_name}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.registration_number || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.effective_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.expiration_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[record.calculated_status]}`}>{record.calculated_status}</span></td><td className="border border-slate-200 px-4 py-3 text-sm"><div className="flex gap-3"><button type="button" onClick={() => openComplianceEdit(record)} className="font-medium text-indigo-600">Edit</button><button type="button" disabled={saving} onClick={() => void archiveCompliance(record.id)} className="font-medium text-red-600 disabled:opacity-50">Archive</button></div></td></tr>)}</tbody></table>{activeRecords.length === 0 ? <p className="p-5 text-sm text-slate-500">No active compliance records found.</p> : null}</div><div className="mt-6 border-t border-slate-200 pt-4"><div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-slate-700">Synced Compliance Records</h3><div className="flex items-center gap-2">{njPwcRequestId !== null ? <button type="button" onClick={() => void handleNjPwcSearch()} disabled={njPwcSearching} className="whitespace-nowrap rounded-xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-50">Check Search Status</button> : null}{njPwcRequestId !== null ? <button type="button" onClick={() => void handleNjPwcStartNew()} disabled={njPwcSearching} className="whitespace-nowrap rounded-xl border border-slate-200 px-4 py-2 text-sm disabled:opacity-50">Start New Search</button> : null}<button type="button" onClick={() => void handleNjPwcSearch()} disabled={njPwcSearching || njPwcRequestId !== null} className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50">{njPwcSearching ? "Searching..." : "Search NJ PWC"}</button></div></div><p className="mt-1 text-xs text-slate-400">Synced Compliance Records are reserved for future NJ/NY registration verification and do not currently affect compliance status, dashboard counts, reports, or expiration tracking.</p>{njPwcMessage ? <p className="mt-2 text-sm text-slate-600">{njPwcMessage}</p> : null}{njPwcNoMatch ? <p className="mt-2 text-sm text-slate-600">No NJ PWC match was found for this contractor.</p> : null}{njPwcTrackingError ? <p className="mt-2 text-sm text-red-600">{njPwcTrackingError}</p> : null}<div className="mt-2 overflow-x-auto"><table className="min-w-[1100px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Compliance Type", "Registration Number", "Status", "Effective Date", "Expiration Date", "Last Verified", "Last Sync", "Sync Source", "Sync Status"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{syncedRecords.map((record) => <tr key={record.id}><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{record.compliance_name}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.registration_number || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.synced_status || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.synced_effective_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.synced_expiration_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.synced_last_verified_at ? new Date(record.synced_last_verified_at).toLocaleDateString() : "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.last_sync_at ? new Date(record.last_sync_at).toLocaleString() : "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.sync_source ? <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-semibold text-slate-600">{record.sync_source}</span> : "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.sync_status || "Never Synced"}</td></tr>)}</tbody></table>{syncedRecords.length === 0 ? <p className="p-5 text-sm text-slate-500">No synced compliance records found.</p> : null}{syncedRecords.filter((record) => record.compliance_name === "NJ BRC" && record.last_sync_at).map((record) => <div key={`brc-${record.id}`} className="border-t border-slate-100 px-4 py-3 text-xs text-slate-600"><span className="font-semibold text-slate-700">NJ BRC lookup details:</span> <span className="ml-2">Name Control Used: {record.searched_name_control || "-"}</span> <span className="ml-3">Business Entity ID Used: {record.searched_business_entity_id || "-"}</span> <span className="ml-3">Matched Company: {record.matched_company_name || "-"}</span> <span className="ml-3">Certificate #: {record.certificate_number || "-"}</span></div>)}</div></div></div><div className="mt-6 border-t border-slate-200 pt-4"><h3 className="text-sm font-semibold text-slate-700">Insurance Tracking</h3><p className="text-sm text-slate-500">Insurance managed in MyCOI</p><form onSubmit={saveInsurance} className="mt-3 space-y-4"><label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={insuranceForm.certificate_on_file} onChange={(event) => setInsuranceForm((current) => ({ ...current, certificate_on_file: event.target.checked }))} />Certificate Of Insurance On File</label><div><label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={insuranceForm.general_liability_on_file} onChange={(event) => setInsuranceForm((current) => ({ ...current, general_liability_on_file: event.target.checked }))} />General Liability</label><div className="mt-2 flex flex-wrap items-center gap-2"><label htmlFor="general_liability_expiration_date" className="text-xs font-medium text-slate-500">Expiration Date</label><input id="general_liability_expiration_date" type="date" value={insuranceForm.general_liability_expiration_date} onChange={(event) => setInsuranceForm((current) => ({ ...current, general_liability_expiration_date: event.target.value }))} className="w-40 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm" /></div></div><div><label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={insuranceForm.workers_comp_on_file} onChange={(event) => setInsuranceForm((current) => ({ ...current, workers_comp_on_file: event.target.checked }))} />Worker's Comp</label><div className="mt-2 flex flex-wrap items-center gap-2"><label htmlFor="workers_comp_expiration_date" className="text-xs font-medium text-slate-500">Expiration Date</label><input id="workers_comp_expiration_date" type="date" value={insuranceForm.workers_comp_expiration_date} onChange={(event) => setInsuranceForm((current) => ({ ...current, workers_comp_expiration_date: event.target.value }))} className="w-40 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm" /></div></div>{insuranceError ? <p className="text-sm text-red-600">{insuranceError}</p> : null}<div className="flex items-center justify-between gap-4"><p className="text-sm text-slate-500">Current status: {insurance?.certificate_on_file ? "On file" : "Not on file"}</p><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white disabled:opacity-50">{saving ? "Saving..." : "Save Insurance Tracking"}</button></div></form></div><div className="mt-2 border-t border-slate-200 pt-3"><p className="text-sm font-semibold text-slate-700">Assign Projects</p>{activeProjects.length === 0 ? <p className="mt-2 text-xs text-slate-500">No projects available.</p> : <div className="mt-2 grid max-h-28 grid-cols-5 gap-x-2 gap-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">{activeProjects.map((project) => <label key={project.id} title={project.project_name} className="flex items-center gap-1 text-[11px] text-slate-700"><input type="checkbox" checked={assignedProjectIds.has(project.id)} disabled={togglingProjectId === project.id} onChange={() => void toggleProjectAssignment(project)} />{project.project_number}</label>)}</div>}{assignmentError ? <p className="mt-2 text-xs text-red-600">{assignmentError}</p> : null}</div>
    </div><div className="flex min-w-0 flex-col gap-3 lg:border-l lg:border-slate-200 lg:pl-6"><div className="flex flex-wrap gap-3"><button type="button" onClick={openComplianceCreate} className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">Add Compliance Record</button><button type="button" onClick={() => { setFollowupError(null); setEditingFollowup(null); setFollowupForm({ followup_date: new Date().toISOString().slice(0, 10), followup_method: "Email", related_item: "", compliance_record_id: "", subject: "", notes: "", status: "Open" }); setFollowupModalOpen(true); }} className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">Add Follow-Up</button><button type="button" onClick={openEdit} className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">Edit Contractor</button>{contractor.active ? <button type="button" onClick={() => setConfirmingDeactivate(true)} className="whitespace-nowrap rounded-xl border border-red-200 px-4 py-2.5 text-sm text-red-600">Deactivate Contractor</button> : <button type="button" onClick={() => setConfirmingDeactivate(true)} className="whitespace-nowrap rounded-xl border border-emerald-200 px-4 py-2.5 text-sm text-emerald-700">Activate Contractor</button>}</div>
    <TieredSubRelationshipsPanel contractorId={contractorId} companyName={contractor.company_name} relationships={tieredSubs} parentAssignments={assignments} loading={tieredSubsLoading} error={tieredSubsError}>
      <div className="mt-3 border-t border-slate-200 pt-3">
        <button type="button" onClick={() => toggleSection("tieredSubs")} aria-expanded={openSections.tieredSubs} className="flex w-full items-center justify-between text-left text-sm font-semibold text-slate-900"><span><ExpandIcon isOpen={openSections.tieredSubs} /> Manage Tiered Subs</span></button>
        {openSections.tieredSubs ? <div className="mt-3">
          <input type="search" aria-label="Search tiered-sub companies" value={tieredSubSearch} onChange={(event) => setTieredSubSearch(event.target.value)} placeholder="Search companies" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />
          <div className="mt-2 max-h-56 space-y-2 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">{tieredSubsLoading ? <p className="text-sm text-slate-500">Loading companies...</p> : filteredAvailableCompanies.length === 0 ? <p className="text-sm text-slate-500">No contractor companies available.</p> : filteredAvailableCompanies.map((company) => <label key={company.id} className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={assignedTieredSubIds.has(company.id)} disabled={togglingTieredSubId === company.id} onChange={() => void toggleTieredSub(company)} />{company.company_name}</label>)}</div>
        </div> : null}
      </div>
    </TieredSubRelationshipsPanel>
    <section aria-labelledby="active-followups-heading" className="mt-2 border-t border-slate-200 pt-3">
      <h3 id="active-followups-heading" className="text-sm font-semibold text-slate-700">Active Follow-Ups ({activeFollowups.length})</h3>
      <div className="mt-2 space-y-2">
        {activeFollowups.map((followup) => {
          return <button key={followup.id} type="button" onClick={() => openFollowupEdit(followup)} className="block w-full cursor-pointer rounded-xl border border-slate-200 bg-slate-50 p-3 text-left transition-colors hover:border-indigo-300 hover:bg-indigo-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            <span className="block break-words text-sm font-semibold text-slate-900">{followup.subject}</span>
            <span className="mt-1 block text-xs text-slate-600">Follow-Up Date: {followup.followup_date}</span>
            <span className="block text-xs text-slate-600">Status: {followup.status}</span>
            <span className="block text-xs text-slate-600">Method: {followup.followup_method}</span>
            <span className="block text-xs text-slate-600">Related Item: {getFollowupRelatedLabel(followup, records, complianceTypes)}</span>
            <span className="mt-2 block text-xs font-medium text-indigo-600">Edit Follow-Up</span>
          </button>;
        })}
        {activeFollowups.length === 0 ? <p className="text-xs text-slate-500">No active follow-ups.</p> : null}
      </div>
    </section>
    <div className="mt-3 border-t border-slate-200 pt-3"><p className="text-sm font-semibold text-slate-700">Follow-Up Summary</p><div className="mt-2 space-y-1">{followupStatuses.map((status) => <button key={status} type="button" onClick={() => handleFollowupStatusClick(status)} className={`flex w-full items-center justify-between rounded-lg px-2 py-1 text-xs ${followupStatusFilter === status ? "bg-slate-900 text-white" : "text-slate-700 hover:bg-slate-100"}`}><span>{status}</span><span className="font-semibold">{followupSummary[status]}</span></button>)}</div><div className="mt-3 border-t border-slate-200 pt-3"><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Last Follow-Up</p>{lastFollowup ? <div className="mt-1 space-y-0.5 text-xs text-slate-700"><p>Date: {lastFollowup.followup_date}</p><p>Method: {lastFollowup.followup_method}</p><p>Subject: {lastFollowup.subject}</p></div> : <p className="mt-1 text-xs text-slate-500">No follow-ups recorded.</p>}</div></div></div></div></section>

    <CollapsibleSection title="Company History" isOpen={openSections.companyHistory} onToggle={() => toggleSection("companyHistory")}><div className="space-y-4 p-4">
    <CollapsibleSection title="Project History" isOpen={openSections.projectHistory} onToggle={() => toggleSection("projectHistory")}><div className="overflow-x-auto"><table className="min-w-[1200px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Project Number", "Project Name", "Project Status", "Assignment Date", "Removal Date", "Assignment Status", "Inactive By", "Inactive Date"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{sortedAssignmentHistory.map((assignment) => <tr key={assignment.id}><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_number || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_name || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.status || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.assigned_date}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.removed_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.active ? "Active" : "Removed"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.inactivated_by || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.inactivated_at ? new Date(assignment.projects.inactivated_at).toLocaleString() : "-"}</td></tr>)}</tbody></table>{assignmentHistory.length === 0 ? <p className="p-5 text-sm text-slate-500">No project history found.</p> : null}</div></CollapsibleSection>
    <CollapsibleSection title="Compliance History" isOpen={openSections.complianceHistory} onToggle={() => toggleSection("complianceHistory")}><div className="overflow-x-auto"><table className="min-w-[750px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Compliance Type", "Registration Number", "Effective Date", "Expiration Date", "Active Status", "Current Status"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{records.map((record) => <tr key={record.id}><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{record.compliance_name}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.registration_number || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.effective_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.expiration_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.active ? "Active" : "Inactive"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[record.calculated_status]}`}>{record.calculated_status}</span></td></tr>)}</tbody></table>{records.length === 0 ? <p className="p-5 text-sm text-slate-500">No compliance history found.</p> : null}</div></CollapsibleSection>
    <CollapsibleSection title="Insurance Verification History" isOpen={openSections.insuranceHistory} onToggle={() => toggleSection("insuranceHistory")}><div className="overflow-x-auto"><table className="min-w-[900px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["COI On File", "General Liability", "GL Expiration Date", "Worker's Comp", "WC Expiration Date", "Recorded Date"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{insuranceHistory.map((entry) => <tr key={entry.id}><td className="border border-slate-200 px-4 py-3 text-sm">{entry.coi_on_file ? "Yes" : "No"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{entry.general_liability_on_file ? "Yes" : "No"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{entry.general_liability_expiration_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{entry.workers_comp_on_file ? "Yes" : "No"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{entry.workers_comp_expiration_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{new Date(entry.created_at).toLocaleString()}</td></tr>)}</tbody></table>{insuranceHistory.length === 0 ? <p className="p-5 text-sm text-slate-500">No insurance verification history found.</p> : null}</div></CollapsibleSection>
    <CollapsibleSection title="Compliance Follow-Up History" isOpen={openSections.followupHistory} onToggle={() => toggleSection("followupHistory")}><div className="overflow-x-auto">
      {followupStatusFilter ? <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs text-slate-600"><span>Filtered to: {followupStatusFilter}</span><button type="button" onClick={() => setFollowupStatusFilter(null)} className="font-medium text-indigo-600">Show All</button></div> : null}
      <table className="min-w-[1000px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Date", "Method", "Subject", "Related Item", "Status", "Notes", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{filteredFollowups.map((followup) => <tr key={followup.id}>
        <td className="border border-slate-200 px-4 py-3 text-sm">{followup.followup_date}</td><td className="border border-slate-200 px-4 py-3 text-sm">{followup.followup_method}</td><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{followup.subject}</td>
        <td className="border border-slate-200 px-4 py-3 text-sm">{getFollowupRelatedLabel(followup, records, complianceTypes)}</td>
        <td className="border border-slate-200 px-4 py-3 text-sm">{followup.status}</td><td className="border border-slate-200 px-4 py-3 text-sm">{followup.notes || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><button type="button" onClick={() => openFollowupEdit(followup)} className="font-medium text-indigo-600">Edit</button></td>
      </tr>)}</tbody></table>{filteredFollowups.length === 0 ? <p className="p-5 text-sm text-slate-500">No follow-ups found.</p> : null}
    </div></CollapsibleSection>
    <CollapsibleSection title="Recent Activity" isOpen={openSections.activity} onToggle={() => toggleSection("activity")}>{activity.length === 0 ? <p className="p-5 text-sm text-slate-500">No recent activity found.</p> : activity.map((item) => <div key={item.id} className="grid gap-2 border-b border-slate-100 px-5 py-4 sm:grid-cols-[140px_160px_1fr_180px]"><span className="text-sm text-slate-500">{item.activity_date}</span><span className="text-sm font-medium">{item.activity_type}</span><span className="text-sm text-slate-600">{item.notes || "—"}</span><span className="text-sm text-slate-500">{item.created_by ? `by ${item.created_by}` : "—"}</span></div>)}</CollapsibleSection>
    <CollapsibleSection title="Tiered Subs History" isOpen={openSections.tieredSubHistory} onToggle={() => toggleSection("tieredSubHistory")}><div className="overflow-x-auto"><table className="min-w-[800px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Company Name", "Assigned Date", "Removed Date", "Status"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{tieredSubHistory.map((sub) => <tr key={sub.id}><td className="border border-slate-200 px-4 py-3 text-sm font-medium"><Link href={`/contractors/${sub.tiered_sub_contractor_id}`} className="text-indigo-600 hover:text-indigo-800">{sub.tiered_sub_contractor?.company_name ?? "Unknown Company"}</Link></td><td className="border border-slate-200 px-4 py-3 text-sm">{sub.assigned_date}</td><td className="border border-slate-200 px-4 py-3 text-sm">{sub.removed_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{sub.active ? "Active" : "Removed"}</td></tr>)}</tbody></table>{tieredSubHistory.length === 0 ? <p className="p-5 text-sm text-slate-500">No Tiered Subs history found.</p> : null}</div></CollapsibleSection>
    </div></CollapsibleSection>
    {followupModal}
    {complianceModal}
    {editing ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Edit Contractor</h2><form onSubmit={saveEdit} className="mt-5 space-y-4">{(["company_name", "trade", "contact_name", "email", "phone"] as const).map((field) => <Fragment key={field}><input aria-label={field === "company_name" ? "Company Name" : field} type={field === "email" ? "email" : "text"} placeholder={field === "company_name" ? "Company Name" : field} value={form[field]} onChange={(event) => field === "company_name" ? handleCompanyNameChange(event.target.value) : setForm((current) => ({ ...current, [field]: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />{field === "company_name" ? <label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={form.material_vendor_only} onChange={(event) => setForm((current) => ({ ...current, material_vendor_only: event.target.checked }))} />Material Vendor Only</label> : null}</Fragment>)}<div className="space-y-3"><ContractorTextInput label="Address 1" value={form.address_1} onChange={(value) => setForm((current) => ({ ...current, address_1: value }))} /><ContractorTextInput label="Address 2" value={form.address_2} onChange={(value) => setForm((current) => ({ ...current, address_2: value }))} /><div className="flex flex-wrap items-start gap-x-4 gap-y-3"><div className="min-w-[8rem]"><ContractorTextInput label="City" value={form.city} onChange={(value) => setForm((current) => ({ ...current, city: value }))} /></div><div className="w-14"><ContractorTextInput label="State" value={form.state} onChange={(value) => setForm((current) => ({ ...current, state: value }))} /></div><div className="w-20"><ContractorTextInput label="Zip Code" value={form.zip_code} onChange={(value) => setForm((current) => ({ ...current, zip_code: value }))} /></div><div className="min-w-[8rem]"><ContractorTextInput label="County" value={form.county} onChange={(value) => setForm((current) => ({ ...current, county: value }))} /></div></div><div className="grid grid-cols-2 gap-3 min-[480px]:grid-cols-4"><ContractorTextInput label="NJ PWC #" value={form.nj_pwc_number} onChange={(value) => setForm((current) => ({ ...current, nj_pwc_number: value }))} /><ContractorTextInput label="NJ BRC #" value={form.nj_brc_number} onChange={(value) => setForm((current) => ({ ...current, nj_brc_number: value }))} /><ContractorTextInput label="NY PWC #" value={form.ny_pwc_number} onChange={(value) => setForm((current) => ({ ...current, ny_pwc_number: value }))} /><ContractorTextInput label="NY BRC #" value={form.ny_brc_number} onChange={(value) => setForm((current) => ({ ...current, ny_brc_number: value }))} /></div><div className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2"><ContractorTextInput label="BRC Name Control" value={form.brc_name_control} maxLength={4} onChange={handleBrcNameControlChange} /><ContractorTextInput label="Sage ERP ID" value={form.sage_erp_id} onChange={(value) => setForm((current) => ({ ...current, sage_erp_id: value }))} /></div></div><textarea aria-label="Notes" placeholder="Notes" rows={3} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} />Active</label>{formError ? <p className="text-sm text-red-600">{formError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setEditing(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Save Changes"}</button></div></form></div></div> : null}
    {confirmingDeactivate ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">{contractor.active ? "Deactivate Contractor?" : "Activate Contractor?"}</h2><p className="mt-3 text-sm text-slate-600">{contractor.active ? `This will mark ${contractor.company_name} inactive without deleting the record. All compliance, insurance, project, follow-up, and history records will be preserved.` : `This will mark ${contractor.company_name} active again. All historical records are preserved.`}</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setConfirmingDeactivate(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="button" onClick={() => void (contractor.active ? deactivate() : activate())} disabled={saving} className={`rounded-xl px-4 py-2.5 text-sm text-white ${contractor.active ? "bg-red-600" : "bg-emerald-600"}`}>{saving ? "Saving..." : contractor.active ? "Deactivate" : "Activate"}</button></div></div></div> : null}
    {njPwcResultsOpen ? (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4">
        <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-xl font-semibold">NJ PWC Registry Matches</h2>
            <button type="button" onClick={() => setNjPwcResultsOpen(false)} className="text-sm text-slate-500">Cancel</button>
          </div>
          <p className="text-sm text-slate-500">Select the correct company. {njPwcCandidates.length > 1 ? "Multiple matches were found — choose one to continue." : "Review the match to continue."}</p>
          <div className="mt-4 space-y-3">
            {njPwcCandidates.map((candidate, index) => (
              <div key={index} className="rounded-xl border border-slate-200 p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900">{candidate.business_name ?? "—"}</p>
                    <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-600 sm:grid-cols-3">
                      <div><dt className="font-semibold text-slate-400">Certificate #</dt><dd>{candidate.certificate_number ?? "—"}</dd></div>
                      <div><dt className="font-semibold text-slate-400">Registration Date</dt><dd>{candidate.registration_date ?? "—"}</dd></div>
                      <div><dt className="font-semibold text-slate-400">Expiration Date</dt><dd>{candidate.expiration_date ?? "—"}</dd></div>
                      <div><dt className="font-semibold text-slate-400">County</dt><dd>{candidate.county ?? "—"}</dd></div>
                      <div className="col-span-2 sm:col-span-3"><dt className="font-semibold text-slate-400">Address</dt><dd>{[candidate.address, candidate.city, candidate.state, candidate.zip_code, candidate.county].filter(Boolean).join(", ") || "—"}</dd></div>
                    </dl>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => handleNjPwcSelect(candidate)} className="whitespace-nowrap rounded-xl bg-slate-900 px-4 py-2 text-sm text-white">Select Match</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div className="mt-5 flex justify-end"><button type="button" onClick={() => setNjPwcResultsOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button></div>
        </div>
      </div>
    ) : null}
    {njPwcImportOpen && njPwcSelected ? (
      <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-900/40 px-4">
        <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
          <h2 className="text-xl font-semibold">Import NJ PWC Information</h2>
          <p className="mt-1 text-sm text-slate-500">Compare the registry values against the current contractor values and choose what to import. Fields already populated are unchecked by default. Company Name is never changed unless explicitly selected.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead className="bg-slate-50"><tr><th className="border border-slate-200 px-3 py-2">Field</th><th className="border border-slate-200 px-3 py-2">Registry Value</th><th className="border border-slate-200 px-3 py-2">Current Value</th><th className="border border-slate-200 px-3 py-2">Import</th></tr></thead>
              <tbody>
                {([
                  { key: "companyName", label: "Company Name", registry: njPwcSelected.business_name, current: contractor?.company_name ?? "" },
                  { key: "pwcNumber", label: "NJ PWC #", registry: njPwcSelected.certificate_number, current: contractor?.nj_pwc_number ?? "" },
                  { key: "address", label: "Address 1", registry: njPwcSelected.address, current: contractor?.address_1 ?? "" },
                  { key: "city", label: "City", registry: njPwcSelected.city, current: contractor?.city ?? "" },
                  { key: "state", label: "State", registry: njPwcSelected.state, current: contractor?.state ?? "" },
                  { key: "zip", label: "ZIP Code", registry: njPwcSelected.zip_code, current: contractor?.zip_code ?? "" },
                  { key: "county", label: "County", registry: njPwcSelected.county, current: contractor?.county ?? "" },
                ] as const).map((row) => (
                  <tr key={row.key}>
                    <td className="border border-slate-200 px-3 py-2 font-medium">{row.label}</td>
                    <td className="border border-slate-200 px-3 py-2">{row.registry ?? "—"}</td>
                    <td className="border border-slate-200 px-3 py-2">{(row.current ?? "").trim() || "—"}</td>
                    <td className="border border-slate-200 px-3 py-2"><input type="checkbox" aria-label={`Import ${row.label}`} checked={njPwcImportChoices[row.key]} disabled={!row.registry} onChange={(event) => setNjPwcImportChoices((current) => ({ ...current, [row.key]: event.target.checked }))} /></td>
                  </tr>
                ))}
                <tr>
                  <td className="border border-slate-200 px-3 py-2 font-medium">Registration Date</td>
                  <td className="border border-slate-200 px-3 py-2">{njPwcSelected.registration_date ?? "—"}</td>
                  <td className="border border-slate-200 px-3 py-2 text-slate-400">Synced record</td>
                  <td className="border border-slate-200 px-3 py-2 text-slate-400">—</td>
                </tr>
                <tr>
                  <td className="border border-slate-200 px-3 py-2 font-medium">Expiration Date</td>
                  <td className="border border-slate-200 px-3 py-2">{njPwcSelected.expiration_date ?? "—"}</td>
                  <td className="border border-slate-200 px-3 py-2 text-slate-400">Synced record</td>
                  <td className="border border-slate-200 px-3 py-2 text-slate-400">—</td>
                </tr>
              </tbody>
            </table>
          </div>
          <label className="mt-4 flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={njPwcImportChoices.syncedRecord} onChange={(event) => setNjPwcImportChoices((current) => ({ ...current, syncedRecord: event.target.checked }))} />Create NJ PWC Synced Compliance Record</label>
          <div className="mt-5 flex justify-end gap-3">
            <button type="button" onClick={() => setNjPwcImportOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button>
            <button type="button" onClick={() => void handleNjPwcImport()} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">Import Selected Information</button>
          </div>
        </div>
      </div>
    ) : null}
  </div></main>;
}
