"use client";

import { useEffect, useRef, useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { CommunicationRequestError, composeRows, readJson } from "@/lib/communication-compose-client";
import { parseCommunicationDraft } from "@/lib/communications";
import type { CommunicationDraft, RecipientSnapshot } from "@/types/communications";
import type { ComposeCompliance, ComposeOptions, EditableDraft, MessageTemplate } from "@/types/communication-compose";
import type { EmailAssessment, EmailChoice, EmailConfiguration, RecipientRole } from "@/types/email-workspace";
import type { ScheduledEmailStatus } from "@/types/scheduled-email";
import styles from "./email-workspace.module.css";

type Props = { draftId?: string; active?: boolean; onClose: () => void; onSaved: () => void };
const addressKey = (r: RecipientSnapshot) => r.email?.toLowerCase() ?? `${r.recipient_type}:${r.contractor_contact_id ?? r.dobco_contact_id}`;
const emptyRelationships = { contractor_ids: [], project_ids: [], compliance_record_ids: [], mycoi_policy_ids: [], insurance_items: [] };

export default function EmailComposer({ draftId, active = true, onClose, onSaved }: Props) {
  const { permissions } = useSessionProfile();
  const canSend = canAccessModule(permissions, "communications_delivery", "manage");
  const [config, setConfig] = useState<EmailConfiguration | null>(null);
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [saved, setSaved] = useState<{ id: string; revision: number } | null>(null);
  const [original, setOriginal] = useState<EditableDraft | null>(null);
  const [recipients, setRecipients] = useState<RecipientSnapshot[]>([]);
  const [role, setRole] = useState<RecipientRole>("to");
  const [secondary, setSecondary] = useState(false);
  const [search, setSearch] = useState("");
  const [choices, setChoices] = useState<EmailChoice[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchNotice, setSearchNotice] = useState("");
  const [group, setGroup] = useState<EmailChoice | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [template, setTemplate] = useState("");
  const [templateRevision, setTemplateRevision] = useState<number | undefined>();
  const [contractors, setContractors] = useState<ComposeOptions["contractors"]>([]);
  const [projects, setProjects] = useState<ComposeOptions["projects"]>([]);
  const [record, setRecord] = useState<ComposeCompliance | null>(null);
  const [relatedOpen, setRelatedOpen] = useState(false);
  const [relatedKind, setRelatedKind] = useState<"projects" | "contractors" | "compliance">("projects");
  const [relatedSearch, setRelatedSearch] = useState("");
  const [relatedChoices, setRelatedChoices] = useState<(ComposeOptions["projects"][number] | ComposeOptions["contractors"][number] | ComposeCompliance)[]>([]);
  const [assessment, setAssessment] = useState<EmailAssessment | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [timeZone, setTimeZone] = useState("local");
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const savedContent = useRef<string | null>(null);
  const firstActive = useRef(true);
  const modal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!assessment && !scheduleOpen) return;
    const previous = document.activeElement;
    const first = modal.current?.querySelector<HTMLElement>("input,select,button");
    first?.focus();
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, [assessment, scheduleOpen]);
  function modalKeys(event: React.KeyboardEvent) {
    if (busy) { if (event.key === "Escape") event.preventDefault(); return; }
    if (event.key === "Escape") { setAssessment(null); setScheduleOpen(false); }
    if (event.key !== "Tab") return;
    const items = modal.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)");
    if (!items?.length) return;
    if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items[items.length - 1].focus(); }
    if (!event.shiftKey && document.activeElement === items[items.length - 1]) { event.preventDefault(); items[0].focus(); }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([
      readJson<EmailConfiguration>("/api/communications/compose-options"),
      composeRows<MessageTemplate>("templates"),
      draftId ? readJson<{ draft: EditableDraft }>(`/api/communications/${draftId}/draft`) : Promise.resolve(null),
    ]).then(([configuration, available, draft]) => {
      if (!active) return;
      setConfig(configuration); setTemplates(available.filter(t => t.channel === "email"));
      if (draft) {
        const d = draft.draft;
        if (d.channel !== "email") throw new Error("Open this message in Text Messaging.");
        setOriginal(d); setSaved({ id: d.id, revision: d.revision }); setRecipients(d.recipients);
        setSubject(d.subject ?? ""); setBody(d.body); setTemplate(d.template_id ?? "");
        setTemplateRevision(d.template_revision); setContractors(d.related_contractors); setProjects(d.related_projects);
        setSecondary(d.recipients.some(r => r.recipient_role && r.recipient_role !== "to"));
      }
    }).catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "Unable to load message."); });
    return () => { active = false; };
  }, [draftId]);
  useEffect(() => {
    if (firstActive.current) { firstActive.current = false; return; }
    if (!active) return;
    let current = true;
    void readJson<EmailConfiguration>("/api/communications/compose-options")
      .then(configuration => { if (current) setConfig(configuration); })
      .catch(reason => { if (current) { setConfig(null); setError(reason instanceof Error ? reason.message : "Unable to verify Email settings."); } });
    return () => { current = false; };
  }, [active]);

  useEffect(() => {
    if (!searchOpen) return;
    let active = true;
    const timer = setTimeout(() => {
      const query = new URLSearchParams({ search,
        ...(group?.contractor_id ? { contractor_id: String(group.contractor_id) } : {}),
        ...(group?.project_id ? { project_id: String(group.project_id) } : {}),
      });
      void readJson<{ rows: EmailChoice[]; notice?: string }>(`/api/communications/email-recipients?${query}`)
        .then(result => { if (active) { setChoices(result.rows); setSearchNotice(result.notice ?? ""); } })
        .catch(reason => { if (active) { setChoices([]); setError(reason instanceof Error ? reason.message : "Recipient search failed."); } });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [search, searchOpen, group]);

  function addRecipient(choice: EmailChoice) {
    if (!choice.recipient) { setGroup(choice); setSearch(""); return; }
    if (recipients.some(r => addressKey(r) === addressKey(choice.recipient!))) {
      setError("This address is already selected in To, Cc or Bcc."); return;
    }
    if (recipients.length >= 100) { setError("Select at most 100 recipients across To, Cc and Bcc."); return; }
    if (choice.contractor_id && !contractors.some(c => c.id === choice.contractor_id)) {
      setContractors(current => [...current, { id: choice.contractor_id!, company_name: choice.company_name ?? `Contractor #${choice.contractor_id}` }]);
    }
    setRecipients(current => [...current, { ...choice.recipient!, recipient_role: role }]);
    setSearch(""); setError(""); setSearchOpen(false); setGroup(null);
  }
  async function task(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try { await action(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update message."); }
    finally { lock.current = false; setBusy(false); }
  }
  function input(): CommunicationDraft {
    return parseCommunicationDraft({
      ...emptyRelationships,
      channel: "email", subject, body, recipients, contractor_ids: contractors.map(c => c.id), project_ids: projects.map(p => p.id),
      compliance_record_ids: record ? [record.compliance_record_id] : original?.compliance_record_ids ?? [],
      mycoi_policy_ids: original?.mycoi_policy_ids ?? [], insurance_items: original?.insurance_items ?? [],
      followup_ids: original?.followup_ids ?? [], compliance_type_ids: original?.compliance_type_ids ?? [],
      communication_type: original?.communication_type ?? templates.find(t => t.id === template)?.category ?? "General Contractor Communication",
      template_id: template || null, ...(templateRevision ? { template_revision: templateRevision } : {}),
      ...(saved ? { revision: saved.revision } : {}),
    } satisfies Record<string, unknown>, Boolean(saved));
  }
  async function persist(draft: CommunicationDraft) {
    const fingerprint = JSON.stringify({ ...draft, revision: undefined });
    if (saved && savedContent.current === fingerprint) return { ...saved, status: "Draft" };
    try {
      const result = await readJson<{ id: string; revision: number; status: string }>(saved ? `/api/communications/${saved.id}` : "/api/communications",
        { method: saved ? "PATCH" : "POST", body: JSON.stringify({ ...draft, ...(saved ? { revision: saved.revision } : {}) }) });
      if (result.status !== "Draft" || !result.id || !Number.isSafeInteger(result.revision) || result.revision < 1) throw new Error("Draft revision was not confirmed.");
      savedContent.current = fingerprint;
      setSaved({ id: result.id, revision: result.revision }); onSaved(); return result;
    } catch (reason) {
      if (reason instanceof CommunicationRequestError && reason.status < 500) throw reason;
      setAttempted(true);
      throw new Error(`${reason instanceof Error ? reason.message : "Draft save failed."} Check Drafts before starting another message; do not retry an uncertain save.`);
    }
  }
  async function assess() {
    return readJson<EmailAssessment>("/api/communications/email-assessment", { method: "POST", body: JSON.stringify(input()) });
  }
  async function deliver(result: EmailAssessment) {
    const eligible = result.draft.recipients.filter(r => result.exclusions.some(e => e.email.toLowerCase() === r.email?.toLowerCase() && e.reason === null));
    if (!eligible.length) throw new Error(result.exclusions.map(e => e.reason).filter(Boolean).join(" ") || "No eligible recipients.");
    setAssessment(null);
    const draft = await persist({ ...result.draft, recipients: eligible });
    // A provider outcome may be unknown. Never offer an automatic second submission.
    setAttempted(true);
    const sent = await readJson<{ communication_id: string; status: string; graph_acceptance: string; delivered: boolean }>(
      `/api/communications/${draft.id}/send`, { method: "POST", body: JSON.stringify({ revision: draft.revision, confirmed: true }) });
    if (sent.communication_id !== draft.id || sent.status !== "Sent" || sent.graph_acceptance !== "Accepted" || sent.delivered !== false) {
      throw new Error("Sending was not confirmed. Check Sent and delivery history before any further action; do not retry.");
    }
    setSubject(result.draft.subject ?? ""); setBody(result.draft.body);
    setNotice("Sent. The message is recorded in Sent; mailbox acceptance does not confirm delivery."); onSaved();
  }
  function send() {
    void task(async () => {
      const result = await assess();
      if (result.draft.recipients.length > 1) setAssessment(result);
      else await deliver(result);
    });
  }
  async function saveDraft() {
    await task(async () => { await persist(input()); setNotice("Draft saved. Nothing was sent."); });
  }
  async function schedule() {
    await task(async () => {
      if (!date || !time) throw new Error("Choose a date and time.");
      const instant = new Date(`${date}T${time}${timeZone === "UTC" ? "Z" : ""}`);
      if (!Number.isFinite(instant.getTime()) || instant.getTime() <= Date.now()) throw new Error("Choose a future date and time.");
      const result = await assess();
      const draft = await persist(result.draft);
      setAttempted(true); setScheduleOpen(false);
      const planned = await readJson<{ id: string; execution_enabled: boolean; status: string; scheduling: ScheduledEmailStatus }>(`/api/communications/${draft.id}/plan`,
        { method: "POST", body: JSON.stringify({ action: "schedule", revision: draft.revision, scheduled_at: instant.toISOString() }) });
      if (planned.id !== draft.id || typeof planned.execution_enabled !== "boolean" || planned.status !== "Scheduled"
        || !planned.scheduling || typeof planned.scheduling.notice !== "string") throw new Error("Scheduling was not confirmed. Check Scheduled before trying again.");
      setNotice(`Scheduled for ${instant.toLocaleString()} (${timeZone === "UTC" ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone}). ${planned.scheduling.notice}`); onSaved();
    });
  }
  async function findRelated() {
    await task(async () => {
      if (relatedKind === "compliance" && contractors.length !== 1) throw new Error("Select one related contractor before choosing a compliance record.");
      setRelatedChoices(await composeRows(relatedKind, relatedKind === "compliance"
        ? { contractor_id: String(contractors[0].id) } : { search: relatedSearch }));
    });
  }
  const unavailable = !config?.email_controls?.available;
  const sendReady = config?.channels.find(c => c.channel === "email")?.manual_send_ready;
  const eligibleCount = assessment ? assessment.exclusions.filter(e => !e.reason).length : 0;
  return <section className={styles.composer} aria-label="Email composer">
    <header className={styles.panelHeader}><div><h2>{draftId ? "Edit draft" : "New Message"}</h2><p>Write to Dobco and contractor contacts in one place.</p></div>
      <button type="button" className={styles.secondary} onClick={onClose}>Close</button></header>
    {unavailable && config ? <p className={styles.warning} role="status">{config.email_controls?.notice ?? "Email workspace controls are unavailable."}</p> : null}
    {error ? <p className={styles.error} role="alert">{error}</p> : null}
    {notice ? <p className={styles.success} role="status">{notice}</p> : null}
    <fieldset disabled={busy || attempted} className={styles.fields}>
      {(["to", ...(secondary ? ["cc", "bcc"] : [])] as RecipientRole[]).map(r => <div className={styles.addressRow} key={r}>
        <label htmlFor={`email-${r}`}>{r === "to" ? "To" : r === "cc" ? "Cc" : "Bcc"}</label>
        <div className={styles.addresses}>
          {recipients.filter(c => (c.recipient_role ?? "to") === r).map(c => <span className={styles.chip} key={addressKey(c)} title={`${c.recipient_name} <${c.email}>`}>
            {c.recipient_name}<button type="button" aria-label={`Remove ${c.recipient_name} from ${r}`} onClick={() => setRecipients(current => current.filter(i => addressKey(i) !== addressKey(c)))}>x</button>
          </span>)}
          <input id={`email-${r}`} role="combobox" aria-autocomplete="list" aria-label={`${r === "to" ? "To" : r === "cc" ? "Cc" : "Bcc"} recipient search`}
            value={role === r ? search : ""} placeholder="Search people, companies or projects"
            onFocus={() => { setRole(r); setSearchOpen(true); setGroup(null); }} onChange={event => { setRole(r); setSearch(event.target.value); setGroup(null); setSearchOpen(true); }}
            onKeyDown={event => { if (event.key === "Escape") setSearchOpen(false); }}
            autoComplete="off" aria-expanded={searchOpen && role === r} aria-controls="email-recipient-results" />
        </div>
        {r === "to" ? <button type="button" className={styles.textButton} onClick={() => setSecondary(!secondary)}>{secondary ? "Hide Cc / Bcc" : "Cc / Bcc"}</button> : null}
      </div>)}
      {searchOpen ? <div id="email-recipient-results" className={styles.searchResults} aria-label="Recipient search results">
        <div className={styles.inline}>{group ? <strong>{group.label}</strong> : <small>{searchNotice || "Search existing contacts, companies and projects."}</small>}
          <button type="button" className={styles.textButton} onClick={() => { setSearchOpen(false); setGroup(null); }}>Done</button></div>
        {choices.length ? choices.map(c => <button type="button" key={c.key} onClick={() => addRecipient(c)} disabled={Boolean(c.recipient && !c.recipient.email)}>
          <strong>{c.label}</strong><small>{c.detail}</small>{c.exclusion_reason ? <small>{c.exclusion_reason}</small> : null}
        </button>) : <p>No matching recipients. Try another name or email address.</p>}
      </div> : null}
      <div className={styles.addressRow}><label htmlFor="email-subject">Subject</label><input id="email-subject" value={subject} maxLength={1000} onChange={e => setSubject(e.target.value)} /></div>
      <div className={styles.addressRow}><label htmlFor="email-template">Template</label><select id="email-template" value={template} onChange={e => {
        const selected = templates.find(t => t.id === e.target.value); setTemplate(e.target.value); setTemplateRevision(selected?.revision);
        if (selected) { setSubject(selected.subject ?? ""); setBody(selected.body); }
      }}><option value="">None</option>{original?.template_id && !templates.some(t => t.id === original.template_id) ? <option value={original.template_id}>Saved template (inactive)</option> : null}
        {templates.map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></div>
      <div className={styles.addressRow}><span className={styles.fieldLabel}>Related To</span><div className={styles.addresses}>
        {projects.map(p => <span key={p.id} className={styles.chip}>{p.project_number} - {p.project_name}<button type="button" aria-label={`Remove project ${p.project_number}`} onClick={() => setProjects(projects.filter(i => i.id !== p.id))}>x</button></span>)}
        {contractors.map(c => <span key={c.id} className={styles.chip}>{c.company_name}<button type="button" aria-label={`Remove contractor ${c.company_name}`} onClick={() => {
          if (recipients.some(r => r.recipient_type === "contractor_contact")) { setError("Remove contractor recipients before unlinking a contractor."); return; }
          setContractors(contractors.filter(i => i.id !== c.id)); setRecord(null);
        }}>x</button></span>)}
        {record ? <span className={styles.chip}>{record.compliance_name}<button type="button" aria-label="Remove compliance context" onClick={() => setRecord(null)}>x</button></span> : null}
        <button type="button" className={styles.textButton} onClick={() => setRelatedOpen(!relatedOpen)}>+ Add project, contractor or compliance item</button>
      </div></div>
      {relatedOpen ? <div className={styles.relatedPicker}>
        <div className={styles.inline}><select aria-label="Relationship type" value={relatedKind} onChange={e => { setRelatedKind(e.target.value as typeof relatedKind); setRelatedChoices([]); }}>
          {canAccessModule(permissions, "projects") ? <option value="projects">Project</option> : null}
          {canAccessModule(permissions, "contractors") ? <option value="contractors">Contractor</option> : null}
          {canAccessModule(permissions, "compliance") && canAccessModule(permissions, "contractors") ? <option value="compliance">Compliance record</option> : null}
        </select><input aria-label="Related record search" value={relatedSearch} onChange={e => setRelatedSearch(e.target.value)} /><button type="button" className={styles.secondary} onClick={() => void findRelated()}>Find</button></div>
        {relatedChoices.map((choice, index) => <button type="button" className={styles.relatedResult} key={index} onClick={() => {
          if ("project_number" in choice && !projects.some(p => p.id === choice.id)) setProjects([...projects, choice]);
          else if ("company_name" in choice && !contractors.some(c => c.id === choice.id)) setContractors([...contractors, choice]);
          else if ("compliance_record_id" in choice) setRecord(choice);
          setRelatedChoices([]); setRelatedOpen(false);
        }}>{"project_number" in choice ? `${choice.project_number} - ${choice.project_name}` : "company_name" in choice ? choice.company_name : `${choice.compliance_name} | ${choice.calculated_status}`}</button>)}
      </div> : null}
      <label className={styles.editorLabel} htmlFor="email-message">Message</label>
      <textarea id="email-message" className={styles.editor} value={body} maxLength={100000} onChange={e => setBody(e.target.value)} placeholder="Write your message..." />
    </fieldset>
    <footer className={styles.composerFooter}><span>{recipients.length} / 100 recipients</span><div className={styles.inline}>
      <button type="button" className={styles.secondary} disabled={busy || attempted || unavailable} onClick={() => void saveDraft()}>Save Draft</button>
      <button type="button" className={styles.secondary} disabled={busy || attempted || unavailable || !canSend} onClick={() => setScheduleOpen(true)}>Schedule</button>
      <button type="button" className={styles.primary} disabled={busy || attempted || unavailable || !canSend || !sendReady} onClick={send}>{busy ? "Working..." : "Send"}</button>
    </div></footer>
    {!canSend ? <p className={styles.hint}>Delivery Manage permission is required to send or schedule.</p> : !sendReady && !unavailable ? <p className={styles.hint}>Email sending is unavailable. Check Email Settings for enablement and connection verification.</p> : null}
    {assessment ? <div ref={modal} onKeyDown={modalKeys} className={styles.backdrop}><section role="dialog" aria-modal="true" aria-labelledby="email-bulk-title" className={styles.dialog}>
      <h3 id="email-bulk-title">Send this message to {assessment.draft.recipients.length} recipients?</h3>
      <p>{eligibleCount} eligible<br />{assessment.exclusions.length - eligibleCount} excluded by communication settings</p>
      {assessment.exclusions.filter(e => e.reason).map(e => <p key={e.email} className={styles.hint}>{e.email}: {e.reason}</p>)}
      <div className={styles.inline}><button type="button" autoFocus className={styles.secondary} onClick={() => setAssessment(null)}>Cancel</button>
        <button type="button" className={styles.primary} disabled={busy || !eligibleCount} onClick={() => void task(() => deliver(assessment))}>Send to {eligibleCount}</button></div>
    </section></div> : null}
    {scheduleOpen ? <div ref={modal} onKeyDown={modalKeys} className={styles.backdrop}><section role="dialog" aria-modal="true" aria-labelledby="email-schedule-title" className={styles.dialog}>
      <h3 id="email-schedule-title">Schedule</h3><p className={styles.warning}>{config?.scheduling?.notice ?? "Automatic delivery availability is not verified. Check Email Settings before relying on scheduled delivery."}</p>
      <label>Date<input type="date" autoFocus value={date} onChange={e => setDate(e.target.value)} /></label>
      <label>Time<input type="time" value={time} onChange={e => setTime(e.target.value)} /></label>
      <label>Time zone<select aria-label="Time zone" value={timeZone} onChange={e => setTimeZone(e.target.value)}><option value="local">{Intl.DateTimeFormat().resolvedOptions().timeZone} (local)</option><option value="UTC">UTC</option></select></label>
      <div className={styles.inline}><button type="button" className={styles.secondary} disabled={busy} onClick={() => setScheduleOpen(false)}>Cancel</button><button type="button" className={styles.primary} disabled={busy} onClick={() => void schedule()}>Schedule</button></div>
    </section></div> : null}
  </section>;
}
