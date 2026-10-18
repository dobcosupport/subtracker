"use client";

import { useState } from "react";
import DobcoContactsPanel from "@/components/DobcoContactsPanel";
import CommunicationChannelSettings from "@/components/CommunicationChannelSettings";
import NotificationsPanel from "@/components/NotificationsPanel";
import CommunicationTemplatesPanel from "@/components/CommunicationTemplatesPanel";

const settingsTabs = ["General", "Email", "Text Messaging", "Notifications", "Templates", "DOBCO CONTACTS"] as const;
type SettingsTab = (typeof settingsTabs)[number];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<SettingsTab>("General");

  return (
    <main className="min-h-screen bg-[#f5f7fb] p-4 text-slate-800 sm:p-8">
      <div className="mx-auto max-w-5xl overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-200 p-6 sm:p-8">
          <p className="text-xs font-semibold uppercase tracking-[0.24em] text-slate-400">Administration</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Application Settings</h1>
          <div role="tablist" aria-label="Administration settings" className="mt-6 flex gap-1 overflow-x-auto border-b border-slate-200">
            {settingsTabs.map((tab) => (
              <button
                key={tab}
                id={`settings-tab-${tab.toLowerCase().replaceAll(" ", "-")}`}
                type="button"
                role="tab"
                aria-selected={activeTab === tab}
                aria-controls="settings-tab-panel"
                onClick={() => setActiveTab(tab)}
                className={`-mb-px shrink-0 border-b-2 px-4 py-3 text-sm font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${
                  activeTab === tab
                    ? "border-indigo-600 text-indigo-700"
                    : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800"
                }`}
              >
                {tab}
              </button>
            ))}
          </div>
        </div>

        <section
          id="settings-tab-panel"
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab.toLowerCase().replaceAll(" ", "-")}`}
          className="p-6 sm:p-8"
        >
          {activeTab === "General" ? (
            <>
              <h2 className="text-lg font-semibold text-slate-900">Application Settings</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-500">Configure workspace preferences and application behavior.</p>
            </>
          ) : null}
          {activeTab === "Email" ? <CommunicationChannelSettings key="email" channel="email" /> : null}
          {activeTab === "Text Messaging" ? <CommunicationChannelSettings key="sms" channel="sms" /> : null}
          {activeTab === "Notifications" ? <NotificationsPanel /> : null}
          {activeTab === "Templates" ? <CommunicationTemplatesPanel /> : null}
          {activeTab === "DOBCO CONTACTS" ? <DobcoContactsPanel /> : null}
        </section>
      </div>
    </main>
  );
}
