import type { Assignment, Project } from "@/types/database";
import styles from "./ContractorProjectAssignments.module.css";

export function projectOwnership(assignment: Pick<Assignment, "ownership_sources">): string {
  const sources = [...assignment.ownership_sources].sort();
  return sources.length === 2 && sources.includes("MANUAL") && sources.includes("MYCOI")
    ? "BOTH" : sources.join(" + ") || "None";
}

const compactSourceLabels: Readonly<Record<string, string>> = { MANUAL: "MAN", MYCOI: "COI", PROCORE: "PRO" };

function projectOwnershipBadge(assignment: Pick<Assignment, "ownership_sources">): string {
  return [...assignment.ownership_sources].sort().map((source) => compactSourceLabels[source] ?? source).join(" / ") || "None";
}

export default function ContractorProjectAssignments({ projects, assignments, busyId, onToggle }: {
  projects: Project[];
  assignments: Assignment[];
  busyId: number | null;
  onToggle: (project: Project) => Promise<void>;
}) {
  const sortedProjects = [...projects].sort((left, right) =>
    left.project_number.localeCompare(right.project_number, "en", { numeric: true, sensitivity: "base" }));

  return <div className={`mt-2 min-w-0 border-t border-slate-200 pt-3 ${styles.container}`}>
    <p className="text-sm font-semibold text-slate-700">Assign Projects</p>
    <p className="mt-1 text-xs text-slate-500">Sources: MAN = MANUAL, COI = MYCOI, PRO = PROCORE. Checkboxes control MANUAL ownership. Select an imported project to retain it manually. Removing MANUAL ownership never removes another source&apos;s ownership.</p>
    {!projects.length ? <p className="mt-2 text-xs text-slate-500">No projects available.</p> :
      <div className={`mt-2 grid max-h-40 gap-x-2 gap-y-1 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2 ${styles.projects}`}>
        {sortedProjects.map((project) => {
          const assignment = assignments.find((item) => item.project_id === project.id);
          return <label key={project.id} title={project.project_name} className="flex min-w-0 flex-wrap items-center gap-1 break-all text-[11px] text-slate-700">
            <input type="checkbox" aria-label={`MANUAL ${project.project_number}`} checked={assignment?.manual_owned ?? false}
              disabled={busyId === project.id} onChange={() => void onToggle(project)} />
            {project.project_number}
            {assignment ? <span title={`Ownership: ${assignment.ownership_sources.join(" + ")}`} className="whitespace-nowrap rounded bg-slate-200 px-1">{projectOwnershipBadge(assignment)}</span> : null}
          </label>;
        })}
      </div>}
  </div>;
}
