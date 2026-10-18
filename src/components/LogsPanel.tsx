"use client";

import { useState } from "react";
import AuditLogsPanel from "@/components/AuditLogsPanel";
import CommunicationLogsPanel from "@/components/CommunicationLogsPanel";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessCommunications, canAccessModule } from "@/lib/permissions";

type LogTab = "audit" | "communications";

export default function LogsPanel({ initialTab }: { initialTab: LogTab }) {
  const { permissions } = useSessionProfile();
  const auditAllowed = canAccessModule(permissions, "audit");
  const communicationsAllowed = canAccessCommunications(permissions);
  const [selected, setSelected] = useState<LogTab>(initialTab);
  const activeTab = selected === "audit"
    ? auditAllowed ? "audit" : "communications"
    : communicationsAllowed ? "communications" : "audit";
  const tabs = [
    { id: "audit", label: "Audit Logs", allowed: auditAllowed },
    { id: "communications", label: "Communication Logs", allowed: communicationsAllowed },
  ] as const;

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-8">
      <div className="mx-auto max-w-7xl space-y-5">
        <header>
          <p className="text-xs font-semibold uppercase text-slate-400">Administration</p>
          <h1 className="mt-2 text-3xl font-semibold text-slate-900">Logs</h1>
        </header>
        <div role="tablist" aria-label="Logs" className="flex gap-1 border-b border-slate-200">
          {tabs.map((tab) => <button key={tab.id} type="button" role="tab" id={`logs-tab-${tab.id}`}
            aria-controls={`logs-panel-${tab.id}`} aria-selected={activeTab === tab.id}
            disabled={!tab.allowed} title={tab.allowed ? undefined : "You do not have permission to view these logs."}
            onClick={() => setSelected(tab.id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50 ${activeTab === tab.id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500"}`}>
            {tab.label}
          </button>)}
        </div>
        <section role="tabpanel" id={`logs-panel-${activeTab}`} aria-labelledby={`logs-tab-${activeTab}`}>
          {activeTab === "audit" && auditAllowed ? <AuditLogsPanel /> : null}
          {activeTab === "communications" && communicationsAllowed ? <CommunicationLogsPanel /> : null}
        </section>
      </div>
    </main>
  );
}
