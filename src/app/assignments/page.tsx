"use client";

import { useEffect, useMemo, useState } from "react";
import { createAssignment, getAssignments } from "@/services/assignments";
import { getContractors } from "@/services/contractors";
import { getProjects } from "@/services/projects";
import type { Assignment, Contractor, Project } from "@/types/database";

const getToday = () => new Date().toISOString().slice(0, 10);

const emptyForm = {
  contractor_id: "",
  project_id: "",
  assigned_date: getToday(),
  active: true,
};

export default function AssignmentsPage() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchAssignments = async () => {
    setLoading(true);
    setError(null);

    const [{ data: assignmentData, error: assignmentsError }, { data: contractorData, error: contractorsError }, { data: projectData, error: projectsError }] = await Promise.all([
      getAssignments(),
      getContractors(),
      getProjects(),
    ]);

    const loadError = assignmentsError || contractorsError || projectsError;

    if (loadError) {
      setError(loadError.message || "Unable to load assignments.");
      setAssignments([]);
      setLoading(false);
      return;
    }

    setAssignments(assignmentData ?? []);
    setContractors(contractorData ?? []);
    setProjects(projectData ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void fetchAssignments();
  }, []);

  const filteredAssignments = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!term) {
      return assignments;
    }

    return assignments.filter((assignment) => {
      const values = [
        assignment.contractors?.company_name,
        assignment.projects?.project_number,
        assignment.projects?.project_name,
      ];

      return values.some((value) => (value ?? "").toLowerCase().includes(term));
    });
  }, [assignments, search]);

  const closeModal = () => {
    setIsModalOpen(false);
    setForm({ ...emptyForm, assigned_date: getToday() });
    setFormError(null);
  };

  const handleCreateAssignment = async (event: React.FormEvent) => {
    event.preventDefault();

    if (!form.contractor_id) {
      setFormError("Contractor is required.");
      return;
    }

    if (!form.project_id) {
      setFormError("Project is required.");
      return;
    }

    setSaving(true);
    setFormError(null);

    const { error: createError } = await createAssignment({
      contractor_id: Number(form.contractor_id),
      project_id: Number(form.project_id),
      assigned_date: form.assigned_date,
      active: form.active,
    });

    if (createError) {
      setFormError(createError.message || "Unable to create assignment.");
      setSaving(false);
      return;
    }

    await fetchAssignments();
    closeModal();
    setSaving(false);
    setSuccessMessage("Assignment added successfully.");
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Contractor Assignments</h1>
          </div>
        </div>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Assignment Directory</h2>
              <p className="mt-1 text-sm text-slate-500">Total Assignments: {assignments.length}</p>
            </div>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search assignments" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white sm:w-80" />
          </div>

          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-medium text-slate-500">Loading assignments...</div>
          ) : error ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-red-600">{error}</div>
          ) : filteredAssignments.length === 0 ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-slate-500">No assignments found.</div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="min-w-[780px] border-collapse text-left">
                <thead className="bg-slate-50"><tr>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Contractor</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Project Number</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Project Name</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Assigned Date</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Active</th>
                </tr></thead>
                <tbody>{filteredAssignments.map((assignment) => <tr key={assignment.id} className="bg-white hover:bg-slate-50/80">
                  <td className="border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800">{assignment.contractors?.company_name ?? "—"}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{assignment.projects?.project_number ?? "—"}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{assignment.projects?.project_name ?? "—"}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{assignment.assigned_date}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${assignment.active ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600"}`}>{assignment.active ? "Active" : "Inactive"}</span></td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {isModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between gap-4"><h2 className="text-xl font-semibold text-slate-900">Add Assignment</h2><button type="button" onClick={closeModal} className="text-sm font-medium text-slate-500 hover:text-slate-700">Close</button></div>
        <form onSubmit={handleCreateAssignment} className="space-y-4">
          <div><label htmlFor="contractor_id" className="mb-1 block text-sm font-medium text-slate-700">Contractor <span className="text-red-500">*</span></label><select id="contractor_id" value={form.contractor_id} onChange={(event) => setForm((current) => ({ ...current, contractor_id: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white" required><option value="">Select contractor</option>{contractors.map((contractor) => <option key={contractor.id} value={contractor.id}>{contractor.company_name}</option>)}</select></div>
          <div><label htmlFor="project_id" className="mb-1 block text-sm font-medium text-slate-700">Project <span className="text-red-500">*</span></label><select id="project_id" value={form.project_id} onChange={(event) => setForm((current) => ({ ...current, project_id: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white" required><option value="">Select project</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.project_number} - {project.project_name}</option>)}</select></div>
          <div><label htmlFor="assigned_date" className="mb-1 block text-sm font-medium text-slate-700">Assigned Date</label><input id="assigned_date" type="date" value={form.assigned_date} onChange={(event) => setForm((current) => ({ ...current, assigned_date: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white" /></div>
          <label className="flex items-center gap-3 text-sm font-medium text-slate-700"><input type="checkbox" checked={form.active} onChange={(event) => setForm((current) => ({ ...current, active: event.target.checked }))} className="h-4 w-4 rounded border-slate-300 text-indigo-600" />Active</label>
          {formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div> : null}
          <div className="flex justify-end gap-3 pt-2"><button type="button" onClick={closeModal} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70">{saving ? "Saving..." : "Save Assignment"}</button></div>
        </form>
      </div></div> : null}
    </main>
  );
}
