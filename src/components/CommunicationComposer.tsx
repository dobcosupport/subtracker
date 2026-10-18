"use client";

import { useEffect, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { composeRows, readJson } from "@/lib/communication-compose-client";
import { composeEligibility, renderMessage, type MergeValues } from "@/lib/communication-templates";
import { parseCommunicationDraft } from "@/lib/communications";
import type { CommunicationChannel, CommunicationDraft, RecipientSnapshot } from "@/types/communications";
import type { ComposeCompliance, ComposeContact, ComposeOptions, EditableDraft, MessageTemplate } from "@/types/communication-compose";

const button = "rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50";
const control = "block w-full rounded border border-slate-300 px-2 py-1 text-sm";
type Preview = { input: CommunicationDraft; unresolved: string[]; provider: string | null; sender: string | null; id?: string; attempted?: boolean };
type Contractor = ComposeOptions["contractors"][number];
type Project = ComposeOptions["projects"][number];
const key = (contact: ComposeContact) => `${contact.type}:${contact.id}`;
function snapshot(contact: ComposeContact): RecipientSnapshot {
  return { recipient_type: contact.type, recipient_name: contact.contact_name, email: contact.email, mobile_phone: contact.mobile_phone,
    contractor_contact_id: contact.type === "contractor_contact" ? contact.id : null, dobco_contact_id: contact.type === "dobco_contact" ? contact.id : null };
}

export default function CommunicationComposer({ draftId, onClose, onSaved }: { draftId?: string; onClose: () => void; onSaved: () => void }) {
  const { permissions } = useSessionProfile();
  const contractorAllowed = canAccessModule(permissions, "contractors");
  const internalAllowed = canAccessModule(permissions, "settings");
  const projectAllowed = canAccessModule(permissions, "projects");
  const complianceAllowed = contractorAllowed && canAccessModule(permissions, "compliance");
  const [configuration, setConfiguration] = useState<Pick<ComposeOptions, "channels" | "installation"> | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [original, setOriginal] = useState<EditableDraft | null>(null);
  const [reselect, setReselect] = useState(false);
  const [channels, setChannels] = useState<CommunicationChannel[]>(["email"]);
  const [text, setText] = useState({ email: { subject: "", body: "", template: "" }, sms: { subject: "", body: "", template: "" } });
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [contractorResults, setContractorResults] = useState<Contractor[]>([]);
  const [projectResults, setProjectResults] = useState<Project[]>([]);
  const [contractorSearch, setContractorSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [contacts, setContacts] = useState<ComposeContact[]>([]);
  const [selected, setSelected] = useState<Record<CommunicationChannel, string[]>>({ email: [], sms: [] });
  const [compliance, setCompliance] = useState<ComposeCompliance[]>([]);
  const [record, setRecord] = useState<ComposeCompliance | null>(null);
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [config, availableTemplates, internal, draft] = await Promise.all([
          readJson<Pick<ComposeOptions, "channels" | "installation">>("/api/communications/compose-options"),
          composeRows<MessageTemplate>("templates"),
          internalAllowed ? composeRows<ComposeContact>("internal") : Promise.resolve([]),
          draftId ? readJson<{ draft: EditableDraft }>(`/api/communications/${encodeURIComponent(draftId)}/draft`) : Promise.resolve(null),
        ]);
        if (!active) return;
        setConfiguration(config); setTemplates(availableTemplates); setContacts(internal);
        if (draft) {
          setOriginal(draft.draft); setChannels([draft.draft.channel]);
          setText((current) => ({ ...current, [draft.draft.channel]: { subject: draft.draft.subject ?? "", body: draft.draft.body, template: draft.draft.template_id ?? "" } }));
          setContractors(draft.draft.related_contractors);
          setProjects(draft.draft.related_projects);
        }
        setReady(true);
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : "Unable to load composition data."); }
    })();
    return () => { active = false; };
  }, [draftId, internalAllowed]);
  async function task(action: () => Promise<void>) {
    setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update composition."); }
    finally { setBusy(false); }
  }
  async function addContractor(contractor: Contractor) {
    await task(async () => {
      if (contractors.some((c) => c.id === contractor.id)) return;
      const rows = await composeRows<ComposeContact>("contacts", { contractor_id: String(contractor.id) });
      const records = complianceAllowed ? await composeRows<ComposeCompliance>("compliance", { contractor_id: String(contractor.id) }) : [];
      setContractors((current) => [...current, contractor]); setContacts((current) => [...current, ...rows]); setCompliance((current) => [...current, ...records]);
    });
  }
  function buildPreview() {
    setError(""); setNotice("");
    try {
      if (!configuration) throw new Error("Composition configuration is not loaded.");
      const result: Preview[] = [];
      for (const channel of channels) {
        const savedRecipients = original && !reselect ? original.recipients : null;
        const targets = savedRecipients ?? contacts.filter((c) => selected[channel].includes(key(c))).map(snapshot);
        if (!targets.length) throw new Error(`Select at least one eligible ${channel} recipient.`);
        if (targets.length > 100) throw new Error("Select at most 100 recipients per channel.");
        const groups = original ? [targets] : targets.map((recipient) => [recipient]);
        for (const recipients of groups) {
          const contact = contacts.find((c) => c.id === (recipients[0].contractor_contact_id ?? recipients[0].dobco_contact_id));
          if (!savedRecipients && recipients.some((recipient) => {
            const live = contacts.find((c) => c.id === (recipient.contractor_contact_id ?? recipient.dobco_contact_id));
            return !live || !composeEligibility(live, channel);
          })) throw new Error("An ineligible recipient was selected. Reselect eligible contacts.");
          const contractor = contact?.contractor_id ? contractors.find((c) => c.id === contact.contractor_id) : contractors.length === 1 ? contractors[0] : null;
          const context: MergeValues = {
            contact_name: recipients.length === 1 ? recipients[0].recipient_name : null,
            contact_email: recipients.length === 1 ? recipients[0].email : null, contact_mobile: recipients.length === 1 ? recipients[0].mobile_phone : null,
            contractor_name: contractor?.company_name, project_number: projects.length === 1 ? projects[0].project_number : null,
            project_name: projects.length === 1 ? projects[0].project_name : null, ...configuration.installation,
            ...(record && record.contractor_id === contractor?.id ? { compliance_type: record.compliance_name, compliance_status: record.calculated_status,
              expiration_date: record.expiration_date, days_until_expiration: record.days_remaining === null ? null : String(record.days_remaining) } : {}),
          };
          // Existing rendered Draft content is not re-merged implicitly.
          const body = renderMessage(text[channel].body, original ? {} : context);
          const subject = renderMessage(channel === "email" ? text[channel].subject : "", original ? {} : context);
          const input = parseCommunicationDraft({
            channel, subject: channel === "email" ? subject.text : null, body: body.text, recipients,
            contractor_ids: contractors.map((c) => c.id), project_ids: projects.map((p) => p.id),
            compliance_record_ids: original?.compliance_record_ids ?? (record ? [record.compliance_record_id] : []),
            mycoi_policy_ids: original?.mycoi_policy_ids ?? [], insurance_items: original?.insurance_items ?? [],
            template_id: text[channel].template || null, ...(original ? { revision: original.revision } : {}),
          }, !!original);
          const settings = configuration.channels.find((c) => c.channel === channel);
          result.push({ input, unresolved: [...new Set([...body.unresolved, ...subject.unresolved])],
            provider: original ? original.provider : settings?.provider ?? null,
            sender: original ? original.sender_address : channel === "email" ? settings?.from_address ?? null : settings?.sending_phone_number ?? null });
        }
      }
      if (!result.length) throw new Error("Select Email, SMS, or both.");
      setPreviews(result);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to preview Draft."); }
  }
  async function save(index: number) {
    if (!previews || previews[index].attempted) return;
    const preview = previews[index];
    let input: CommunicationDraft;
    try { input = parseCommunicationDraft(preview.input, !!original); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Invalid Draft content."); return; }
    setPreviews(previews.map((p, i) => i === index ? { ...p, attempted: true } : p));
    await task(async () => {
      const result = await readJson<{ id: string; status: string }>(original ? `/api/communications/${original.id}` : "/api/communications",
        { method: original ? "PATCH" : "POST", body: JSON.stringify(input) });
      if (result.status !== "Draft") throw new Error("The server did not confirm a Draft.");
      setPreviews((current) => current?.map((p, i) => i === index ? { ...p, id: result.id, attempted: true } : p) ?? null);
      setNotice(`Draft saved: ${result.id}. Nothing was sent.`); onSaved();
    });
  }
  function toggle(channel: CommunicationChannel, contact: ComposeContact, checked: boolean) {
    setSelected({ ...selected, [channel]: checked ? [...selected[channel], key(contact)] : selected[channel].filter((id) => id !== key(contact)) });
  }
  return <section aria-label="Communications compose" className="space-y-4 rounded border border-slate-300 bg-white p-4">
    <header className="flex justify-between gap-3"><h2 className="font-semibold">{original ? "Edit Draft" : "New Communication"}</h2><button type="button" className={button} disabled={busy} onClick={onClose}>Close Composer</button></header>
    <p className="text-sm text-slate-500">Manual Drafts only. New messages create one authoritative Draft per recipient/channel for exact personalization. Preview never transmits. Sending is unavailable.</p>
    {error ? <p role="alert" className="text-sm text-red-700">{error}{previews?.some((p) => p.attempted && !p.id) ? " Save was not confirmed. Check Communication Logs before composing again; automatic retry is disabled to avoid duplicates." : ""}</p> : null}
    {notice ? <p role="status" className="text-sm text-green-700">{notice}</p> : null}
    {!ready && !error ? <p>Loading composition data...</p> : null}
    {ready && !previews ? <fieldset disabled={busy} className="space-y-4">
      <div className="flex gap-4">{(["email", "sms"] as const).map((channel) => <label key={channel} className="flex gap-2 text-sm"><input type="checkbox" disabled={!!original} checked={channels.includes(channel)} onChange={(event) => setChannels(event.target.checked ? [...channels, channel] : channels.filter((c) => c !== channel))} />{channel === "email" ? "Email" : "SMS"}</label>)}</div>
      {original ? <div className="space-y-2 text-sm">
        <p>Saved recipient snapshots: {original.recipients.map((r) => `${r.recipient_name} (${original.channel === "email" ? r.email : r.mobile_phone})`).join("; ")}</p>
        <label className="flex gap-2"><input type="checkbox" checked={reselect} onChange={(event) => {
          const checked = event.target.checked;
          setReselect(checked); setSelected({ email: [], sms: [] });
          if (checked && contractorAllowed) void task(async () => {
            const rows = await Promise.all(contractors.map((c) => composeRows<ComposeContact>("contacts", { contractor_id: String(c.id) })));
            setContacts((current) => [...current.filter((c) => c.type === "dobco_contact"), ...rows.flat()]);
          });
        }} />Deliberately reselect/refresh recipients from current contacts</label>
        <p className="text-xs text-slate-500">Contact changes never silently refresh saved snapshots. The channel and existing business relationships remain preserved while editing.</p>
      </div> : null}
      {!original || reselect ? <>
        {contractorAllowed ? <section className="space-y-2" aria-label="Contractor selection">
          <label className="block text-sm">Search Contractors<input className={control} value={contractorSearch} onChange={(event) => setContractorSearch(event.target.value)} /></label>
          <button type="button" className={button} onClick={() => void task(async () => setContractorResults(await composeRows<Contractor>("contractors", { search: contractorSearch })))}>Search Contractors</button>
          <div className="flex flex-wrap gap-2">{contractorResults.map((c) => <button type="button" key={c.id} className={button} disabled={contractors.some((current) => current.id === c.id)} onClick={() => void addContractor(c)}>Select {c.company_name}</button>)}</div>
        </section> : <p className="text-xs">Contractors View is required for contractor selection.</p>}
        {channels.map((channel) => <section key={channel} className="space-y-2 rounded border p-3" aria-label={`${channel} recipients`}>
          <h3 className="font-medium">{channel === "email" ? "Email" : "SMS"} Recipients</h3>
          {internalAllowed ? <button className={button} type="button" onClick={() => {
            const eligible = contacts.filter((c) => c.type === "dobco_contact" && composeEligibility(c, channel)).map(key);
            const ids = [...new Set([...selected[channel], ...eligible])];
            if (ids.length > 100) { setError("Select All exceeds 100 recipients. Select a smaller group explicitly."); return; }
            setSelected({ ...selected, [channel]: ids });
          }}>Select All Eligible Dobco Contacts</button> : <p className="text-xs">Settings View is required for Dobco Contacts.</p>}
          {contacts.map((contact) => <label key={key(contact)} className={`block rounded p-1 text-sm ${!composeEligibility(contact, channel) ? "text-slate-400" : ""}`}>
            <input type="checkbox" className="mr-2" checked={selected[channel].includes(key(contact))} disabled={!composeEligibility(contact, channel)} onChange={(event) => toggle(channel, contact, event.target.checked)} />
            {contact.contact_name} · {contact.type === "dobco_contact" ? "Dobco Contact" : contractors.find((c) => c.id === contact.contractor_id)?.company_name}
            <span className="block pl-5 text-xs">{contact.is_active ? "Active" : "Inactive"}; Email {contact.email || "unavailable"}; Mobile {contact.mobile_phone || "unavailable"}; Receive {contact.type === "dobco_contact" ? "Internal" : "Compliance"} Email: {contact.receives_email ? "Yes" : "No"}; Receive SMS: {contact.receives_sms ? "Yes" : "No"}; SMS consent: {contact.sms_consent_recorded ? "recorded" : "not recorded"}</span>
          </label>)}
        </section>)}
      </> : null}
      <section className="space-y-2 text-sm" aria-label="Related records">
        <h3 className="font-medium">Related Contractors</h3>
        {contractors.map((c) => <div key={c.id}>{c.company_name}{!original ? <button type="button" className={`${button} ml-2`} onClick={() => {
          const removed = contacts.filter((contact) => contact.contractor_id === c.id).map(key);
          setContractors(contractors.filter((current) => current.id !== c.id)); setContacts(contacts.filter((contact) => contact.contractor_id !== c.id));
          setSelected({ email: selected.email.filter((id) => !removed.includes(id)), sms: selected.sms.filter((id) => !removed.includes(id)) });
          setCompliance(compliance.filter((r) => r.contractor_id !== c.id)); if (record?.contractor_id === c.id) setRecord(null);
        }}>Remove {c.company_name}</button> : null}</div>)}
        <h3 className="font-medium">Related Projects</h3>
        {projects.map((p) => <div key={p.id}>{p.project_number} - {p.project_name}{!original ? <button type="button" className={`${button} ml-2`} onClick={() => setProjects(projects.filter((current) => current.id !== p.id))}>Remove Project {p.project_number}</button> : null}</div>)}
        {projectAllowed && !original ? <>
          <label className="block">Search Projects<input className={control} value={projectSearch} onChange={(event) => setProjectSearch(event.target.value)} /></label>
          <button type="button" className={button} onClick={() => void task(async () => setProjectResults(await composeRows<Project>("projects", { search: projectSearch })))}>Search Projects</button>
          <div className="flex flex-wrap gap-2">{projectResults.map((p) => <button type="button" key={p.id} className={button} disabled={projects.some((current) => current.id === p.id)} onClick={() => setProjects([...projects, p])}>Select {p.project_number} - {p.project_name}</button>)}</div>
        </> : null}
        {complianceAllowed && !original ? <div><label className="block" htmlFor="compose-compliance">Compliance Context (optional)</label>
          <select id="compose-compliance" className={control} value={record?.compliance_record_id ?? ""} onChange={(event) => setRecord(compliance.find((r) => String(r.compliance_record_id) === event.target.value) ?? null)}>
            <option value="">No compliance context</option>{compliance.map((r) => <option key={r.compliance_record_id} value={r.compliance_record_id}>{contractors.find((c) => c.id === r.contractor_id)?.company_name} - {r.compliance_name} - {r.calculated_status}</option>)}
          </select></div> : null}
      </section>
      {channels.map((channel) => <section key={channel} className="space-y-2 rounded border p-3" aria-label={`${channel} editor`}>
        <h3 className="font-medium">{channel === "email" ? "Email" : "SMS"} Message</h3>
        <div><label className="block text-sm" htmlFor={`compose-${channel}-template`}>Template</label>
          <select id={`compose-${channel}-template`} className={control} value={text[channel].template} disabled={!!original} onChange={(event) => {
            const template = templates.find((t) => t.id === event.target.value);
            setText({ ...text, [channel]: template ? { subject: template.subject ?? "", body: template.body, template: template.id } : { ...text[channel], template: "" } });
          }}><option value="">No template</option>{text[channel].template && !templates.some((t) => t.id === text[channel].template) ? <option value={text[channel].template}>Saved template reference (unavailable/inactive)</option> : null}
            {templates.filter((t) => t.channel === channel).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </div>
        {channel === "email" ? <label className="block text-sm">Email Subject<input className={control} maxLength={1000} value={text.email.subject} onChange={(event) => setText({ ...text, email: { ...text.email, subject: event.target.value } })} /></label> : null}
        <label className="block text-sm" htmlFor={`compose-${channel}-body`}>{channel === "email" ? "Email" : "SMS"} Body</label>
        <textarea id={`compose-${channel}-body`} className={`${control} min-h-32`} maxLength={100000} value={text[channel].body} onChange={(event) => setText({ ...text, [channel]: { ...text[channel], body: event.target.value } })} />
      </section>)}
      <button type="button" className={button} onClick={buildPreview}>Preview Drafts</button>
    </fieldset> : null}
    {previews ? <section aria-label="Draft preview" className="space-y-4">
      <h3 className="font-semibold">Preview — nothing is sent</h3>
      <p className="text-sm">Related Contractors: {contractors.map((c) => c.company_name).join("; ") || "None"}</p>
      <p className="text-sm">Related Projects: {projects.map((p) => `${p.project_number} - ${p.project_name}`).join("; ") || "None"}</p>
      {previews.map((p, index) => <article key={index} className="space-y-2 rounded border p-3 text-sm" aria-label={`Draft ${index + 1}`}>
        <p>Channel: {p.input.channel} · Status: Draft</p><p>To: {p.input.recipients.map((r) => `${r.recipient_name} (${p.input.channel === "email" ? r.email : r.mobile_phone})`).join("; ")}</p>
        <p>Intended Provider: {p.provider ?? "Not Configured"}{p.provider === "twilio" ? " — Connector Not Implemented" : ""}; From: {p.sender ?? "Not Configured"}</p>
        {p.input.channel === "email" ? <label className="block">Final Subject<input className={control} value={p.input.subject ?? ""} disabled={p.attempted || busy} onChange={(event) => setPreviews(previews.map((current, i) => i === index ? { ...current, input: { ...current.input, subject: event.target.value }, unresolved: [...new Set([...renderMessage(event.target.value, {}).unresolved, ...renderMessage(current.input.body, {}).unresolved])] } : current))} /></label> : null}
        <label className="block" htmlFor={`preview-body-${index}`}>Exact Final Message</label>
        <textarea id={`preview-body-${index}`} className={`${control} min-h-32 whitespace-pre-wrap`} value={p.input.body} disabled={p.attempted || busy} onChange={(event) => setPreviews(previews.map((current, i) => i === index ? { ...current, input: { ...current.input, body: event.target.value }, unresolved: [...new Set([...renderMessage(event.target.value, {}).unresolved, ...renderMessage(current.input.subject ?? "", {}).unresolved])] } : current))} />
        {p.unresolved.length ? <p role="alert" className="text-amber-800">Unresolved fields: {p.unresolved.join(", ")}. Supply context or edit the final message. This Draft is not ready for future sending.</p> : null}
        <div className="flex gap-2"><button type="button" className={button} disabled={busy || p.attempted} onClick={() => void save(index)}>{p.id ? "Draft Saved" : "Save Draft"}</button><button type="button" className={button} disabled>Send Unavailable</button></div>
        {p.id ? <p>Communication ID: {p.id} · Draft (not sent)</p> : null}
      </article>)}
      <button type="button" className={button} disabled={busy || previews.some((p) => p.attempted)} onClick={() => setPreviews(null)}>Back to Editor</button>
    </section> : null}
  </section>;
}
