"use client";

import { useEffect, useMemo, useState } from "react";
import { getActivityForProject, logProjectEvent, logProjectStatusChange } from "@/services/activity";
import { supabase } from "@/lib/supabase";
import { getAssignments } from "@/services/assignments";
import { getComplianceHistoryForContractors } from "@/services/compliance";
import {
  createProject,
  getAssignmentHistoryForProject,
  getDocumentsForProject,
  getProjectById,
  getProjects,
  updateProject,
  type ProjectAssignmentHistoryEntry,
  type ProjectDocument,
} from "@/services/projects";
import type { ActivityLog, ComplianceHistoryRecord, ComplianceStatus, Project } from "@/types/database";

const statusOptions = ["Active", "Inactive", "Pending", "Completed", "On Hold", "Cancelled"] as const;
type ProjectStatus = (typeof statusOptions)[number];

const statusBadgeStyles: Record<string, string> = {
  Active: "bg-emerald-100 text-emerald-700",
  Inactive: "bg-slate-200 text-slate-600",
  Pending: "bg-sky-100 text-sky-700",
  "On Hold": "bg-amber-100 text-amber-700",
  Completed: "bg-indigo-100 text-indigo-700",
  Cancelled: "bg-red-100 text-red-700",
};

const complianceStatusStyles: Record<ComplianceStatus, string> = {
  Active: "bg-emerald-100 text-emerald-700",
  "90 Day": "bg-amber-100 text-amber-700",
  "60 Day": "bg-orange-100 text-orange-700",
  "30 Day": "bg-red-100 text-red-700",
  Expired: "bg-[#7f1d1d] text-white",
  "Missing Information": "bg-sky-100 text-sky-700",
};

const emptyForm = {
  project_number: "",
  project_name: "",
  status: "Active" as ProjectStatus,
};

function statusBadge(status: string) {
  return statusBadgeStyles[status] ?? "bg-slate-200 text-slate-600";
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function parseStatusChangeNotes(notes: string | null) {
  const match = notes?.match(/^(.*) \| Previous: (.*) \| New: (.*) \| Changed by: (.*)$/) ?? null;
  if (!match) return null;
  return { projectName: match[1], previousStatus: match[2], newStatus: match[3], changedBy: match[4] };
}

type TimelineEvent = {
  sortKey: string;
  date: string;
  time: string | null;
  type: string;
  description: string;
  changedBy: string | null;
};

export default function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [contractorCounts, setContractorCounts] = useState<Map<number, number>>(new Map());
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"active" | "inactive">("active");
  const [sortColumn, setSortColumn] = useState<"project_number" | "project_name">("project_number");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [detailProject, setDetailProject] = useState<Project | null>(null);
  const [detailAssignments, setDetailAssignments] = useState<ProjectAssignmentHistoryEntry[]>([]);
  const [detailDocuments, setDetailDocuments] = useState<ProjectDocument[]>([]);
  const [detailCompliance, setDetailCompliance] = useState<ComplianceHistoryRecord[]>([]);
  const [detailActivity, setDetailActivity] = useState<ActivityLog[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [statusChange, setStatusChange] = useState<{ project: Project; action: "deactivate" | "reactivate" } | null>(null);

  const fetchProjects = async () => {
    setLoading(true);
    setError(null);
    const [{ data: projectData, error: projectsError }, { data: assignmentData, error: assignmentsError }] = await Promise.all([
      getProjects(),
      getAssignments(),
    ]);

    const loadError = projectsError || assignmentsError;
    if (loadError) {
      setError(loadError.message || "Unable to load projects.");
      setProjects([]);
      setContractorCounts(new Map());
      setLoading(false);
      return;
    }

    const counts = new Map<number, number>();
    (assignmentData ?? []).forEach((assignment) => {
      counts.set(assignment.project_id, (counts.get(assignment.project_id) ?? 0) + 1);
    });

    setProjects(projectData ?? []);
    setContractorCounts(counts);
    setLoading(false);
  };

  useEffect(() => {
    void fetchProjects();
  }, []);

  const activeProjects = useMemo(() => projects.filter((project) => project.status === "Active"), [projects]);
  const inactiveProjects = useMemo(() => projects.filter((project) => project.status !== "Active"), [projects]);

  const filteredProjects = useMemo(() => {
    const term = search.trim().toLowerCase();
    const tabProjects = activeTab === "active" ? activeProjects : inactiveProjects;

    const matchingProjects = tabProjects.filter((project) =>
      [project.project_number, project.project_name].some((value) => value.toLowerCase().includes(term))
    );

    return [...matchingProjects].sort((left, right) => {
      const comparison = left[sortColumn].localeCompare(right[sortColumn], undefined, { sensitivity: "base" });
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [activeTab, activeProjects, inactiveProjects, search, sortColumn, sortDirection]);

  const detailContractorNames = useMemo(
    () => new Map(detailAssignments.map((assignment) => [assignment.contractor_id, assignment.contractors?.company_name ?? "—"])),
    [detailAssignments]
  );

  const detailStatusChanges = useMemo(() => detailActivity.filter((item) => item.activity_type === "Status Change"), [detailActivity]);

  const detailTimeline = useMemo<TimelineEvent[]>(() => {
    if (!detailProject) return [];
    const events: TimelineEvent[] = [];

    events.push({
      sortKey: detailProject.created_at,
      date: detailProject.created_at.slice(0, 10),
      time: formatDateTime(detailProject.created_at).split(", ")[1] ?? null,
      type: "Project Created",
      description: `${detailProject.project_name} created with status ${detailProject.status}.`,
      changedBy: null,
    });

    const loggedEvents = new Set<string>();
    detailActivity.forEach((item) => {
      const createdTime = formatDateTime(item.created_at).split(", ")[1] ?? null;
      if (item.activity_type === "Status Change") {
        const parsed = parseStatusChangeNotes(item.notes);
        if (parsed) {
          events.push({
            sortKey: item.created_at,
            date: item.activity_date,
            time: createdTime,
            type: parsed.newStatus === "Active" ? "Project Activated" : parsed.newStatus === "Completed" ? "Project Completed" : parsed.newStatus === "Cancelled" ? "Project Cancelled" : parsed.newStatus === "Inactive" ? "Project Deactivated" : "Status Change",
            description: `${parsed.previousStatus} → ${parsed.newStatus}`,
            changedBy: parsed.changedBy,
          });
          return;
        }
      }
      if (item.activity_type === "Contractor Assignment") loggedEvents.add(`assign:${item.notes}:${item.activity_date}`);
      if (item.activity_type === "Contractor Removal") loggedEvents.add(`remove:${item.notes}:${item.activity_date}`);
      events.push({
        sortKey: item.created_at,
        date: item.activity_date,
        time: createdTime,
        type: item.activity_type,
        description: item.notes || "—",
        changedBy: item.created_by,
      });
    });

    detailAssignments.forEach((assignment) => {
      const companyName = assignment.contractors?.company_name ?? "Unknown contractor";
      if (!loggedEvents.has(`assign:${companyName} assigned to project.:${assignment.assigned_date}`)) {
        events.push({
          sortKey: `${assignment.assigned_date}T00:00:00`,
          date: assignment.assigned_date,
          time: null,
          type: "Contractor Assignment",
          description: `${companyName} assigned to project.`,
          changedBy: null,
        });
      }
      if (assignment.removed_date && !loggedEvents.has(`remove:${companyName} removed from project.:${assignment.removed_date}`)) {
        events.push({
          sortKey: `${assignment.removed_date}T23:59:59`,
          date: assignment.removed_date,
          time: null,
          type: "Contractor Removal",
          description: `${companyName} removed from project.`,
          changedBy: null,
        });
      }
    });

    return events.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
  }, [detailActivity, detailAssignments, detailProject]);

  const handleSort = (column: "project_number" | "project_name") => {
    if (sortColumn === column) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"));
      return;
    }

    setSortColumn(column);
    setSortDirection("asc");
  };

  const sortIndicator = (column: "project_number" | "project_name") => {
    if (sortColumn !== column) {
      return "↕";
    }

    return sortDirection === "asc" ? "↑" : "↓";
  };

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
    setDetailDocuments([]);
    setDetailCompliance([]);
    setDetailActivity([]);
    setDetailError(null);
    setDetailLoading(true);

    const [
      { data: refreshedProject, error: projectError },
      { data: assignmentHistory, error: assignmentsError },
      { data: activityData, error: activityError },
    ] = await Promise.all([
      getProjectById(project.id),
      getAssignmentHistoryForProject(project.id),
      getActivityForProject(project.id),
    ]);

    const contractorIds = [...new Set((assignmentHistory ?? []).map((assignment) => assignment.contractor_id))];
    const [
      { data: documents, error: documentsError },
      { data: complianceHistory, error: complianceError },
    ] = await Promise.all([
      getDocumentsForProject(contractorIds),
      getComplianceHistoryForContractors(contractorIds),
    ]);

    const loadError = projectError || assignmentsError || activityError || documentsError || complianceError;
    if (loadError) {
      setDetailError(loadError.message || "Unable to load project details.");
    } else {
      setDetailProject(refreshedProject ?? project);
      setDetailAssignments(assignmentHistory ?? []);
      setDetailDocuments(documents ?? []);
      setDetailCompliance(complianceHistory ?? []);
      setDetailActivity(activityData ?? []);
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
          inactivated_by: null,
          inactivated_at: null,
          reactivated_by: null,
          reactivated_at: null,
        });

    if (result.error) {
      setFormError(result.error.message || "Unable to save project.");
      setSaving(false);
      return;
    }

    if (projectBeingEdited && projectBeingEdited.status !== form.status) {
      await logProjectStatusChange(projectBeingEdited.id, projectName, projectBeingEdited.status, form.status);
    }

    const newProjectId = !projectBeingEdited ? result.data?.[0]?.id : null;
    if (newProjectId) {
      await logProjectEvent(newProjectId, "Project Created", `${projectName} created with status ${form.status}.`);
    }

    await fetchProjects();
    closeModal();
    setSaving(false);
    if (detailProject && projectBeingEdited?.id === detailProject.id) {
      await openDetail({ ...detailProject, project_number: projectNumber, project_name: projectName, status: form.status });
    }
    setSuccessMessage(projectBeingEdited ? "Project updated successfully." : "Project added successfully.");
  };

  const handleStatusChange = async () => {
    if (!statusChange) return;
    const { project, action } = statusChange;
    const newStatus = action === "deactivate" ? "Inactive" : "Active";

    setSaving(true);
    const { error: statusError } = await updateProject(project.id, { status: newStatus });
    if (statusError) {
      setError(statusError.message || "Unable to update project status.");
      setSaving(false);
      return;
    }

    const { data: userData } = await supabase.auth.getUser();
    const changedBy = userData.user?.email ?? "Unknown user";
    const timestamp = new Date().toISOString();
    const statusMetadata = action === "deactivate"
      ? { inactivated_by: changedBy, inactivated_at: timestamp }
      : { reactivated_by: changedBy, reactivated_at: timestamp };
    const { error: metadataError } = await supabase.from("projects").update(statusMetadata).eq("id", project.id);
    if (metadataError) {
      setError(metadataError.message || "Unable to save project status metadata.");
      setSaving(false);
      return;
    }

    await logProjectStatusChange(project.id, project.project_name, project.status, newStatus);
    await fetchProjects();
    if (detailProject?.id === project.id) await openDetail({ ...project, status: newStatus });
    setStatusChange(null);
    setSaving(false);
    setActiveTab(action === "deactivate" ? "inactive" : "active");
    setSuccessMessage(
      action === "deactivate"
        ? "Project deactivated successfully. All history and records preserved."
        : "Project reactivated successfully. All history and records preserved."
    );
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
              <div className="mt-2 inline-flex rounded-xl border border-slate-200 bg-slate-50 p-1">
                {(["active", "inactive"] as const).map((tab) => {
                  const isSelected = activeTab === tab;
                  const count = tab === "active" ? activeProjects.length : inactiveProjects.length;
                  return (
                    <button key={tab} type="button" onClick={() => setActiveTab(tab)} className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${isSelected ? "bg-slate-900 text-white" : "text-slate-600 hover:text-slate-900"}`}>
                      {tab === "active" ? "Active Projects" : "Inactive Projects"} ({count})
                    </button>
                  );
                })}
              </div>
            </div>
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search projects" className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white sm:w-72" />
          </div>

          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {loading ? (
            <div className="flex min-h-[220px] items-center justify-center text-sm font-medium text-slate-500">Loading projects...</div>
          ) : error ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-red-600">{error}</div>
          ) : filteredProjects.length === 0 ? (
            <div className="flex min-h-[220px] items-center justify-center px-6 text-sm font-medium text-slate-500">
              {activeTab === "active" ? "No active projects found." : "No inactive projects found."}
            </div>
          ) : (
            <div className="w-full overflow-x-auto">
              <table className="min-w-[760px] border-collapse text-left">
                <thead className="bg-slate-50"><tr>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                    <button type="button" onClick={() => handleSort("project_number")} className="inline-flex items-center gap-2 hover:text-slate-900">
                      Project Number <span aria-hidden="true">{sortIndicator("project_number")}</span>
                    </button>
                  </th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">
                    <button type="button" onClick={() => handleSort("project_name")} className="inline-flex items-center gap-2 hover:text-slate-900">
                      Project Name <span aria-hidden="true">{sortIndicator("project_name")}</span>
                    </button>
                  </th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Contractors</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Status</th>
                  <th className="border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700">Actions</th>
                </tr></thead>
                <tbody>{filteredProjects.map((project) => <tr key={project.id} className="bg-white hover:bg-slate-50/80">
                  <td className="border border-slate-200 px-4 py-3 text-sm font-medium text-slate-800">{project.project_number}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{project.project_name}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm text-slate-600">{contractorCounts.get(project.id) ?? 0}</td>
                  <td className="border border-slate-200 px-4 py-3 text-sm">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(project.status)}`}>{project.status}</span>
                  </td>
                  <td className="border border-slate-200 px-4 py-3 text-sm"><div className="flex items-center gap-3"><button type="button" onClick={() => void openDetail(project)} className="font-medium text-indigo-600 hover:text-indigo-800">View</button><button type="button" onClick={() => openEditModal(project)} className="font-medium text-slate-600 hover:text-slate-900">Edit</button>{project.status === "Active" ? <button type="button" onClick={() => setStatusChange({ project, action: "deactivate" })} className="font-medium text-red-600 hover:text-red-800">Deactivate</button> : <button type="button" onClick={() => setStatusChange({ project, action: "reactivate" })} className="font-medium text-emerald-600 hover:text-emerald-800">Reactivate</button>}</div></td>
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

      {detailProject ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white p-6 shadow-xl"><div className="mb-5 flex items-center justify-between"><h2 className="text-xl font-semibold text-slate-900">Project Details</h2><button type="button" onClick={() => setDetailProject(null)} className="text-sm text-slate-500">Close</button></div>{detailLoading ? <p className="text-sm text-slate-500">Loading project details...</p> : detailError ? <p className="text-sm text-red-600">{detailError}</p> : <div className="space-y-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Project Number</p><p className="mt-1 text-sm">{detailProject.project_number}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Project Name</p><p className="mt-1 text-sm">{detailProject.project_name}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</p><p className="mt-1 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(detailProject.status)}`}>{detailProject.status}</span></p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Created Date</p><p className="mt-1 text-sm">{new Date(detailProject.created_at).toLocaleDateString()}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Inactive By</p><p className="mt-1 text-sm">{detailProject.inactivated_by || "—"}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Inactive Date</p><p className="mt-1 text-sm">{formatDateTime(detailProject.inactivated_at)}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reactivated By</p><p className="mt-1 text-sm">{detailProject.reactivated_by || "—"}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reactivated Date</p><p className="mt-1 text-sm">{formatDateTime(detailProject.reactivated_at)}</p></div>
        </div>

        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Contractor History</h3>
          {detailAssignments.length === 0 ? <p className="text-sm text-slate-500">No contractor history found.</p> : <div className="overflow-x-auto"><table className="min-w-[640px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Contractor Name</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Trade</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Assigned Date</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Removed Date</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Assignment Status</th></tr></thead><tbody>{detailAssignments.map((assignment) => <tr key={assignment.id}><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.contractors?.company_name || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.contractors?.trade || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.assigned_date}</td><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.removed_date || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{assignment.active ? "Active" : "Removed"}</td></tr>)}</tbody></table></div>}
        </div>

        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Document History</h3>
          {detailDocuments.length === 0 ? <p className="text-sm text-slate-500">No documents found.</p> : <div className="overflow-x-auto"><table className="min-w-[640px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Document Name</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Type</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Contractor</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Upload Date</th></tr></thead><tbody>{detailDocuments.map((document) => <tr key={document.id}><td className="border border-slate-200 px-3 py-2 text-sm">{document.document_name}</td><td className="border border-slate-200 px-3 py-2 text-sm">{document.document_type}</td><td className="border border-slate-200 px-3 py-2 text-sm">{document.contractors?.company_name || detailContractorNames.get(document.contractor_id) || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{document.upload_date}</td></tr>)}</tbody></table></div>}
        </div>

        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Compliance History</h3>
          {detailCompliance.length === 0 ? <p className="text-sm text-slate-500">No compliance history found.</p> : <div className="overflow-x-auto"><table className="min-w-[640px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Compliance Type</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Contractor</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Expiration Date</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Current Status</th></tr></thead><tbody>{detailCompliance.map((record) => <tr key={record.id}><td className="border border-slate-200 px-3 py-2 text-sm font-medium">{record.compliance_name}</td><td className="border border-slate-200 px-3 py-2 text-sm">{detailContractorNames.get(record.contractor_id) || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{record.expiration_date || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${complianceStatusStyles[record.calculated_status]}`}>{record.calculated_status}</span></td></tr>)}</tbody></table></div>}
        </div>

        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Status Change History</h3>
          {detailStatusChanges.length === 0 ? <p className="text-sm text-slate-500">No status changes recorded.</p> : <div className="overflow-x-auto"><table className="min-w-[760px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Previous Status", "New Status", "Changed By", "Changed Date/Time"].map((heading) => <th key={heading} className="border border-slate-200 px-3 py-2 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{detailStatusChanges.map((item) => { const parsed = parseStatusChangeNotes(item.notes); return <tr key={item.id}><td className="border border-slate-200 px-3 py-2 text-sm">{parsed?.previousStatus ?? "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{parsed ? <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(parsed.newStatus)}`}>{parsed.newStatus}</span> : "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{parsed?.changedBy ?? item.created_by ?? "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{formatDateTime(item.created_at)}</td></tr>; })}</tbody></table></div>}
        </div>

        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Status Timeline</h3>
          {detailTimeline.length === 0 ? <p className="text-sm text-slate-500">No history recorded.</p> : <ol className="relative ml-3 border-l border-slate-200">{detailTimeline.map((event, index) => <li key={`${event.sortKey}-${index}`} className="mb-5 ml-4 last:mb-0"><span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-slate-400"></span><div className="flex flex-wrap items-baseline gap-x-3"><span className="text-xs font-medium text-slate-500">{event.date}{event.time ? ` ${event.time}` : ""}</span><span className="text-sm font-semibold text-slate-800">{event.type}</span>{event.changedBy ? <span className="text-xs text-slate-500">by {event.changedBy}</span> : null}</div><p className="mt-0.5 text-sm text-slate-600">{event.description}</p></li>)}</ol>}
        </div>
      </div>}</div></div> : null}

      {statusChange ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold text-slate-900">{statusChange.action === "deactivate" ? "Deactivate Project?" : "Reactivate Project?"}</h2><p className="mt-3 text-sm text-slate-600">{statusChange.action === "deactivate" ? `This will mark ${statusChange.project.project_name} inactive without deleting the record. All contractor assignments, compliance records, documents, and history will be preserved.` : `This will mark ${statusChange.project.project_name} active again. All historical records remain intact.`}</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setStatusChange(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="button" onClick={() => void handleStatusChange()} disabled={saving} className={`rounded-xl px-4 py-2.5 text-sm text-white ${statusChange.action === "deactivate" ? "bg-red-600" : "bg-emerald-600"}`}>{saving ? "Saving..." : statusChange.action === "deactivate" ? "Deactivate" : "Reactivate"}</button></div></div></div> : null}
    </main>
  );
}
