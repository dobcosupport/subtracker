"use client";

import { useState } from "react";
import DobcoContactsPanel from "@/components/DobcoContactsPanel";
import NotificationsPanel from "@/components/NotificationsPanel";
import CommunicationLogsPanel from "@/components/CommunicationLogsPanel";
import CommunicationTemplatesPanel from "@/components/CommunicationTemplatesPanel";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";

const areas = ["Overview", "Scheduled", "Sent", "Templates", "Dobco Contacts", "Notifications", "Settings"] as const;
type Area = (typeof areas)[number];

export default function EmailCommunicationsPage() {
  const [area, setArea] = useState<Area>("Overview");
  const { permissions } = useSessionProfile();
  const canViewSettings = canAccessModule(permissions, "settings");
  const existingPanel = area === "Dobco Contacts" || area === "Notifications" || area === "Templates";
  const tabId = (name: Area) => `email-communications-${name.toLowerCase().replaceAll(" ", "-")}`;

  return <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-8">
    <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <header className="border-b border-slate-200 p-5">
        <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Workspace</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">Email Communications</h1>
        <div role="tablist" aria-label="Email Communications areas" className="mt-4 flex gap-1 overflow-x-auto border-b border-slate-200">
          {areas.map(name => <button key={name} id={tabId(name)} role="tab" type="button"
            aria-selected={area === name} aria-controls="email-communications-panel" onClick={() => setArea(name)}
            className={`shrink-0 border-b-2 px-2 py-2 text-xs! font-medium ${area === name
              ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"}`}>
            {name}
          </button>)}
        </div>
      </header>
      <section id="email-communications-panel" role="tabpanel" aria-labelledby={tabId(area)} className="p-5">
        {area === "Overview" || area === "Scheduled" || area === "Sent" ? <CommunicationLogsPanel key={area} emailView={area} /> : existingPanel ? canViewSettings
          ? area === "Dobco Contacts" ? <DobcoContactsPanel /> : area === "Notifications" ? <NotificationsPanel /> : <CommunicationTemplatesPanel />
          : <p role="status" className="text-sm text-slate-600">Settings View permission is required to access {area}. Existing access rules are unchanged.</p>
          : <div className="max-w-2xl rounded-lg border border-slate-200 bg-slate-50 p-4">
            <h2 className="text-lg font-semibold text-slate-900">{area}</h2>
            <p className="mt-2 text-sm text-slate-600">Email delivery configuration is managed in Administration Settings, on the Email tab.</p>
            <a className="mt-3 inline-block text-sm text-indigo-700 underline" href="/settings">Open Administration Settings</a>
          </div>}
      </section>
    </div>
  </main>;
}
