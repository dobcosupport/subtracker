"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Assignment, Project } from "@/types/database";
import styles from "./ContractorProjectAssignments.module.css";

export function projectOwnership(assignment: Pick<Assignment, "ownership_sources">): string {
  const sources = [...assignment.ownership_sources].sort();
  return sources.length === 2 && sources.includes("MANUAL") && sources.includes("MYCOI")
    ? "BOTH" : sources.join(" + ") || "None";
}

const sourceLabels: Readonly<Record<string, string>> = { MANUAL: "Manual", MYCOI: "myCOI", PROCORE: "Procore" };

function Sources({ sources }: { sources: string[] }) {
  return sources.length ? <span className={styles.sources}>{["MANUAL", "PROCORE", "MYCOI", ...sources.filter((source) => !(source in sourceLabels))].filter((source) => sources.includes(source)).map((source) => <span key={source} className={styles.source}>{sourceLabels[source] ?? source}</span>)}</span> : <span className="text-slate-400">—</span>;
}

export default function ContractorProjectAssignments({ contractorName, projects, assignments, onToggle }: {
  contractorName: string;
  projects: Project[];
  assignments: Assignment[];
  onToggle: (project: Project) => Promise<void>;
}) {
  const [managementOpen, setManagementOpen] = useState(false);
  const [assignedSearch, setAssignedSearch] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "manual" | "not-manual">("all");
  const [page, setPage] = useState(1);
  const [savingIds, setSavingIds] = useState<Set<number>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const inFlight = useRef(new Set<number>());
  const dialog = useRef<HTMLDialogElement>(null);
  const manageButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!managementOpen) return;
    const element = dialog.current;
    const opener = manageButton.current;
    element?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      element?.close();
      document.body.style.overflow = overflow;
      opener?.focus();
    };
  }, [managementOpen]);

  const sortedProjects = [...projects].sort((left, right) =>
    left.project_number.localeCompare(right.project_number, "en", { numeric: true, sensitivity: "base" }));
  const byProject = new Map(assignments.map((assignment) => [assignment.project_id, assignment]));
  const matches = (number: string | null | undefined, name: string | null | undefined, term: string) =>
    `${number ?? ""} ${name ?? ""}`.toLowerCase().includes(term.trim().toLowerCase());
  const visibleAssignments = [...assignments].sort((left, right) => (left.projects?.project_number ?? "").localeCompare(right.projects?.project_number ?? "", "en", { numeric: true }))
    .filter((assignment) => matches(assignment.projects?.project_number, assignment.projects?.project_name, assignedSearch));
  const manualCount = projects.filter((project) => byProject.get(project.id)?.manual_owned).length;
  const filteredProjects = sortedProjects.filter((project) => matches(project.project_number, project.project_name, search)
    && (filter === "all" || (filter === "manual" ? Boolean(byProject.get(project.id)?.manual_owned) : !byProject.get(project.id)?.manual_owned)));
  const pageSize = 50;
  const totalPages = Math.max(1, Math.ceil(filteredProjects.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageProjects = filteredProjects.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const toggle = async (project: Project) => {
    if (inFlight.current.has(project.id)) return;
    const assignment = byProject.get(project.id);
    if (assignment?.manual_owned && assignment.ownership_sources.every((source) => source === "MANUAL")
      && !window.confirm(`Remove assignment to ${project.project_number} — ${project.project_name}? MANUAL is the last ownership source. Continuing will remove this contractor's assignment to this project.`)) return;
    inFlight.current.add(project.id);
    setSavingIds(new Set(inFlight.current));
    setRowErrors((previous) => ({ ...previous, [project.id]: "" }));
    try {
      await onToggle(project);
    } catch (reason) {
      setRowErrors((previous) => ({ ...previous, [project.id]: reason instanceof Error ? reason.message : "Unable to update Manual ownership." }));
    } finally {
      inFlight.current.delete(project.id);
      setSavingIds(new Set(inFlight.current));
    }
  };

  return <div className={styles.container}>
    <div className={styles.heading}>
      <div><h2>Project Assignments</h2><p>Current relationships and their authoritative assignment sources.</p></div>
      <span className={styles.activeTotal}>{assignments.length} Active Projects</span>
    </div>
    <div className={styles.controls}>
      <input type="search" aria-label="Search assigned projects" placeholder="Search assigned projects..." value={assignedSearch} onChange={(event) => setAssignedSearch(event.target.value)} />
      <button ref={manageButton} type="button" onClick={() => setManagementOpen(true)} className={styles.button}>Manage Project Assignments</button>
    </div>
    <div className={styles.assignmentList}>
      <div className={styles.assignmentColumns} aria-hidden="true"><span>Project Number / Name</span><span>Source</span><span>Assignment Status</span></div>
      {visibleAssignments.map((assignment) => <div key={assignment.id} className={styles.assignmentRow}>
        <strong>{assignment.projects?.project_number || "—"} · {assignment.projects?.project_name || "—"}</strong>
        <Sources sources={assignment.ownership_sources} /><span className={styles.active}>{assignment.active ? "Active" : "Ended"}</span>
      </div>)}
      {!visibleAssignments.length ? <p className="py-5 text-xs text-slate-500">{assignments.length ? "No assigned projects match your search." : "No active project assignments."}</p> : null}
    </div>
    {managementOpen ? createPortal(<dialog ref={dialog} aria-modal="true" aria-labelledby="manage-projects-heading" aria-describedby="manual-ownership-notice" onCancel={(event) => { event.preventDefault(); setManagementOpen(false); }} className={styles.dialog}>
      <header className={styles.modalHeader}><h2 id="manage-projects-heading">Manage Project Assignments</h2><p>Manual assignment management for {contractorName}</p></header>
      <div className={styles.modalBody}>
        <div id="manual-ownership-notice" className={styles.notice}><strong>Manual ownership only</strong><p>Each checkbox change is saved immediately. Procore and myCOI relationships are preserved.</p></div>
        <div className={styles.controls}>
          <input type="search" aria-label="Search projects" placeholder="Search projects..." value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} />
          <div className={styles.filters} role="group" aria-label="Manual assignment filters">{([
            ["all", "All", projects.length], ["manual", "Assigned Manually", manualCount], ["not-manual", "Not Manually Assigned", projects.length - manualCount],
          ] as const).map(([key, label, count]) => <button key={key} type="button" aria-pressed={filter === key} onClick={() => { setFilter(key); setPage(1); }}>{label} ({count})</button>)}</div>
        </div>
        <div className={styles.tableScroll}><table className={styles.table}><thead><tr>{["Manual", "Project Number / Name", "Other Sources", "Project Status"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead><tbody>
          {pageProjects.map((project) => {
            const assignment = byProject.get(project.id);
            return <tr key={project.id}>
              <td><input type="checkbox" aria-label={`MANUAL ${project.project_number}`} checked={assignment?.manual_owned ?? false} disabled={savingIds.has(project.id)} onChange={() => void toggle(project)} /></td>
              <td><strong>{project.project_number} · {project.project_name}</strong>{savingIds.has(project.id) ? <span role="status" className={styles.saving}>Saving...</span> : null}{rowErrors[project.id] ? <p role="alert" className={styles.error}>{rowErrors[project.id]}</p> : null}</td>
              <td><Sources sources={assignment?.ownership_sources.filter((source) => source !== "MANUAL") ?? []} /></td>
              <td>{project.status}</td>
            </tr>;
          })}
        </tbody></table>{!pageProjects.length ? <p className="p-4 text-xs text-slate-500">No projects match your search and filter.</p> : null}</div>
        <div className={styles.pagination}><span>{filteredProjects.length ? `${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, filteredProjects.length)} of ${filteredProjects.length}` : "0 projects"} · Page {currentPage} of {totalPages}</span><div><button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button><button type="button" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Next</button></div></div>
      </div>
      <footer className={styles.modalFooter}><p>Changes are saved immediately.</p><button type="button" className={styles.button} onClick={() => setManagementOpen(false)}>Close</button></footer>
    </dialog>, document.body) : null}
  </div>;
}
