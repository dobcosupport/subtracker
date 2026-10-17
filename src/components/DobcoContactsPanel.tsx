"use client";

import { useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { adminFetch } from "@/lib/admin-client";
import { dobcoRecipientEligibility } from "@/lib/dobco-contacts";
import type { DobcoContact, DobcoContactInput, DobcoUserOption } from "@/types/dobco-contacts";

const emptyContact: DobcoContactInput = {
  contact_name: "",
  email: null,
  mobile_phone: null,
  is_active: true,
  receives_internal_email: false,
  receives_internal_sms: false,
  sms_consent_recorded: false,
  sms_consent_date: null,
  sms_consent_source_or_note: null,
  user_profile_id: null,
};

function contactInput(contact: DobcoContact): DobcoContactInput {
  return {
    contact_name: contact.contact_name,
    email: contact.email,
    mobile_phone: contact.mobile_phone,
    is_active: contact.is_active,
    receives_internal_email: contact.receives_internal_email,
    receives_internal_sms: contact.receives_internal_sms,
    sms_consent_recorded: contact.sms_consent_recorded,
    sms_consent_date: contact.sms_consent_date,
    sms_consent_source_or_note: contact.sms_consent_source_or_note,
    user_profile_id: contact.user_profile_id,
  };
}

function ContactField({ label, value, onChange, type = "text", required = false }: {
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel" | "date";
  required?: boolean;
}) {
  return (
    <label className="block text-sm text-slate-700">
      {label}
      <input type={type} value={value ?? ""} required={required} onChange={(event) => onChange(event.target.value)}
        className="mt-1 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100" />
    </label>
  );
}

function ContactCheckbox({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex items-center gap-2 text-sm text-slate-700"><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 accent-indigo-600" />{label}</label>;
}

export default function DobcoContactsPanel() {
  const profile = useSessionProfile();
  const settings = profile.permissions.find((entry) => entry.module === "settings");
  const canView = profile.system_administrator || Boolean(settings?.can_view);
  const canManage = profile.system_administrator || Boolean(settings?.can_manage);
  const canLinkUser = canManage && (profile.system_administrator || profile.permissions.some((entry) => entry.module === "users" && entry.can_view));
  const [contacts, setContacts] = useState<DobcoContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<DobcoContact | null>(null);
  const [form, setForm] = useState<DobcoContactInput | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [users, setUsers] = useState<DobcoUserOption[]>([]);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersError, setUsersError] = useState<string | null>(null);
  const formOpen = form !== null;

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await adminFetch("/api/admin/dobco-contacts", { signal: controller.signal });
        const result = await response.json() as { contacts?: DobcoContact[]; error?: string };
        if (!response.ok || !result.contacts) throw new Error(result.error ?? "Unable to load Dobco contacts.");
        if (!controller.signal.aborted) {
          setContacts(result.contacts);
          setLoadError(null);
        }
      } catch (error) {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Unable to load Dobco contacts.");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [canView]);

  useEffect(() => {
    if (!formOpen || !canLinkUser) return;
    const controller = new AbortController();
    const load = async () => {
      setUsersLoading(true);
      setUsersError(null);
      try {
        const response = await adminFetch("/api/admin/dobco-contacts/user-options", { signal: controller.signal });
        const result = await response.json() as { users?: DobcoUserOption[]; error?: string };
        if (!response.ok || !result.users) throw new Error(result.error ?? "Unable to load optional SubTracker users.");
        if (!controller.signal.aborted) setUsers(result.users);
      } catch (error) {
        if (!controller.signal.aborted) setUsersError(error instanceof Error ? error.message : "Unable to load optional SubTracker users.");
      } finally {
        if (!controller.signal.aborted) setUsersLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, [formOpen, canLinkUser]);

  const openForm = (contact: DobcoContact | null) => {
    setSelected(contact);
    setForm(contact ? contactInput(contact) : { ...emptyContact });
    setFormError(null);
    setNotice(null);
  };

  const persistContact = async (input: DobcoContactInput) => {
    setSaving(true);
    setFormError(null);
    try {
      const response = await adminFetch(selected ? `/api/admin/dobco-contacts/${selected.id}` : "/api/admin/dobco-contacts", {
        method: selected ? "PATCH" : "POST",
        body: JSON.stringify(input),
      });
      const result = await response.json() as { contact?: DobcoContact; error?: string };
      if (!response.ok || !result.contact) throw new Error(result.error ?? "Unable to save Dobco contact.");
      const contact = result.contact;
      setContacts((current) => [...current.filter((entry) => entry.id !== contact.id), contact]
        .sort((left, right) => left.contact_name.localeCompare(right.contact_name)));
      setForm(null);
      setSelected(null);
      setNotice("Dobco contact saved. No messages were sent.");
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Unable to save Dobco contact.");
    } finally {
      setSaving(false);
    }
  };

  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (form) await persistContact(form);
  };

  if (!canView) return <p className="text-sm text-slate-500">Administration Settings view permission is required.</p>;
  const eligibility = form ? dobcoRecipientEligibility(form) : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-700">DOBCO CONTACTS</h2>
        {canManage ? <button type="button" aria-label="Add Dobco Contact" title="Add Dobco Contact" disabled={loading || Boolean(loadError)} onClick={() => openForm(null)} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-xl text-slate-700 hover:bg-slate-100 disabled:opacity-50">+</button> : null}
      </div>
      <p className="text-xs text-slate-500">Internal address book, independent of SubTracker login accounts. Future recipient settings only; no email or SMS is sent.</p>
      {notice ? <p role="status" className="text-sm text-emerald-700">{notice}</p> : null}
      {loadError ? <p role="alert" className="text-sm text-red-700">{loadError}</p> : null}
      {loading ? <p className="text-sm text-slate-500">Loading Dobco contacts...</p> : null}
      {!loading && !loadError ? (
        <div className="space-y-2">
          {contacts.map((contact) => (
            <div key={contact.id} className="flex items-start gap-2">
              <details className="min-w-0 flex-1">
                <summary className={`cursor-pointer break-words rounded text-sm font-medium ${contact.is_active ? "text-indigo-700 hover:text-indigo-900" : "text-slate-500 hover:text-slate-700"}`}>
                  {contact.contact_name}
                </summary>
                <dl className="my-1 space-y-1 pl-4 text-xs text-slate-600">
                  <div><dt className="inline font-medium">Email: </dt><dd className="inline break-words">{contact.email || "—"}</dd></div>
                  <div><dt className="inline font-medium">Mobile Phone: </dt><dd className="inline">{contact.mobile_phone || "—"}</dd></div>
                  <div><dt className="inline font-medium">Status: </dt><dd className="inline">{contact.is_active ? "Active" : "Inactive"}</dd></div>
                </dl>
              </details>
              {canManage ? <div className="shrink-0 text-xs font-medium"><button type="button" onClick={() => openForm(contact)} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-200">Edit</button></div> : null}
            </div>
          ))}
          {contacts.length === 0 ? <p className="text-sm text-slate-500">No Dobco contacts have been added.</p> : null}
        </div>
      ) : null}

      {form && canManage ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div role="dialog" aria-modal="true" aria-labelledby="dobco-contact-form-title" className="max-h-[90vh] w-full max-w-xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl">
            <h3 id="dobco-contact-form-title" className="text-lg font-semibold text-slate-900">{selected ? "Edit" : "Add"} Dobco Contact</h3>
            <form onSubmit={save} className="mt-4 space-y-4">
              <fieldset disabled={saving} className="space-y-4">
                <fieldset className="space-y-3">
                  <legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Contact Information</legend>
                  <ContactField label="Contact Name" value={form.contact_name} required onChange={(value) => setForm({ ...form, contact_name: value })} />
                  <ContactField label="Email" type="email" value={form.email} onChange={(value) => setForm({ ...form, email: value })} />
                  <ContactField label="Mobile Phone" type="tel" value={form.mobile_phone} onChange={(value) => setForm({ ...form, mobile_phone: value })} />
                </fieldset>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Communication Preferences</legend>
                  <ContactCheckbox label="Receive Internal Email Alerts" checked={form.receives_internal_email} onChange={(value) => setForm({ ...form, receives_internal_email: value })} />
                  <ContactCheckbox label="Receive Internal SMS Alerts" checked={form.receives_internal_sms} onChange={(value) => setForm({ ...form, receives_internal_sms: value })} />
                </fieldset>
                <fieldset className="space-y-3">
                  <legend className="mb-2 text-xs font-semibold uppercase text-slate-500">SMS Consent</legend>
                  <ContactCheckbox label="SMS Consent Recorded" checked={form.sms_consent_recorded} onChange={(value) => setForm({ ...form, sms_consent_recorded: value })} />
                  <ContactField label="SMS Consent Date" type="date" value={form.sms_consent_date} onChange={(value) => setForm({ ...form, sms_consent_date: value || null })} />
                  <ContactField label="SMS Consent Source / Note" value={form.sms_consent_source_or_note} onChange={(value) => setForm({ ...form, sms_consent_source_or_note: value })} />
                </fieldset>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Status</legend>
                  <ContactCheckbox label="Active" checked={form.is_active} onChange={(value) => setForm({ ...form, is_active: value })} />
                  <p className="text-xs text-slate-500">Inactive contacts remain saved but are not eligible for future messages.</p>
                </fieldset>
                <fieldset className="space-y-2">
                  <legend className="mb-2 text-xs font-semibold uppercase text-slate-500">Optional Connection</legend>
                  <div>
                    <label htmlFor="dobco-user-profile" className="block text-sm text-slate-700">SubTracker User (optional)</label>
                    <select id="dobco-user-profile" value={form.user_profile_id ?? ""} disabled={!canLinkUser || usersLoading || Boolean(usersError)}
                      onChange={(event) => setForm({ ...form, user_profile_id: event.target.value || null })}
                      className="mt-1 w-full rounded-lg border border-slate-200 px-3 py-2 text-sm disabled:bg-slate-50">
                      <option value="">No linked user</option>
                      {form.user_profile_id && !users.some((user) => user.auth_user_id === form.user_profile_id) ? <option value={form.user_profile_id}>Existing link: {form.user_profile_id}</option> : null}
                      {users.map((user) => <option key={user.auth_user_id} value={user.auth_user_id}>{user.name} ({user.email})</option>)}
                    </select>
                  </div>
                  {usersLoading ? <p className="text-xs text-slate-500">Loading optional users...</p> : null}
                  {usersError ? <p role="alert" className="text-xs text-red-700">{usersError} You can still save the contact without changing its link.</p> : null}
                  <p className="text-xs text-slate-500">{canLinkUser ? "Linking is optional and never synchronizes contact information or status with the user account." : "User Management view permission is required to assign a user link. A login account is not required for this contact."}</p>
                </fieldset>
              </fieldset>
              <p className="text-xs text-slate-500">Future email eligible: {eligibility?.email ? "Yes" : "No"}. Future SMS eligible: {eligibility?.sms ? "Yes" : "No"}. Delivery is not configured.</p>
              {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
              <div className="flex flex-wrap justify-end gap-1 border-t border-slate-100 pt-3 text-xs font-medium">
                <button type="submit" disabled={saving} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50">{saving ? "Saving..." : "Save Contact"}</button>
                {selected ? <button type="button" disabled={saving} onClick={() => void persistContact({ ...contactInput(selected), is_active: !selected.is_active })} className="rounded-full bg-red-50 px-2 py-0.5 text-xs text-red-700 hover:bg-red-100 disabled:opacity-50">{selected.is_active ? "Deactivate" : "Activate"}</button> : null}
                <button type="button" disabled={saving} onClick={() => { setForm(null); setSelected(null); }} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-200 disabled:opacity-50">Cancel</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
