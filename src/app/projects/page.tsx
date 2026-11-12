"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getActivityForProject, logProjectEvent, logProjectStatusChange } from "@/services/activity";
import { supabase } from "@/lib/supabase";
import { getAssignments } from "@/services/assignments";
import { getComplianceHistoryForContractors } from "@/services/compliance";
import { projectComplianceSections } from "@/services/project-compliance";
import ProjectDetailActions from "@/components/projects/ProjectDetailActions";
import ProjectLifecyclePanel from "@/components/projects/ProjectLifecyclePanel";
import Style3Icon from "@/components/style3/Style3Icon";
import Style3Actions from "@/components/style3/Style3Actions";
import shared from "@/components/style3/style3.module.css";
import styles from "./projects.module.css";
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

const statusOptions = ["Active", "Pending", "On Hold"] as const;
type ProjectStatus = (typeof statusOptions)[number] | "Completed" | "Cancelled";
const projectTabs = [
  { key: "current", label: "Current Projects", statuses: ["Active", "Pending", "On Hold"] },
  { key: "completed", label: "Completed Projects", statuses: ["Completed"] },
  { key: "cancelled", label: "Cancelled Projects", statuses: ["Cancelled"] },
] as const;

const statusBadgeStyles: Record<string, string> = {
  Active: "bg-emerald-100 text-emerald-700",
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
  public_works: "" as "" | "yes" | "no",
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
  return <Suspense fallback={<main className="p-8 text-sm text-slate-500">Loading projects...</main>}><ProjectsContent /></Suspense>;
}

function ProjectsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedProjectId = searchParams.get("projectId");
  const handledProjectId = useRef<string | null>(null);
  const detailRequest = useRef(0);
  const [deepLinkError, setDeepLinkError] = useState<string | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contractorCounts, setContractorCounts] = useState<Map<number, number>>(new Map());
  const [search, setSearch] = useState("");
  const [activeTab, setActiveTab] = useState<"current" | "completed" | "cancelled">("current");
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
  const [statusChange, setStatusChange] = useState<{ project: Project; action: "reactivate" } | null>(null);
  const [requestedLifecycleAction, setRequestedLifecycleAction] = useState<"complete" | "cancel" | undefined>();

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

  const filteredProjects = useMemo(() => {
    const term = search.trim().toLowerCase();
    const statuses: readonly string[] = projectTabs.find(tab => tab.key === activeTab)!.statuses;
    const tabProjects = projects.filter(project => statuses.includes(project.status));

    const matchingProjects = tabProjects.filter((project) =>
      [project.project_number, project.project_name].some((value) => value.toLowerCase().includes(term))
    );

    return [...matchingProjects].sort((left, right) => {
      const comparison = left[sortColumn].localeCompare(right[sortColumn], undefined, { sensitivity: "base" });
      return sortDirection === "asc" ? comparison : -comparison;
    });
  }, [activeTab, projects, search, sortColumn, sortDirection]);

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
            type: parsed.newStatus === "Active" ? "Project Activated" : parsed.newStatus === "Completed" ? "Project Completed" : parsed.newStatus === "Cancelled" ? "Project Cancelled" : "Status Change",
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
      public_works: project.public_works == null ? "" : project.public_works ? "yes" : "no",
    });
    setFormError(null);
    setSuccessMessage(null);
    setIsModalOpen(true);
  };

  const openDetail = useCallback(async (project: Project) => {
    const request = ++detailRequest.current;
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
    if (request !== detailRequest.current) return;

    const contractorIds = [...new Set((assignmentHistory ?? []).map((assignment) => assignment.contractor_id))];
    const [
      { data: documents, error: documentsError },
      { data: complianceHistory, error: complianceError },
    ] = await Promise.all([
      getDocumentsForProject(contractorIds),
      getComplianceHistoryForContractors(contractorIds),
    ]);
    if (request !== detailRequest.current) return;

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
  }, []);

  useEffect(() => {
    if (loading || error) return;
    if (requestedProjectId === handledProjectId.current) return;
    handledProjectId.current = requestedProjectId;
    const openRequestedProject = async () => {
      setDeepLinkError(null);
      if (requestedProjectId === null) {
        detailRequest.current += 1;
        setDetailProject(null);
        return;
      }
      const projectId = Number(requestedProjectId);
      if (!/^\d+$/.test(requestedProjectId) || !Number.isSafeInteger(projectId) || projectId <= 0) {
        detailRequest.current += 1;
        setDetailProject(null);
        setDeepLinkError("Invalid project detail link.");
        return;
      }
      const project = projects.find((item) => item.id === projectId);
      if (!project) {
        detailRequest.current += 1;
        setDetailProject(null);
        setDeepLinkError("Project not found or you do not have access to it.");
        return;
      }
      await openDetail(project);
    };
    void openRequestedProject();
  }, [requestedProjectId, projects, loading, error, openDetail]);

  const closeDetail = () => {
    detailRequest.current += 1;
    setDetailProject(null);
    if (requestedProjectId !== null) {
      const params = new URLSearchParams(searchParams.toString());
      params.delete("projectId");
      const query = params.toString();
      router.replace(query ? `/projects?${query}` : "/projects", { scroll: false });
    }
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

    if (!form.public_works) {
      setFormError("Select whether this is a Public Works project.");
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
          public_works: form.public_works === "yes",
        })
      : await createProject({
          project_number: projectNumber,
          project_name: projectName,
          status: form.status,
          public_works: form.public_works === "yes",
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
      await openDetail({ ...detailProject, project_number: projectNumber, project_name: projectName, status: form.status, public_works: form.public_works === "yes" });
    }
    setSuccessMessage(projectBeingEdited ? "Project updated successfully." : "Project added successfully.");
  };

  const handleStatusChange = async () => {
    if (!statusChange) return;
    const { project } = statusChange;
    const newStatus = "Active";

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
    const statusMetadata = { reactivated_by: changedBy, reactivated_at: timestamp };
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
    setActiveTab("current");
    setSuccessMessage("Project reactivated successfully. All history and records preserved.");
  };

  return (
    <main className={styles.projects}>
      <div className={styles.content}>
        <div className={styles.heading}>
          <div>
            <p className={shared.eyebrow}>Operations</p>
            <h1>Project Management</h1>
          </div>
          <button type="button" onClick={openAddModal} className={styles.primary}>
            <span aria-hidden="true">+</span> Add Project
          </button>
        </div>

        <section className={styles.panel}>
          <div className={styles.directoryHeading}>
            <div className={styles.directoryTitle}><Style3Icon name="Projects" /><h2>Project Directory</h2></div>
            <span className={shared.count}>{filteredProjects.length} projects</span>
          </div>
          <div className={styles.directoryControls}>
              <div className={styles.tabs}>
                {projectTabs.map(tab => {
                  const isSelected = activeTab === tab.key;
                  const statuses: readonly string[] = tab.statuses;
                  const count = projects.filter(project => statuses.includes(project.status)).length;
                  return (
                    <button key={tab.key} type="button" aria-pressed={isSelected} onClick={() => setActiveTab(tab.key)}>
                      {tab.label} <span className={shared.tabCount}>{count}</span>
                    </button>
                  );
                })}
              </div>
            <label className={styles.searchControl}>Search projects<span className={styles.searchField}><Style3Icon name="Search" /><input type="search" aria-label="Search projects" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Project number or name" className={styles.search} /></span></label>
          </div>

          {successMessage ? <div className="border-b border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-medium text-emerald-700">{successMessage}</div> : null}
          {deepLinkError ? <div role="alert" className="border-b border-red-200 bg-red-50 px-5 py-3 text-sm text-red-700">{deepLinkError}</div> : null}
          {loading ? (
            <div className={styles.empty} role="status">Loading projects...</div>
          ) : error ? (
            <div className={styles.empty} role="alert"><p className={shared.error}>{error}</p></div>
          ) : filteredProjects.length === 0 ? (
            <div className={styles.empty}>
              <Style3Icon name="Projects" />
              <strong>No {activeTab} projects found.</strong>
              <p>{search ? "Try another project number or name." : "Projects in this lifecycle view will appear here."}</p>
            </div>
          ) : (
            <div className={styles.tableScroll}>
              <table className={styles.directoryTable} aria-label="Project directory">
                <thead><tr>
                  <th scope="col">
                    <button type="button" onClick={() => handleSort("project_number")}>
                      Project Number <span aria-hidden="true">{sortIndicator("project_number")}</span>
                    </button>
                  </th>
                  <th scope="col">
                    <button type="button" onClick={() => handleSort("project_name")}>
                      Project Name <span aria-hidden="true">{sortIndicator("project_name")}</span>
                    </button>
                  </th>
                  <th scope="col">Contractors</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr></thead>
                <tbody>{filteredProjects.map((project) => <tr key={project.id}>
                  <td>{project.project_number}</td>
                  <td><div className={styles.projectName}><span>{project.project_name}</span><span className={`${styles.workType} ${project.public_works == null ? shared.yellow : project.public_works ? shared.blue : shared.neutral}`}>{project.public_works == null ? "Public Works: Unclassified" : project.public_works ? "Public Works" : "Non-Public Works"}</span></div></td>
                  <td>{contractorCounts.get(project.id) ?? 0}</td>
                  <td>
                    <span className={`${styles.statusBadge} ${project.status === "Active" ? shared.good : project.status === "Pending" || project.status === "Completed" ? shared.blue : project.status === "On Hold" ? shared.yellow : shared.red}`}>{project.status}</span>
                  </td>
                  <td><div className={styles.rowActions}>
                    <Style3Actions label={`Actions for ${project.project_number}`} className={styles.rowButton}>
                        <button type="button" onClick={() => { setRequestedLifecycleAction(undefined); void openDetail(project); }}>View Project</button>
                        <button type="button" onClick={() => openEditModal(project)}>Edit Project</button>
                        {["Active", "Pending", "On Hold"].includes(project.status) ? <div role="separator" className={shared.actionDivider} /> : null}
                        {project.status === "Active" ? <button type="button" className={shared.danger} onClick={() => { setRequestedLifecycleAction("complete"); void openDetail(project); }}>Complete Project</button> : ["Pending", "On Hold"].includes(project.status) ? <button type="button" onClick={() => setStatusChange({ project, action: "reactivate" })}>Reactivate</button> : null}
                        {["Active", "Pending", "On Hold"].includes(project.status) ? <button type="button" className={shared.danger} onClick={() => { setRequestedLifecycleAction("cancel"); void openDetail(project); }}>Cancel Project</button> : null}
                    </Style3Actions>
                  </div></td>
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
          <div><label htmlFor="status" className="mb-1 block text-sm font-medium text-slate-700">Status</label>
            <select id="status" value={form.status} disabled={editingProject?.status === "Completed" || editingProject?.status === "Cancelled"}
              onChange={(event) => setForm((current) => ({ ...current, status: event.target.value as ProjectStatus }))}
              className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-indigo-300 focus:bg-white">
              {editingProject?.status === "Completed" || editingProject?.status === "Cancelled" ? <option value={editingProject.status}>{editingProject.status}</option> :
                statusOptions.map(status => <option key={status} value={status}>{status}</option>)}
            </select>
            {editingProject?.status === "Active" ? <p className="mt-1 text-xs text-slate-500">Use Complete Project to end active assignments and preserve history.</p> : null}
          </div>
          <fieldset><legend className="mb-1 text-sm font-medium text-slate-700">Public Works <span className="text-red-500">*</span></legend><div className="flex gap-4">{(["yes", "no"] as const).map((value) => <label key={value} className="flex items-center gap-2 text-sm text-slate-700"><input type="radio" name="public_works" value={value} checked={form.public_works === value} onChange={() => setForm((current) => ({ ...current, public_works: value }))} />{value === "yes" ? "Yes" : "No"}</label>)}</div></fieldset>
          {formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</div> : null}
          <div className="flex justify-end gap-3 pt-2"><button type="button" onClick={closeModal} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50">Cancel</button><button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-70">{saving ? "Saving..." : editingProject ? "Save Changes" : "Save Project"}</button></div>
        </form>
      </div></div> : null}

      {detailProject ? <div className={styles.detailOverlay}><div className={styles.detailWorkspace}><div className={styles.detailHeader}><h2 className="text-xl font-semibold text-slate-900">Project Details</h2><ProjectDetailActions key={detailProject.id} projectId={detailProject.id} projectNumber={detailProject.project_number} disabled={detailLoading || !!detailError} onClose={closeDetail} /></div><div className={styles.detailBody}>{detailLoading ? <p className="text-sm text-slate-500">Loading project details...</p> : detailError ? <p className="text-sm text-red-600">{detailError}</p> : <div className="space-y-6">
        <div className={styles.detailMetadata} aria-label="Project metadata">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Project Number</p><p className="mt-1 text-sm">{detailProject.project_number}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Project Name</p><p className="mt-1 text-sm">{detailProject.project_name}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Status</p><p className="mt-1 text-sm"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(detailProject.status)}`}>{detailProject.status}</span></p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Public Works</p><p className="mt-1 text-sm">{detailProject.public_works == null ? "Unclassified" : detailProject.public_works ? "Yes" : "No"}</p></div>
          <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Created Date</p><p className="mt-1 text-sm">{new Date(detailProject.created_at).toLocaleDateString()}</p></div>
          {detailProject.status === "Completed" || detailProject.completed_at || detailProject.completed_by ? <>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Completed Date</p><p className="mt-1 text-sm">{formatDateTime(detailProject.completed_at ?? null)}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Completed By</p><p className="mt-1 text-sm">{detailProject.completed_by || "—"}</p></div>
          </> : null}
          {detailProject.status === "Cancelled" || detailProject.cancelled_at || detailProject.cancelled_by ? <>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Cancelled Date</p><p className="mt-1 text-sm">{formatDateTime(detailProject.cancelled_at ?? null)}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Cancelled By</p><p className="mt-1 text-sm">{detailProject.cancelled_by || "—"}</p></div>
          </> : null}
          {detailProject.reactivated_at || detailProject.reactivated_by ? <>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reactivated Date</p><p className="mt-1 text-sm">{formatDateTime(detailProject.reactivated_at)}</p></div>
            <div><p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Reactivated By</p><p className="mt-1 text-sm">{detailProject.reactivated_by || "—"}</p></div>
          </> : null}
        </div>

        <ProjectLifecyclePanel key={`${detailProject.id}-${requestedLifecycleAction}`} projectId={detailProject.id} requestedAction={requestedLifecycleAction} onChanged={async () => {
          setRequestedLifecycleAction(undefined);
          await fetchProjects();
          await openDetail(detailProject);
        }} />
        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Document History</h3>
          {detailDocuments.length === 0 ? <p className="text-sm text-slate-500">No documents found.</p> : <div className="overflow-x-auto"><table className="min-w-[640px] border-collapse text-left"><thead className="bg-slate-50"><tr><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Document Name</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Type</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Contractor</th><th className="border border-slate-200 px-3 py-2 text-sm font-semibold">Upload Date</th></tr></thead><tbody>{detailDocuments.map((document) => <tr key={document.id}><td className="border border-slate-200 px-3 py-2 text-sm">{document.document_name}</td><td className="border border-slate-200 px-3 py-2 text-sm">{document.document_type}</td><td className="border border-slate-200 px-3 py-2 text-sm">{document.contractors?.company_name || detailContractorNames.get(document.contractor_id) || "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{document.upload_date}</td></tr>)}</tbody></table></div>}
        </div>

        {projectComplianceSections(detailCompliance, detailContractorNames, new Set(detailProject.status === "Active"
          ? detailAssignments.filter(assignment => assignment.active).map(assignment => assignment.contractor_id) : [])).map(section => (
          <div key={section.name}>
            <h3 className="mb-3 text-lg font-semibold text-slate-900">{section.name}</h3>
            {section.rows.length === 0 ? <p className="text-sm text-slate-500">No {section.name.toLowerCase()} found.</p> : (
              <div className="overflow-x-auto"><table aria-label={section.name} className="min-w-[640px] border-collapse text-left">
                <thead className="bg-slate-50"><tr>{section.columns.map(column => <th key={column} className="border border-slate-200 px-3 py-2 text-sm font-semibold">{column}</th>)}</tr></thead>
                <tbody>{section.rows.map((row, index) => <tr key={index}>{section.columns.map(column => {
                  const value = row[column];
                  const statusStyle = Object.entries(complianceStatusStyles).find(([status]) => status === value)?.[1];
                  return <td key={column} className="border border-slate-200 px-3 py-2 text-sm">
                    {column.endsWith("Status") ? <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusStyle ?? "bg-slate-100 text-slate-600"}`}>{value}</span> : value}
                  </td>;
                })}</tr>)}</tbody>
              </table></div>
            )}
          </div>
        ))}

        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Status Change History</h3>
          {detailStatusChanges.length === 0 ? <p className="text-sm text-slate-500">No status changes recorded.</p> : <div className="overflow-x-auto"><table className="min-w-[760px] border-collapse text-left"><thead className="bg-slate-50"><tr>{["Previous Status", "New Status", "Changed By", "Changed Date/Time"].map((heading) => <th key={heading} className="border border-slate-200 px-3 py-2 text-sm font-semibold">{heading}</th>)}</tr></thead><tbody>{detailStatusChanges.map((item) => { const parsed = parseStatusChangeNotes(item.notes); return <tr key={item.id}><td className="border border-slate-200 px-3 py-2 text-sm">{parsed?.previousStatus ?? "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{parsed ? <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusBadge(parsed.newStatus)}`}>{parsed.newStatus}</span> : "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{parsed?.changedBy ?? item.created_by ?? "—"}</td><td className="border border-slate-200 px-3 py-2 text-sm">{formatDateTime(item.created_at)}</td></tr>; })}</tbody></table></div>}
        </div>

        <div>
          <h3 className="mb-3 text-lg font-semibold text-slate-900">Status Timeline</h3>
          {detailTimeline.length === 0 ? <p className="text-sm text-slate-500">No history recorded.</p> : <ol className="relative ml-3 border-l border-slate-200">{detailTimeline.map((event, index) => <li key={`${event.sortKey}-${index}`} className="mb-5 ml-4 last:mb-0"><span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-slate-400"></span><div className="flex flex-wrap items-baseline gap-x-3"><span className="text-xs font-medium text-slate-500">{event.date}{event.time ? ` ${event.time}` : ""}</span><span className="text-sm font-semibold text-slate-800">{event.type}</span>{event.changedBy ? <span className="text-xs text-slate-500">by {event.changedBy}</span> : null}</div><p className="mt-0.5 text-sm text-slate-600">{event.description}</p></li>)}</ol>}
        </div>
      </div>}</div></div></div> : null}

      {statusChange ? <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4"><div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl"><h2 className="text-xl font-semibold text-slate-900">Reactivate Legacy Project?</h2><p className="mt-3 text-sm text-slate-600">This will mark {statusChange.project.project_name} active again. Historical records remain intact. Projects closed through the new closeout workflow cannot be reopened here.</p><div className="mt-6 flex justify-end gap-3"><button type="button" onClick={() => setStatusChange(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm">Cancel</button><button type="button" onClick={() => void handleStatusChange()} disabled={saving} className="rounded-xl bg-emerald-600 px-4 py-2.5 text-sm text-white">{saving ? "Saving..." : "Reactivate"}</button></div></div></div> : null}
    </main>
  );
}
