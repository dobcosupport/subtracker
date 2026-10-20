"use client";

import { useCallback, useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { createContractorContact, getContractorContacts, updateContractorContact } from "@/services/contractorContacts";
import type { ContractorContact, ContractorContactInput } from "@/types/database";

const emptyContact: ContractorContactInput = {
  contact_name: "",
  title_or_role: "",
  email: "",
  mobile_phone: "",
  is_primary_contact: false,
  is_compliance_contact: false,
  receives_compliance_email: false,
  receives_compliance_sms: false,
  sms_consent_recorded: false,
  sms_consent_date: null,
  sms_consent_source_or_note: "",
  is_active: true,
};

function contactInput(contact: ContractorContact): ContractorContactInput {
  return {
    contact_name: contact.contact_name,
    title_or_role: contact.title_or_role,
    email: contact.email,
    mobile_phone: contact.mobile_phone,
    is_primary_contact: contact.is_primary_contact,
    is_compliance_contact: contact.is_compliance_contact,
    receives_compliance_email: contact.receives_compliance_email,
    receives_compliance_sms: contact.receives_compliance_sms,
    sms_consent_recorded: contact.sms_consent_recorded,
    sms_consent_date: contact.sms_consent_date,
    sms_consent_source_or_note: contact.sms_consent_source_or_note,
    is_active: contact.is_active,
  };
}

function Field({ id, label, value, onChange, type = "text" }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "email" | "tel" | "date";
}) {
  return (
    <label htmlFor={id} className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">{label}</span>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      />
    </label>
  );
}

function Preference({ id, label, checked, onChange, disabled = false }: {
  id: string;
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex items-center gap-2 text-sm text-slate-700">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} className="h-4 w-4 rounded border-slate-300 accent-indigo-600 disabled:cursor-not-allowed" />
      {label}
    </label>
  );
}

export default function ContractorContactsSection({ contractorId, onContactsChanged }: {
  contractorId: number;
  onContactsChanged: () => void;
}) {
  const profile = useSessionProfile();
  const canManage = profile.system_administrator || profile.permissions.some(
    (permission) => permission.module === "contractors" && permission.can_manage
  );
  const [contacts, setContacts] = useState<ContractorContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [editingContact, setEditingContact] = useState<ContractorContact | null>(null);
  const [form, setForm] = useState<ContractorContactInput>(emptyContact);
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const loadContacts = useCallback(async () => {
    setLoading(true);
    const result = await getContractorContacts(contractorId);
    if (result.error) {
      setLoadError(result.error.message);
    } else {
      setContacts(result.data ?? []);
      setLoadError(null);
    }
    setLoading(false);
  }, [contractorId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void loadContacts(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [loadContacts]);

  const openAdd = () => {
    setEditingContact(null);
    setForm(emptyContact);
    setFormError(null);
    setFormOpen(true);
  };

  const openEdit = (contact: ContractorContact) => {
    setEditingContact(contact);
    setForm(contactInput(contact));
    setFormError(null);
    setFormOpen(true);
  };

  const saveContact = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!form.contact_name.trim()) {
      setFormError("Contact Name is required.");
      return;
    }
    setSaving(true);
    setFormError(null);
    const result = editingContact
      ? await updateContractorContact(contractorId, editingContact.id, form)
      : await createContractorContact(contractorId, form);
    if (result.error || !result.data) {
      setFormError(result.error?.message ?? "Unable to save contact.");
      setSaving(false);
      return;
    }
    setFormOpen(false);
    setEditingContact(null);
    setSaving(false);
    await loadContacts();
    onContactsChanged();
  };

  const toggle = (key: keyof ContractorContactInput, value: boolean) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  return (
    <section aria-labelledby="contractor-contacts-heading" className="mt-2 border-t border-slate-200 pt-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id="contractor-contacts-heading" className="min-w-0 flex-1 text-sm font-semibold text-slate-700">
          <button type="button" aria-expanded={isExpanded} aria-controls="contractor-contact-list" onClick={() => setIsExpanded((current) => !current)} className="flex w-full items-center justify-between text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">
            <span>Contacts</span>
            <span aria-hidden="true" className={`inline-block transition-transform ${isExpanded ? "rotate-90" : ""}`}>›</span>
          </button>
        </h3>
        {canManage ? <button type="button" aria-label="Add Contact" title="Add Contact" onClick={openAdd} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-xl font-medium text-slate-700 hover:bg-slate-100 hover:text-indigo-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">+</button> : null}
      </div>

      <div id="contractor-contact-list" hidden={!isExpanded}>
      {loadError ? <p role="alert" className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p> : null}
      {loading ? <p className="mt-4 text-sm text-slate-500">Loading contacts...</p> : null}
      {!loading && !loadError && contacts.length === 0 ? <p className="mt-4 text-sm text-slate-500">No contacts have been added.</p> : null}

      {!loading && !loadError && contacts.length > 0 ? (
        <div className="mt-2 space-y-2">
          {contacts.map((contact) => (
            <div key={contact.id} className="flex items-start gap-2">
              <details className="group min-w-0 flex-1">
                <summary className={`cursor-pointer break-words rounded text-sm font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 ${contact.is_active ? "text-indigo-700 hover:text-indigo-900" : "text-slate-500 hover:text-slate-700"}`}>
                  {contact.contact_name}
                </summary>
                <dl className="my-1 space-y-1 pl-4 text-xs text-slate-600">
                  {contact.title_or_role ? <div><dt className="inline font-medium">Title / Role: </dt><dd className="inline break-words">{contact.title_or_role}</dd></div> : null}
                  <div><dt className="inline font-medium">Email: </dt><dd className="inline break-words">{contact.email || "—"}</dd></div>
                  <div><dt className="inline font-medium">Mobile Phone: </dt><dd className="inline">{contact.mobile_phone || "—"}</dd></div>
                </dl>
              </details>
              <div className="flex shrink-0 items-center gap-1 text-xs font-medium">
                {contact.is_primary_contact ? <span className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800">Primary</span> : null}
                {canManage ? <button type="button" onClick={() => openEdit(contact)} className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 hover:bg-slate-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600">Edit</button> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
      </div>

      {formOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6">
          <div role="dialog" aria-modal="true" aria-labelledby="contractor-contact-form-title" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-5 shadow-xl sm:p-6">
            <h3 id="contractor-contact-form-title" className="text-xl font-semibold text-slate-900">{editingContact ? "Edit Contact" : "Add Contact"}</h3>
            <form onSubmit={saveContact} className="mt-5 space-y-5">
              <fieldset className="grid gap-4 sm:grid-cols-2">
                <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Contact</legend>
                <Field id="contact-name" label="Contact Name" value={form.contact_name} onChange={(value) => setForm((current) => ({ ...current, contact_name: value }))} />
                <Field id="contact-title-role" label="Title / Role" value={form.title_or_role ?? ""} onChange={(value) => setForm((current) => ({ ...current, title_or_role: value }))} />
                <Field id="contact-email" label="Email" type="email" value={form.email ?? ""} onChange={(value) => setForm((current) => ({ ...current, email: value }))} />
                <Field id="contact-mobile" label="Mobile Phone" type="tel" value={form.mobile_phone ?? ""} onChange={(value) => setForm((current) => ({ ...current, mobile_phone: value }))} />
              </fieldset>

              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Designations</legend>
                <Preference id="contact-primary" label="Primary Contact" checked={form.is_primary_contact} disabled={!form.is_active} onChange={(value) => toggle("is_primary_contact", value)} />
                <Preference id="contact-compliance" label="Compliance Contact" checked={form.is_compliance_contact} onChange={(value) => toggle("is_compliance_contact", value)} />
              </fieldset>

              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Communication Preferences</legend>
                <Preference id="contact-receives-email" label="Receive Compliance Email" checked={form.receives_compliance_email} onChange={(value) => toggle("receives_compliance_email", value)} />
                <Preference id="contact-receives-sms" label="Receive Compliance SMS" checked={form.receives_compliance_sms} onChange={(value) => toggle("receives_compliance_sms", value)} />
              </fieldset>

              <fieldset className="space-y-3">
                <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">SMS Consent</legend>
                <Preference id="contact-sms-consent" label="SMS Consent Recorded" checked={form.sms_consent_recorded} onChange={(value) => toggle("sms_consent_recorded", value)} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field id="contact-sms-consent-date" label="SMS Consent Date" type="date" value={form.sms_consent_date ?? ""} onChange={(value) => setForm((current) => ({ ...current, sms_consent_date: value || null }))} />
                  <Field id="contact-sms-consent-source" label="SMS Consent Source / Note" value={form.sms_consent_source_or_note ?? ""} onChange={(value) => setForm((current) => ({ ...current, sms_consent_source_or_note: value }))} />
                </div>
              </fieldset>

              <fieldset>
                <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">Status</legend>
                <Preference id="contact-active" label="Active" checked={form.is_active} onChange={(value) => setForm((current) => ({ ...current, is_active: value, is_primary_contact: value && current.is_primary_contact }))} />
              </fieldset>

              {form.receives_compliance_email && !form.email?.trim() ? <p role="status" className="text-sm text-amber-800">Compliance Email is enabled, but an email address is required for future eligibility.</p> : null}
              {form.receives_compliance_sms && (!form.mobile_phone?.trim() || !form.sms_consent_recorded) ? <p role="status" className="text-sm text-amber-800">Compliance SMS is enabled, but a mobile number and recorded consent are required for future eligibility.</p> : null}
              {formError ? <p role="alert" className="text-sm text-red-700">{formError}</p> : null}
              <div className="flex justify-end gap-3 border-t border-slate-100 pt-4">
                <button type="button" onClick={() => setFormOpen(false)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-700">Cancel</button>
                <button type="submit" disabled={saving} className="rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-50">{saving ? "Saving..." : editingContact ? "Save Changes" : "Add Contact"}</button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </section>
  );
}
