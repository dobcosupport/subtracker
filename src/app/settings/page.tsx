"use client";

import { useState } from "react";
import DobcoContactsPanel from "@/components/DobcoContactsPanel";

const settingsTabs = ["General", "Email", "Text Messaging", "Notifications", "DOBCO CONTACTS"] as const;
type SettingsTab = (typeof settingsTabs)[number];

function StatusBadge({ children }: { children: string }) {
  return <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-800">{children}</span>;
}

function PlaceholderField({ label, value = "Not configured" }: { label: string; value?: string }) {
  return (
    <div>
      <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</label>
      <input
        aria-label={label}
        disabled
        value={value}
        className="mt-1.5 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-500 disabled:cursor-not-allowed"
      />
    </div>
  );
}

function InactiveButton({ children }: { children: string }) {
  return (
    <button
      type="button"
      disabled
      className="cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-4 py-2.5 text-sm font-medium text-slate-400"
    >
      {children}
    </button>
  );
}

function ChannelConfiguration({ channel }: { channel: "Email" | "SMS" }) {
  const isEmail = channel === "Email";
  const fields = isEmail
    ? ["Sending Domain", "From Name", "From Address", "Reply-To Address"]
    : ["Sending Phone Number", "Incoming SMS", "Two-Way Messaging"];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Provider</p>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">Azure Communication Services</h2>
          <p className="mt-1 text-sm text-slate-500">{isEmail ? "Email" : "Text messaging"} configuration is presentation-only and not connected.</p>
        </div>
        <StatusBadge>NOT CONFIGURED</StatusBadge>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <PlaceholderField label="Connection Status" value="Not configured" />
        <PlaceholderField label={`${channel} Enabled / Disabled`} value="Disabled" />
        {fields.map((field) => <PlaceholderField key={field} label={field} />)}
      </div>

      <div className="flex flex-wrap gap-3 border-t border-slate-100 pt-5">
        <InactiveButton>Test Connection</InactiveButton>
        <InactiveButton>{isEmail ? "Send Test Email" : "Send Test SMS"}</InactiveButton>
      </div>
      <p className="text-xs text-slate-500">Configuration, credentials, and sending are not available in this step.</p>
    </div>
  );
}

function NotificationsPanel() {
  const defaultSchedule = [90, 60, 30];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Compliance Notifications</h2>
          <p className="mt-1 text-sm text-slate-500">Proposed default schedule only. Notifications are not yet active or configured.</p>
        </div>
        <StatusBadge>NOT ACTIVE</StatusBadge>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[680px] border-collapse text-left">
          <thead className="bg-slate-50">
            <tr>
              {["Reminder", "Days Before Expiration", "Email Enabled", "SMS Enabled", "Active"].map((heading) => (
                <th key={heading} className="border-b border-slate-200 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{heading}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {defaultSchedule.map((days) => (
              <tr key={days}>
                <td className="border-b border-slate-100 px-4 py-3 text-sm font-medium text-slate-800">{days}-day reminder</td>
                <td className="border-b border-slate-100 px-4 py-3 text-sm text-slate-700">{days} days</td>
                {[`Email ${days} days`, `SMS ${days} days`, `Reminder ${days} days`].map((label) => (
                  <td key={label} className="border-b border-slate-100 px-4 py-3">
                    <input type="checkbox" aria-label={label} disabled className="h-4 w-4 cursor-not-allowed accent-slate-400" />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-slate-500">These display defaults do not configure or affect compliance calculations.</p>
      <InactiveButton>+ Add Reminder</InactiveButton>

      <div className="border-t border-slate-200 pt-5">
        <h3 className="text-base font-semibold text-slate-900">Master Automation Controls</h3>
        <p className="mt-1 text-sm text-slate-500">Automated delivery is non-operational in this step.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {["Automated Email", "Automated SMS"].map((label) => (
            <div key={label} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="text-sm font-medium text-slate-700">{label}</span>
              <StatusBadge>Disabled</StatusBadge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

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
          {activeTab === "Email" ? <ChannelConfiguration channel="Email" /> : null}
          {activeTab === "Text Messaging" ? <ChannelConfiguration channel="SMS" /> : null}
          {activeTab === "Notifications" ? <NotificationsPanel /> : null}
          {activeTab === "DOBCO CONTACTS" ? <DobcoContactsPanel /> : null}
        </section>
      </div>
    </main>
  );
}
