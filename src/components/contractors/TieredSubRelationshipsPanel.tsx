"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { getAssignmentsForContractors, sortAssignmentsByProjectNumber } from "@/services/assignments";
import { getCompanyComplianceStatuses, type CompanyComplianceStatus } from "@/services/dashboard";
import type { Assignment, TieredSubRecord } from "@/types/database";

const badgeStyles: Record<CompanyComplianceStatus, string> = {
  Compliant: "bg-emerald-100 text-emerald-700",
  Expiring: "bg-amber-100 text-amber-700",
  "Non-Compliant": "bg-red-100 text-red-700",
};

export function getSharedAssignments(parentAssignments: Assignment[], childAssignments: Assignment[]): Assignment[] {
  const parentProjectIds = new Set(parentAssignments.filter((assignment) => assignment.active).map((assignment) => assignment.project_id));
  const shared = new Map<number, Assignment>();
  childAssignments.forEach((assignment) => {
    if (assignment.active && parentProjectIds.has(assignment.project_id) && assignment.projects) {
      shared.set(assignment.project_id, assignment);
    }
  });
  return sortAssignmentsByProjectNumber([...shared.values()]);
}

export default function TieredSubRelationshipsPanel({
  contractorId, companyName, relationships, parentAssignments, loading, error, children,
}: {
  contractorId: number;
  companyName: string;
  relationships: TieredSubRecord[];
  parentAssignments: Assignment[];
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  const activeRelationships = relationships.filter((relationship) => relationship.active);
  const idsKey = [...new Set(activeRelationships.map((relationship) => relationship.tiered_sub_contractor_id))].sort((a, b) => a - b).join(",");
  const [projectData, setProjectData] = useState<{ key: string; assignments: Assignment[]; error: string | null } | null>(null);
  const [statusData, setStatusData] = useState<{ key: string; statuses: Map<number, CompanyComplianceStatus>; error: string | null } | null>(null);

  useEffect(() => {
    if (!idsKey) return;
    let current = true;
    const ids = idsKey.split(",").map(Number);
    void getAssignmentsForContractors(ids).then((result) => {
      if (current) setProjectData({ key: idsKey, assignments: result.data ?? [], error: result.error?.message ?? null });
    });
    void getCompanyComplianceStatuses(ids).then((result) => {
      if (current) setStatusData({ key: idsKey, statuses: result.data ?? new Map(), error: result.error?.message ?? null });
    });
    return () => { current = false; };
  }, [idsKey]);

  const projectsReady = projectData?.key === idsKey;
  const statusesReady = statusData?.key === idsKey;
  return <section aria-labelledby="tiered-relationships-heading" className="mt-2 border-t border-slate-200 pt-3">
    <h3 id="tiered-relationships-heading" className="text-sm font-semibold text-slate-700">Tiered Sub Relationships ({activeRelationships.length})</h3>
    <p className="mt-1 text-xs text-slate-500">Shared active project assignments, not project-specific subcontracting records. Status includes compliance and insurance.</p>
    {error ? <p role="alert" className="mt-2 text-xs text-red-600">{error}</p> : null}
    {loading ? <p className="mt-2 text-xs text-slate-500">Loading relationships...</p> : error && activeRelationships.length === 0 ? null : <>
      <Link href={`/contractors/${contractorId}`} className="mt-3 block break-words text-sm font-semibold text-indigo-600 hover:underline">{companyName}</Link>
      <p className="text-xs text-slate-500">Parent contractor</p>
      {activeRelationships.length === 0 ? <p className="mt-2 text-xs text-slate-500">No active tiered-sub relationships.</p> : <ul className="ml-2 mt-2 space-y-3 border-l border-slate-200">
        {activeRelationships.map((relationship) => {
          const id = relationship.tiered_sub_contractor_id;
          const status = statusesReady && !statusData.error ? statusData.statuses.get(id) : undefined;
          const shared = projectsReady ? getSharedAssignments(parentAssignments, projectData.assignments.filter((assignment) => assignment.contractor_id === id)) : [];
          return <li key={relationship.id} className="relative pl-4 before:absolute before:left-0 before:top-3 before:w-3 before:border-t before:border-slate-200">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/contractors/${id}`} className="break-words text-sm font-medium text-indigo-600 hover:underline">{relationship.tiered_sub_contractor?.company_name ?? "Unknown contractor"}</Link>
              <span title="Supplemental status using the existing Dashboard compliance and insurance rules" className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${status ? badgeStyles[status] : "bg-slate-100 text-slate-500"}`}>{status ?? (statusesReady ? "Status unavailable" : "Loading status...")}</span>
            </div>
            <p className="mt-1 text-xs font-medium text-slate-600">Shared Assigned Projects</p>
            {!projectsReady ? <p className="text-xs text-slate-500">Loading shared projects...</p> : projectData.error ? <p className="text-xs text-slate-500">Shared projects unavailable.</p> : shared.length ? <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">{shared.map((assignment) => <Link key={assignment.project_id} href={`/projects?projectId=${assignment.project_id}`} className="text-xs text-indigo-600 hover:underline">{assignment.projects?.project_number}</Link>)}</div> : <p className="text-xs text-slate-500">No Shared Assigned Projects</p>}
          </li>;
        })}
      </ul>}
      {projectsReady && projectData.error ? <p role="alert" className="mt-2 text-xs text-red-600">Unable to load shared projects: {projectData.error}</p> : null}
      {statusesReady && statusData.error ? <p role="alert" className="mt-2 text-xs text-red-600">Compliance status unavailable: {statusData.error}</p> : null}
    </>}
    {children}
  </section>;
}
