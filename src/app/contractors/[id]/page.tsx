/*

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { getActivityForContractor } from "@/services/activity";
import { createAssignment, deactivateAssignment, getAssignmentHistoryForContractor, getAssignmentsForContractor } from "@/services/assignments";
import { getComplianceHistoryForContractor } from "@/services/compliance";
import { getContractorById, updateContractor } from "@/services/contractors";
import { getProjects } from "@/services/projects";
import type { ActivityLog, Assignment, ComplianceStatus, ComplianceStatusRecord, Contractor, Project } from "@/types/database";

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
import { useEffect, useMemo, useState } from "react";
import { getActivityForContractor } from "@/services/activity";
import { createAssignment, deactivateAssignment, getAssignmentHistoryForContractor, getAssignmentsForContractor } from "@/services/assignments";
import { archiveComplianceRecord, createComplianceRecord, getComplianceHistoryForContractor, getComplianceTypes, updateComplianceRecord } from "@/services/compliance";
import { getContractorById, updateContractor } from "@/services/contractors";
import { getInsuranceTracking, getInsuranceVerificationHistory, saveInsuranceTracking } from "@/services/insurance";
import { createFollowup, followupMethods, followupStatuses, getFollowupsForContractor } from "@/services/followups";
import { getProjects } from "@/services/projects";
import type { ActivityLog, Assignment, ComplianceHistoryRecord, ComplianceStatus, ComplianceType, Contractor, ContractorFollowup, InsuranceTracking, InsuranceVerificationHistory, Project } from "@/types/database";

const statusStyles: Record<ComplianceStatus, string> = { Active: "bg-emerald-100 text-emerald-700", "90 Day": "bg-amber-100 text-amber-700", "60 Day": "bg-orange-100 text-orange-700", "30 Day": "bg-red-100 text-red-700", Expired: "bg-[#7f1d1d] text-white", "Missing Information": "bg-sky-100 text-sky-700" };
const emptyForm = { company_name: "", trade: "", contact_name: "", email: "", phone: "", notes: "", active: true };

function overallStatus(records: ComplianceHistoryRecord[]) {
  const activeRecords = records.filter((record) => record.active);
  if (activeRecords.some((record) => record.calculated_status === "Expired")) return "Expired";
  if (activeRecords.some((record) => record.calculated_status === "Missing Information")) return "Missing Information";
  if (activeRecords.some((record) => ["90 Day", "60 Day", "30 Day"].includes(record.calculated_status))) return "Expiring Soon";
  return "Compliant";
}

export default function ContractorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const contractorId = Number(id);
  const [contractor, setContractor] = useState<Contractor | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [assignmentHistory, setAssignmentHistory] = useState<Assignment[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [records, setRecords] = useState<ComplianceHistoryRecord[]>([]);
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
  const [assignmentModalOpen, setAssignmentModalOpen] = useState(false);
  const [assignmentForm, setAssignmentForm] = useState({ project_id: "", assigned_date: new Date().toISOString().slice(0, 10), active: true });
  const [assignmentError, setAssignmentError] = useState<string | null>(null);
  const [complianceModalOpen, setComplianceModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<ComplianceHistoryRecord | null>(null);
  const [complianceForm, setComplianceForm] = useState({ compliance_type_id: "", registration_number: "", effective_date: "", expiration_date: "" });
  const [complianceError, setComplianceError] = useState<string | null>(null);
  const [insuranceForm, setInsuranceForm] = useState({ certificate_on_file: false, last_verified_date: "", notes: "" });
  const [insuranceError, setInsuranceError] = useState<string | null>(null);
  const [followupModalOpen, setFollowupModalOpen] = useState(false);
  const [followupForm, setFollowupForm] = useState({ followup_date: new Date().toISOString().slice(0, 10), followup_method: "Email", compliance_record_id: "", subject: "", notes: "", status: "Open" });
  const [followupError, setFollowupError] = useState<string | null>(null);

  const loadDetails = async () => {
    setLoading(true);
    setComplianceTypesLoading(true);
    setComplianceTypesError(null);
    const [{ data: contractorData, error: contractorError }, { data: assignmentData, error: assignmentsError }, { data: assignmentHistoryData, error: assignmentHistoryError }, { data: recordData, error: recordError }, { data: typeData, error: typesError }, { data: insuranceData, error: insuranceLoadError }, { data: insuranceHistoryData, error: insuranceHistoryLoadError }, { data: followupData, error: followupLoadError }, { data: activityData, error: activityError }, { data: projectData, error: projectsError }] = await Promise.all([getContractorById(contractorId), getAssignmentsForContractor(contractorId), getAssignmentHistoryForContractor(contractorId), getComplianceHistoryForContractor(contractorId), getComplianceTypes(), getInsuranceTracking(contractorId), getInsuranceVerificationHistory(contractorId), getFollowupsForContractor(contractorId), getActivityForContractor(contractorId), getProjects()]);
    const loadError = contractorError || assignmentsError || assignmentHistoryError || recordError || insuranceLoadError || insuranceHistoryLoadError || followupLoadError || activityError || projectsError;
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
      setComplianceTypes(typeData ?? []);
      setInsurance(insuranceData);
      setInsuranceHistory(insuranceHistoryData ?? []);
      setFollowups(followupData ?? []);
      setInsuranceForm({ certificate_on_file: insuranceData?.certificate_on_file ?? false, last_verified_date: insuranceData?.last_verified_date ?? "", notes: insuranceData?.notes ?? "" });
      setActivity(activityData ?? []);
    }
    setLoading(false);
  };

  useEffect(() => { if (Number.isFinite(contractorId)) void loadDetails(); else { setError("Invalid contractor ID."); setLoading(false); } }, [contractorId]);

  const activeRecords = useMemo(() => records.filter((record) => record.active), [records]);
  const summary = useMemo(() => ({
    activeProjects: assignments.length,
    activeCompliance: activeRecords.length,
    expiringCompliance: activeRecords.filter((record) => ["90 Day", "60 Day", "30 Day"].includes(record.calculated_status)).length,
    expiredCompliance: activeRecords.filter((record) => record.calculated_status === "Expired").length,
  }), [activeRecords, assignments.length]);
  const openEdit = () => { if (!contractor) return; setForm({ company_name: contractor.company_name, trade: contractor.trade ?? "", contact_name: contractor.contact_name ?? "", email: contractor.email ?? "", phone: contractor.phone ?? "", notes: contractor.notes ?? "", active: contractor.active }); setFormError(null); setSuccess(null); setEditing(true); };
  const saveEdit = async (event: React.FormEvent) => { event.preventDefault(); if (!form.company_name.trim()) { setFormError("Company Name is required."); return; } if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setFormError("Enter a valid email address."); return; } setSaving(true); const { error: updateError } = await updateContractor(contractorId, { company_name: form.company_name.trim(), trade: form.trade.trim() || null, contact_name: form.contact_name.trim() || null, email: form.email.trim() || null, phone: form.phone.trim() || null, notes: form.notes.trim() || null, active: form.active }); if (updateError) { setFormError(updateError.message); setSaving(false); return; } await loadDetails(); setEditing(false); setSaving(false); setSuccess("Contractor updated successfully."); };
  const deactivate = async () => { setSaving(true); const { error: updateError } = await updateContractor(contractorId, { active: false }); if (updateError) { setError(updateError.message); setSaving(false); return; } await loadDetails(); setConfirmingDeactivate(false); setSaving(false); setSuccess("Contractor deactivated successfully."); };
  const saveAssignment = async (event: React.FormEvent) => { event.preventDefault(); if (!assignmentForm.project_id) { setAssignmentError("Project is required."); return; } setSaving(true); setAssignmentError(null); const { error: createError } = await createAssignment({ contractor_id: contractorId, project_id: Number(assignmentForm.project_id), assigned_date: assignmentForm.assigned_date, active: assignmentForm.active }); if (createError) { setAssignmentError(createError.message); setSaving(false); return; } await loadDetails(); setAssignmentModalOpen(false); setAssignmentForm({ project_id: "", assigned_date: new Date().toISOString().slice(0, 10), active: true }); setSaving(false); setSuccess("Project assigned successfully."); };
  const removeAssignment = async (assignmentId: number) => { const { error: removeError } = await deactivateAssignment(assignmentId); if (removeError) { setError(removeError.message); return; } await loadDetails(); setSuccess("Assignment removed successfully."); };
  const openComplianceCreate = () => { setEditingRecord(null); setComplianceForm({ compliance_type_id: "", registration_number: "", effective_date: "", expiration_date: "" }); setComplianceError(null); setComplianceModalOpen(true); };
  const openComplianceEdit = (record: ComplianceHistoryRecord) => { setEditingRecord(record); setComplianceForm({ compliance_type_id: String(record.compliance_type_id), registration_number: record.registration_number ?? "", effective_date: record.effective_date ?? "", expiration_date: record.expiration_date ?? "" }); setComplianceError(null); setComplianceModalOpen(true); };
  const saveCompliance = async (event: React.FormEvent) => { event.preventDefault(); if (!complianceForm.compliance_type_id) { setComplianceError("Compliance Type is required."); return; } setSaving(true); setComplianceError(null); const payload = { compliance_type_id: Number(complianceForm.compliance_type_id), registration_number: complianceForm.registration_number.trim() || null, effective_date: complianceForm.effective_date || null, expiration_date: complianceForm.expiration_date || null, verified_date: null, verified_by: null, verification_source: null, is_current: true, active: true, notes: null }; const result = editingRecord ? await updateComplianceRecord(editingRecord.id, payload) : await createComplianceRecord({ contractor_id: contractorId, ...payload }); if (result.error) { setComplianceError(result.error.message); setSaving(false); return; } await loadDetails(); setComplianceModalOpen(false); setSaving(false); setSuccess(editingRecord ? "Compliance record updated successfully." : "Compliance record added successfully."); };
  const archiveCompliance = async (recordId: number) => { setSaving(true); const { error: archiveError } = await archiveComplianceRecord(recordId); if (archiveError) { setError(archiveError.message); setSaving(false); return; } await loadDetails(); setSaving(false); setSuccess("Compliance record archived successfully."); };
  const saveInsurance = async (event: React.FormEvent) => { event.preventDefault(); setSaving(true); setInsuranceError(null); const { error: saveError } = await saveInsuranceTracking(contractorId, { certificate_on_file: insuranceForm.certificate_on_file, last_verified_date: insuranceForm.last_verified_date || null, notes: insuranceForm.notes.trim() || null }); if (saveError) { setInsuranceError(saveError.message); setSaving(false); return; } await loadDetails(); setSaving(false); setSuccess("Insurance tracking updated successfully."); };
  const saveFollowup = async (event: React.FormEvent) => { event.preventDefault(); if (!followupForm.subject.trim()) { setFollowupError("Subject is required."); return; } setSaving(true); setFollowupError(null); const { error: createError } = await createFollowup({ contractor_id: contractorId, compliance_record_id: followupForm.compliance_record_id ? Number(followupForm.compliance_record_id) : null, followup_date: followupForm.followup_date, followup_method: followupForm.followup_method as ContractorFollowup["followup_method"], subject: followupForm.subject.trim(), notes: followupForm.notes.trim() || null, status: followupForm.status as ContractorFollowup["status"] }); if (createError) { setFollowupError(createError.message); setSaving(false); return; } await loadDetails(); setFollowupForm({ followup_date: new Date().toISOString().slice(0, 10), followup_method: "Email", compliance_record_id: "", subject: "", notes: "", status: "Open" }); setFollowupModalOpen(false); setSaving(false); setSuccess("Follow-up added successfully."); };

  if (loading) return <main className="min-h-screen bg-[#f5f7fb] p-8 text-sm text-slate-500">Loading contractor...</main>;
  if (error || !contractor) return <main className="min-h-screen bg-[#f5f7fb] p-8"><div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-sm text-red-700">{error || "Contractor not found."}</div></main>;
  const banner = overallStatus(records);
  const followupModal = followupModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Add Follow-Up</h2><form onSubmit={saveFollowup} className="mt-5 space-y-4"><div><label htmlFor="followup_date" className="mb-1 block text-sm font-medium text-slate-700">Date</label><input id="followup_date" type="date" value={followupForm.followup_date} onChange={(event) => setFollowupForm((current) => ({ ...current, followup_date: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div><div className="grid gap-4 sm:grid-cols-2"><div><label htmlFor="followup_method" className="mb-1 block text-sm font-medium text-slate-700">Method</label><select id="followup_method" value={followupForm.followup_method} onChange={(event) => setFollowupForm((current) => ({ ...current, followup_method: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">{followupMethods.map((method) => <option key={method} value={method}>{method}</option>)}</select></div><div><label htmlFor="followup_status" className="mb-1 block text-sm font-medium text-slate-700">Status</label><select id="followup_status" value={followupForm.status} onChange={(event) => setFollowupForm((current) => ({ ...current, status: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">{followupStatuses.map((status) => <option key={status} value={status}>{status}</option>)}</select></div></div><div><label htmlFor="related_compliance_record" className="mb-1 block text-sm font-medium text-slate-700">Related Compliance Record</label><select id="related_compliance_record" value={followupForm.compliance_record_id} onChange={(event) => setFollowupForm((current) => ({ ...current, compliance_record_id: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"><option value="">None</option>{records.filter((record) => record.active).map((record) => <option key={record.id} value={record.id}>{record.compliance_name}{record.expiration_date ? ` - expires ${record.expiration_date}` : ""}</option>)}</select></div><div><label htmlFor="followup_subject" className="mb-1 block text-sm font-medium text-slate-700">Subject</label><input id="followup_subject" value={followupForm.subject} onChange={(event) => setFollowupForm((current) => ({ ...current, subject: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div><div><label htmlFor="followup_notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label><textarea id="followup_notes" rows={4} value={followupForm.notes} onChange={(event) => setFollowupForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div>{followupError ? <p className="text-sm text-red-600">{followupError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setFollowupModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Save Follow-Up"}</button></div></form></div></div> : null;
  const assignmentModal = assignmentModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Assign Project</h2><form onSubmit={saveAssignment} className="mt-5 space-y-4"><select aria-label="Project" value={assignmentForm.project_id} onChange={(event) => setAssignmentForm((current) => ({ ...current, project_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.project_number} - {project.project_name}</option>)}</select><input aria-label="Assigned Date" type="date" value={assignmentForm.assigned_date} onChange={(event) => setAssignmentForm((current) => ({ ...current, assigned_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />{assignmentError ? <p className="text-sm text-red-600">{assignmentError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setAssignmentModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Assign Project"}</button></div></form></div></div> : null;
  const complianceTypeField = complianceTypesLoading ? <p className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-500">Loading compliance types...</p> : complianceTypesError ? <p className="rounded-xl border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">{complianceTypesError}</p> : complianceTypes.length === 0 ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-700">No active compliance types available.</p> : <select aria-label="Compliance Type" value={complianceForm.compliance_type_id} onChange={(event) => setComplianceForm((current) => ({ ...current, compliance_type_id: event.target.value }))} required className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm"><option value="">Select compliance type</option>{complianceTypes.map((type) => <option key={type.id} value={type.id}>{type.compliance_name}</option>)}</select>;
  const complianceModal = complianceModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">{editingRecord ? "Edit Compliance Record" : "Add Compliance Record"}</h2><form onSubmit={saveCompliance} className="mt-5 space-y-4">{complianceTypeField}<input aria-label="Registration Number" placeholder="Registration Number" value={complianceForm.registration_number} onChange={(event) => setComplianceForm((current) => ({ ...current, registration_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><div className="grid gap-4 sm:grid-cols-2"><input aria-label="Effective Date" type="date" value={complianceForm.effective_date} onChange={(event) => setComplianceForm((current) => ({ ...current, effective_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /><input aria-label="Expiration Date" type="date" value={complianceForm.expiration_date} onChange={(event) => setComplianceForm((current) => ({ ...current, expiration_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div>{complianceError ? <p className="text-sm text-red-600">{complianceError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setComplianceModalOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving || complianceTypesLoading || Boolean(complianceTypesError) || complianceTypes.length === 0} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : editingRecord ? "Save Changes" : "Add Record"}</button></div></form></div></div> : null;
  const bannerStyle = banner === "Compliant" ? "bg-emerald-100 text-emerald-700" : banner === "Expiring Soon" ? "bg-amber-100 text-amber-700" : banner === "Expired" ? "bg-[#7f1d1d] text-white" : "bg-sky-100 text-sky-700";

  return <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800"><div className="mx-auto max-w-7xl space-y-6"><header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><Link href="/contractors" className="text-sm font-medium text-indigo-600">Back to Contractors</Link><h1 className="mt-4 text-3xl font-semibold text-slate-900">{contractor.company_name}</h1><p className="mt-1 text-sm text-slate-500">Contractor operations center</p></div><div className="flex flex-wrap items-center gap-3"><button type="button" onClick={openEdit} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">Edit Contractor</button>{contractor.active ? <button type="button" onClick={() => setConfirmingDeactivate(true)} className="rounded-xl border border-red-200 px-4 py-2.5 text-sm text-red-600">Deactivate</button> : null}<span className={`rounded-full px-3 py-1.5 text-sm font-semibold ${bannerStyle}`}>{banner}</span></div></header>{success ? <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div> : null}
    <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[{ label: "Active Projects", value: summary.activeProjects, tone: "text-indigo-700" }, { label: "Active Compliance Records", value: summary.activeCompliance, tone: "text-emerald-700" }, { label: "Expiring Compliance Records", value: summary.expiringCompliance, tone: "text-amber-700" }, { label: "Expired Compliance Records", value: summary.expiredCompliance, tone: "text-red-700" }].map((card) => <div key={card.label} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm text-slate-500">{card.label}</p><p className={`mt-3 text-3xl font-semibold ${card.tone}`}>{card.value}</p></div>)}</section>
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="text-xl font-semibold">Company Information</h2><div className="mt-5 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{[["Company Name", contractor.company_name], ["Trade", contractor.trade], ["Contact Name", contractor.contact_name], ["Email", contractor.email], ["Phone", contractor.phone], ["Active Status", contractor.active ? "Active" : "Inactive"], ["Notes", contractor.notes]].map(([label, value]) => <div key={label}><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm text-slate-700">{value || "—"}</p></div>)}</div></section>
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"><div className="flex flex-col gap-1 border-b border-slate-200 pb-4"><h2 className="text-xl font-semibold">Insurance Tracking</h2><p className="text-sm text-slate-500">Insurance managed in MyCOI</p></div><form onSubmit={saveInsurance} className="mt-5 space-y-4"><label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={insuranceForm.certificate_on_file} onChange={(event) => setInsuranceForm((current) => ({ ...current, certificate_on_file: event.target.checked }))} />Certificate Of Insurance On File</label><div><label htmlFor="insurance_last_verified_date" className="mb-1 block text-sm font-medium text-slate-700">Last Verified Date</label><input id="insurance_last_verified_date" type="date" value={insuranceForm.last_verified_date} onChange={(event) => setInsuranceForm((current) => ({ ...current, last_verified_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div><div><label htmlFor="insurance_notes" className="mb-1 block text-sm font-medium text-slate-700">Notes</label><textarea id="insurance_notes" rows={3} value={insuranceForm.notes} onChange={(event) => setInsuranceForm((current) => ({ ...current, notes: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /></div>{insuranceError ? <p className="text-sm text-red-600">{insuranceError}</p> : null}<div className="flex items-center justify-between gap-4"><p className="text-sm text-slate-500">Current status: {insurance?.certificate_on_file ? "On file" : "Not on file"}</p><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white disabled:opacity-50">{saving ? "Saving..." : "Save Insurance Tracking"}</button></div></form></section>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className="border-b border-slate-200 px-5 py-4 text-xl font-semibold">Insurance Verification History</h2><div className="overflow-x-auto"><table className="min-w-[800px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["COI On File", "Last Verified Date", "Notes", "Recorded Date"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{insuranceHistory.map((entry) => <tr key={entry.id}><td className="border border-slate-200 px-4 py-3 text-sm">{entry.coi_on_file ? "Yes" : "No"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{entry.verified_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{entry.notes || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{new Date(entry.created_at).toLocaleString()}</td></tr>)}</tbody></table>{insuranceHistory.length === 0 ? <p className="p-5 text-sm text-slate-500">No insurance verification history found.</p> : null}</div></section>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold">Assigned Projects</h2><button type="button" onClick={() => { setAssignmentError(null); setAssignmentModalOpen(true); }} className="rounded-xl bg-slate-900 px-3 py-2 text-sm text-white">Assign Project</button></div><div className="overflow-x-auto"><table className="min-w-[780px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Project Number", "Project Name", "Project Status", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{assignments.map((assignment) => <tr key={assignment.id}><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_number || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_name || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.status || "—"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><button type="button" onClick={() => void removeAssignment(assignment.id)} className="font-medium text-red-600 hover:text-red-800">Remove Assignment</button></td></tr>)}</tbody></table>{assignments.length === 0 ? <p className="p-5 text-sm text-slate-500">No project assignments found.</p> : null}</div></section>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold">Active Compliance Records</h2><button type="button" onClick={openComplianceCreate} className="rounded-xl bg-slate-900 px-3 py-2 text-sm text-white">Add Compliance Record</button></div><div className="overflow-x-auto"><table className="min-w-[1050px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Compliance Type", "Registration Number", "Effective Date", "Expiration Date", "Current Status", "Actions"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{activeRecords.map((record) => <tr key={record.id}><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{record.compliance_name}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.registration_number || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.effective_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.expiration_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm"><span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyles[record.calculated_status]}`}>{record.calculated_status}</span></td><td className="border border-slate-200 px-4 py-3 text-sm"><div className="flex gap-3"><button type="button" onClick={() => openComplianceEdit(record)} className="font-medium text-indigo-600">Edit</button><button type="button" disabled={saving} onClick={() => void archiveCompliance(record.id)} className="font-medium text-red-600 disabled:opacity-50">Archive</button></div></td></tr>)}</tbody></table>{activeRecords.length === 0 ? <p className="p-5 text-sm text-slate-500">No active compliance records found.</p> : null}</div></section>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className="border-b border-slate-200 px-5 py-4 text-xl font-semibold">Project History</h2><div className="overflow-x-auto"><table className="min-w-[900px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Assignment Date", "Removal Date", "Project Number", "Project Name", "Assignment Status"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{assignmentHistory.map((assignment) => <tr key={assignment.id}><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.assigned_date}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.removed_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_number || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.projects?.project_name || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{assignment.active ? "Active" : "Removed"}</td></tr>)}</tbody></table>{assignmentHistory.length === 0 ? <p className="p-5 text-sm text-slate-500">No project history found.</p> : null}</div></section>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className="border-b border-slate-200 px-5 py-4 text-xl font-semibold">Compliance History</h2><div className="overflow-x-auto"><table className="min-w-[900px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Compliance Type", "Registration Number", "Effective Date", "Expiration Date"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{records.filter((record) => !record.active).map((record) => <tr key={record.id}><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{record.compliance_name}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.registration_number || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.effective_date || "-"}</td><td className="border border-slate-200 px-4 py-3 text-sm">{record.expiration_date || "-"}</td></tr>)}</tbody></table>{records.filter((record) => !record.active).length === 0 ? <p className="p-5 text-sm text-slate-500">No archived compliance records found.</p> : null}</div></section>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><div className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><h2 className="text-xl font-semibold">Compliance Follow-Up History</h2><button type="button" onClick={() => { setFollowupError(null); setFollowupModalOpen(true); }} className="rounded-xl bg-slate-900 px-3 py-2 text-sm text-white">Add Follow-Up</button></div><div className="overflow-x-auto"><table className="min-w-[950px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Date", "Method", "Subject", "Status", "Notes"].map((heading) => <th key={heading} className="border border-slate-200 px-4 py-3 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{followups.map((followup) => <tr key={followup.id}><td className="border border-slate-200 px-4 py-3 text-sm">{followup.followup_date}</td><td className="border border-slate-200 px-4 py-3 text-sm">{followup.followup_method}</td><td className="border border-slate-200 px-4 py-3 text-sm font-medium">{followup.subject}</td><td className="border border-slate-200 px-4 py-3 text-sm">{followup.status}</td><td className="border border-slate-200 px-4 py-3 text-sm">{followup.notes || "-"}</td></tr>)}</tbody></table>{followups.length === 0 ? <p className="p-5 text-sm text-slate-500">No compliance follow-ups found.</p> : null}</div></section>
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm"><h2 className="border-b border-slate-200 px-5 py-4 text-xl font-semibold">Recent Activity</h2>{activity.length === 0 ? <p className="p-5 text-sm text-slate-500">No recent activity found.</p> : activity.map((item) => <div key={item.id} className="grid gap-2 border-b border-slate-100 px-5 py-4 sm:grid-cols-[140px_160px_1fr]"><span className="text-sm text-slate-500">{item.activity_date}</span><span className="text-sm font-medium">{item.activity_type}</span><span className="text-sm text-slate-600">{item.notes || "—"}</span></div>)}</section>
    {followupModal}
    {assignmentModal}
    {complianceModal}
    {editing ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Edit Contractor</h2><form onSubmit={saveEdit} className="mt-5 space-y-4">{(["company_name", "trade", "contact_name", "email", "phone", "notes"] as const).map((field) => field === "notes" ? <textarea key={field} aria-label={field} placeholder={field} value={form[field]} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} rows={3} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" /> : <input key={field} aria-label={field} type={field === "email" ? "email" : "text"} placeholder={field} value={form[field]} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm" />)}<label className="flex items-center gap-3 text-sm"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} />Active</label>{formError ? <p className="text-sm text-red-600">{formError}</p> : null}<div className="flex justify-end gap-3"><button type="button" onClick={() => setEditing(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Save Changes"}</button></div></form></div></div> : null}
    {confirmingDeactivate ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold">Deactivate Contractor?</h2><p className="mt-3 text-sm text-slate-600">This will mark {contractor.company_name} inactive without deleting the record.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setConfirmingDeactivate(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="button" onClick={() => void deactivate()} disabled={saving} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm text-white">{saving ? "Deactivating..." : "Deactivate"}</button></div></div></div> : null}
  </div></main>;
}
