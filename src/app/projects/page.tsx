"use client";

import { useEffect, useMemo, useState } from "react";
import {
  createProject,
  getAssignmentsForProject,
  getProjectById,
  getProjects,
  updateProject,
} from "@/services/projects";
import type { Project, ProjectAssignment } from "@/types/database";

const statusOptions = ["Active", "Pending", "Completed", "On Hold", "Cancelled"] as const;
type ProjectStatus = (typeof statusOptions)[number];

const emptyForm = {
  project_number: "",
  project_name: "",
  status: "Active" as ProjectStatus,
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);
  const [detailAssignments, setDetailAssignments] = useState<ProjectAssignment[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [deactivateProject, setDeactivateProject] = useState<Project | null>(null);

  const fetchProjects = async () => {
    setLoading(true);
    setError(null);
    const { data, error: projectsError } = await getProjects();

    if (projectsError) {
      setError(projectsError.message || "Unable to load projects.");
      setProjects([]);
      setLoading(false);
      return;
    }

    setProjects(data ?? []);
    setLoading(false);
  };

  useEffect(() => {
    void fetchProjects();
  }, []);

  const filteredProjects = useMemo(() => {
    const term = search.trim().toLowerCase();

    if (!term) {
      return projects;
    }

    return projects.filter((project) =>
      [project.project_number, project.project_name].some((value) =>
        value.toLowerCase().includes(term)
      )
    );
  }, [projects, search]);

  const closeModal = () => {
    setIsModalOpen(false);
    setEditingProject(null);
    setForm(emptyForm);
    setFormError(null);
  };

  const openAddModal = () => {
    setEditingProject(null);
    setForm(emptyForm);
    setFormError(null);
    setSuccessMessage(null);
    setIsModalOpen(true);
  };

  const openEditModal = (project: Project) => {
    setEditingProject(project);
    setForm({
      project_number: project.project_number,
      project_name: project.project_name,
      status: project.status as ProjectStatus,
    });
    setFormError(null);
    setSuccessMessage(null);
    setIsModalOpen(true);
  };

  const openDetail = async (project: Project) => {
    setDetailProject(project);
    setDetailAssignments([]);
    setDetailError(null);
    setDetailLoading(true);
    const [{ data: refreshedProject, error: projectError }, { data: assignments, error: assignmentsError }] = await Promise.all([
      getProjectById(project.id),
      getAssignmentsForProject(project.id),
    ]);
    if (projectError || assignmentsError) {
      setDetailError(projectError?.message || assignmentsError?.message || "Unable to load project details.");
    } else {
      setDetailProject(refreshedProject ?? project);
      setDetailAssignments(assignments ?? []);
    }
    setDetailLoading(false);
  };

  const handleCreateProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const projectNumber = form.project_number.trim();
    const projectName = form.project_name.trim();

    if (!projectNumber) {
      setFormError("Project Number is required.");
      return;
    }

    if (!projectName) {
      setFormError("Project Name is required.");
      return;
    }

    setSaving(true);
    setFormError(null);
    const projectBeingEdited = editingProject;
    const result = projectBeingEdited
      ? await updateProject(projectBeingEdited.id, {
          project_number: projectNumber,
          project_name: projectName,
          status: form.status,
        })
      : await createProject({
          project_number: projectNumber,
          project_name: projectName,
          status: form.status,
        });

    if (result.error) {
      setFormError(result.error.message || "Unable to save project.");
      setSaving(false);
      return;
    }

    await fetchProjects();
    closeModal();
    setSaving(false);
    if (detailProject && projectBeingEdited?.id === detailProject.id) {
      await openDetail({ ...detailProject, project_number: projectNumber, project_name: projectName, status: form.status });
    }
    setSuccessMessage(projectBeingEdited ? "Project updated successfully." : "Project added successfully.");
  };

  const handleDeactivate = async () => {
    if (!deactivateProject) return;
    setSaving(true);
    const { error: deactivateError } = await updateProject(deactivateProject.id, { status: "Cancelled" });
    if (deactivateError) {
      setError(deactivateError.message || "Unable to deactivate project.");
      setSaving(false);
      return;
    }
    await fetchProjects();
    if (detailProject?.id === deactivateProject.id) await openDetail({ ...deactivateProject, status: "Cancelled" });
    setDeactivateProject(null);
    setSaving(false);
    setSuccessMessage("Project deactivated successfully.");
  };

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-8 text-slate-800">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Operations</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Project Management</h1>
          </div>
          <button type="button" onClick={openAddModal} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800">
            Add Project
          </button>
        </div>

        <section className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          <div className="flex flex-col gap-4 border-b border-slate-200 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-900">Project Directory</h2>
              <p className="mt-1 text-sm text-slate-500">Total Projects: {projects.length}</p>
            </div>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white sm:w-72" />
          </div>

          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-medium text-slate-500">Loading projects...</div>
          ) : error ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-red-600">{error}</div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-slate-500">No projects found.</div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="min-w-[640px] border-collapse text-left">
                <thead className="bg-slate-50"><tr>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Project Number</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Project Name</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Status</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Actions</th>
                </tr></thead>
                <tbody>{filteredProjects.map((project) => <tr key={project.id} className="bg-white hover:bg-slate-50/80">
                  <td className="border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800">{project.project_number}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{project.project_name}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{project.status}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm"><div className="flex items-center gap-3"><button type="button" onClick={() => void openDetail(project)} className="font-medium text-indigo-600 hover:text-indigo-800">View</button><button type="button" onClick={() => openEditModal(project)} className="font-medium text-slate-600 hover:text-slate-900">Edit</button>{project.status !== "Cancelled" ? <button type="button" onClick={() => setDeactivateProject(project)} className="font-medium text-red-600 hover:text-red-800">Deactivate</button> : null}</div></td>
                </tr>)}</tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {isModalOpen ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-xl rounded-2xl bg-white p-6 shadow-xl">
        <div className="mb-5 flex items-center justify-between gap-4"><h2 className="text-xl font-semibold text-slate-900">{editingProject ? "Edit Project" : "Add Project"}</h2><button type="button" onClick={closeModal} className="text-sm font-medium text-slate-500 hover:text-slate-700">Close</button></div>
        <form onSubmit={handleCreateProject} className="space-y-4">
          <div><label htmlFor="project_number" className="mb-1 block text-sm font-medium text-slate-700">Project Number <span className="text-red-500">*</span></label><input id="project_number" type="text" value={form.project_number} onChange={(event) => setForm((current) => ({ ...current, project_number: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white" required /></div>
          <div><label htmlFor="project_name" className="mb-1 block text-sm font-medium text-slate-700">Project Name <span className="text-red-500">*</span></label><input id="project_name" type="text" value={form.project_name} onChange={(event) => setForm((current) => ({ ...current, project_name: event.target.value }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white" required /></div>
          <div><label htmlFor="status" className="mb-1 block text-sm font-medium text-slate-700">Status</label><select id="status" value={form.status} onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as ProjectStatus }))} className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white">{statusOptions.map((status) => <option key={status} value={status}>{status}</option>)}</select></div>
          {formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div> : null}
          <div className="flex justify-end gap-3 pt-2"><button type="button" onClick={closeModal} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70">{saving ? "Saving..." : editingProject ? "Save Changes" : "Save Project"}</button></div>
        </form>
      </div></div> : null}

      {detailProject ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-semibold text-slate-900">Project Details</h2><button type="button" onClick={() => setDetailProject(null)} className="text-sm text-slate-500">Close</button></div>{detailLoading ? <p className="text-sm text-slate-500">Loading project details...</p> : detailError ? <p className="text-sm text-red-600">{detailError}</p> : <div className="space-y-6"><div className="grid grid-cols-1 gap-4 sm:grid-cols-2"><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Project Number</p><p className="mt-1 text-sm">{detailProject.project_number}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Project Name</p><p className="mt-1 text-sm">{detailProject.project_name}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</p><p className="mt-1 text-sm">{detailProject.status}</p></div><div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Created Date</p><p className="mt-1 text-sm">{new Date(detailProject.created_at).toLocaleDateString()}</p></div></div><div><h3 className="mb-3 text-lg font-semibold text-slate-900">Assigned Contractors</h3>{detailAssignments.length === 0 ? <p className="text-sm text-slate-500">No assigned contractors.</p> : <div className="overflow-x-auto"><table className="min-w-[520px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Contractor Name</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Trade</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Contractor Status</th></tr></thead><tbody>{detailAssignments.map((assignment, index) => <tr key={`${assignment.contractors?.company_name}-${index}`}><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.contractors?.company_name || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.contractors?.trade || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.contractors?.active ? "Active" : "Inactive"}</td></tr>)}</tbody></table></div>}</div></div>}</div></div> : null}

      {deactivateProject ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold text-slate-900">Deactivate Project?</h2><p className="mt-3 text-sm text-slate-600">Are you sure you want to deactivate this project?</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setDeactivateProject(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="button" onClick={() => void handleDeactivate()} disabled={saving} className="rounded-xl bg-red-600 px-4 py-2.5 text-sm text-white">{saving ? "Deactivating..." : "Deactivate"}</button></div></div></div> : null}
    </main>
  );
}
