"use client";

import { useState } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { readJson } from "@/lib/communication-compose-client";
import { composeEligibility } from "@/lib/communication-templates";
import type { ComposeContact, ComposeOptions } from "@/types/communication-compose";
import type { RequirementRule } from "@/types/requirement-notifications";

type Contractor = ComposeOptions["contractors"][number];
type Project = ComposeOptions["projects"][number];
type Preview = {
  company_name: string; dba_name: string | null; contact_name: string; contact_email: string;
  requirement_name: string; expiration_date: string; days_remaining: number;
  project_number: string | null; project_name: string | null; sender_name: string | null; sender_address: string | null;
  template_revision: number; subject: string; body: string; unresolved: string[]; duplicate: boolean; other_recipient_sent: boolean;
  snapshot: Record<string, unknown>;
};
const button = "rounded border border-slate-300 px-2 py-1 text-sm disabled:opacity-50";

export default function RequirementNoticePreview({ rules }: { rules: RequirementRule[] }) {
  const { permissions } = useSessionProfile();
  const canCompose = canAccessModule(permissions, "communications_content", "add") || canAccessModule(permissions, "communications_content", "edit");
  const canContractors = canAccessModule(permissions, "contractors");
  const canDelivery = canAccessModule(permissions, "communications_delivery");
  const canSend = canAccessModule(permissions, "communications_delivery", "manage");
  const canAdd = canAccessModule(permissions, "communications_content", "add");
  const canProjects = canAccessModule(permissions, "projects");
  const [rule, setRule] = useState("");
  const [search, setSearch] = useState("");
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [contractor, setContractor] = useState("");
  const [contacts, setContacts] = useState<ComposeContact[]>([]);
  const [contact, setContact] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isTest, setIsTest] = useState(true);
  const [draft, setDraft] = useState<{ id: string; revision: number; isTest: boolean; subject: string; body: string; recipient: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [sendSubmitted, setSendSubmitted] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function run(action: () => Promise<void>) {
    setBusy(true); setError(""); setPreview(null); setDraft(null); setConfirmed(false); setSendSubmitted(false); setStatus("");
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to generate preview."); }
    finally { setBusy(false); }
  }
  if (!canCompose || !canContractors || !canDelivery) return <p className="text-sm">Contractors View, Communications Delivery View and Communications Content Add or Edit permissions are required for notice selection and duplicate history.</p>;
  return <section aria-label="Requirement notice preview" className="space-y-3 rounded border p-3 text-sm">
    <h3 className="font-semibold">Requirement Notice Preview</h3>
    <p>Preview only. The configured eligibility, current requirement, approved template and exact interval are rechecked. No message is sent or scheduled.</p>
    {error ? <p role="alert">{error}</p> : null}
    <label className="block">Requirement <select value={rule} disabled={busy} onChange={event => { setRule(event.target.value); setPreview(null); }}>
      <option value="">Select requirement</option>{rules.filter(item => item.id && !item.retired).map(item => <option key={item.id} value={item.id!}>{item.name}</option>)}
    </select></label>
    <label className="block">Search Contractors <input value={search} disabled={busy} onChange={event => setSearch(event.target.value)} /></label>
    <button type="button" className={button} disabled={busy || !search.trim()} onClick={() => void run(async () => {
      const page = await readJson<{ rows: Contractor[]; next_offset: number | null }>(`/api/communications/compose-options?${new URLSearchParams({ kind: "contractors", search: search.trim(), offset: "0" })}`);
      setContractors([]); setContractor(""); setContact(""); setContacts([]); setProject("");
      if (page.next_offset !== null) throw new Error("More than 50 matches; narrow the contractor search.");
      setContractors(page.rows);
    })}>Search</button>
    <label className="block">Contractor <select value={contractor} disabled={busy} onChange={event => {
      const id = event.target.value; setContractor(id); setContact(""); setContacts([]); setProject(""); setPreview(null);
      if (id) void run(async () => {
        const page = await readJson<{ rows: ComposeContact[]; next_offset: number | null }>(`/api/communications/compose-options?${new URLSearchParams({ kind: "contacts", contractor_id: id, offset: "0" })}`);
        if (page.next_offset !== null) throw new Error("More than 50 contacts; unable to safely display this contractor's contacts.");
        setContacts(page.rows);
      });
    }}><option value="">Select contractor</option>{contractors.map(item => <option key={item.id} value={item.id}>{item.company_name}{item.dba_name ? ` (DBA ${item.dba_name})` : ""}</option>)}</select></label>
    <label className="block">Contractor Contact <select value={contact} disabled={busy} onChange={event => { setContact(event.target.value); setPreview(null); }}>
      <option value="">Select contact</option>{contacts.filter(item => composeEligibility(item, "email")).map(item => <option key={item.id} value={item.id}>{item.contact_name} ({item.email})</option>)}
    </select></label>
    {canProjects ? <>
      <label className="block">Search Projects (optional) <input value={projectSearch} disabled={busy} onChange={event => setProjectSearch(event.target.value)} /></label>
      <button type="button" className={button} disabled={busy || !projectSearch.trim()} onClick={() => void run(async () => {
        const page = await readJson<{ rows: Project[]; next_offset: number | null }>(`/api/communications/compose-options?${new URLSearchParams({ kind: "projects", search: projectSearch.trim(), offset: "0" })}`);
        setProjects([]); setProject("");
        if (page.next_offset !== null) throw new Error("More than 50 matches; narrow the project search.");
        setProjects(page.rows);
      })}>Search Projects</button>
      <label className="block">Project (optional) <select value={project} disabled={busy} onChange={event => { setProject(event.target.value); setPreview(null); }}>
        <option value="">No project</option>{projects.map(item => <option key={item.id} value={item.id}>{item.project_number} - {item.project_name}</option>)}
      </select></label>
    </> : null}
    <button type="button" className={button} disabled={busy || !rule || !contractor || !contact} onClick={() => void run(async () => {
      const result = await readJson<{ preview: Preview; execution_enabled: false }>("/api/admin/notifications/requirements/preview", {
        method: "POST", body: JSON.stringify({ rule_id: rule, contractor_id: Number(contractor), contact_id: contact, project_id: project ? Number(project) : null }),
      });
      if (result.execution_enabled !== false || !result.preview) throw new Error("Preview was not confirmed.");
      setPreview(result.preview); setIsTest(true); setSubject(`[TEST] ${result.preview.subject}`); setBody(result.preview.body);
    })}>Generate Preview</button>
    {preview ? <article aria-label="Personalized notice preview" className="space-y-2 rounded border p-3">
      <p>Intended recipient: {preview.contact_name} ({preview.contact_email})</p>
      <p>This preview sends nothing. A Test Send uses only the approved test address and does not satisfy the notice interval.</p>
      <p>Company: {preview.company_name}{preview.dba_name ? ` · DBA: ${preview.dba_name}` : ""}</p>
      <p>{preview.requirement_name} · Expires {preview.expiration_date} · {preview.days_remaining} days remaining</p>
      {preview.project_number ? <p>Project: {preview.project_number} - {preview.project_name}</p> : null}
      <p>Sender: {preview.sender_name ?? "Not configured"} ({preview.sender_address ?? "Not configured"}) · Template revision {preview.template_revision}</p>
      {preview.duplicate ? <p role="alert">This interval is already associated with a sent or in-progress notice, or a notice with an unknown delivery outcome, for this contact.</p> : null}
      {preview.other_recipient_sent ? <p role="status">This interval was previously sent to another contact.</p> : null}
      {preview.unresolved.length ? <p role="alert">Unresolved fields: {preview.unresolved.join(", ")}. Separate first names are not stored and are not guessed.</p> : null}
      {!draft && canAdd ? <>
        <label className="block"><input type="checkbox" checked={isTest} disabled={busy} onChange={event => setIsTest(event.target.checked)} /> Test Send (actual recipient: richg@dobcogroup.com)</label>
        {!isTest ? <p role="alert">This is a real notice to the intended contractor contact and can satisfy the interval.</p> : null}
        <label className="block">Final subject <input className="block w-full rounded border px-2 py-1" value={subject} disabled={busy} onChange={event => setSubject(event.target.value)} /></label>
        <label className="block">Final body <textarea className="block w-full rounded border px-2 py-1" rows={8} value={body} disabled={busy} onChange={event => setBody(event.target.value)} /></label>
        <p>Resolve any remaining placeholders before saving. Test subjects must start with [TEST].</p>
        <button type="button" className={button} disabled={busy || (!isTest && preview.duplicate) || !subject.trim() || !body.trim()
          || subject.includes("{{") || subject.includes("}}") || body.includes("{{") || body.includes("}}") || (isTest && !subject.startsWith("[TEST]"))}
          onClick={() => void (async () => {
            setBusy(true); setError("");
            try {
              const saved = await readJson<{ id: string; revision: number; status: string }>("/api/admin/notifications/requirements/draft", {
                method: "POST", body: JSON.stringify({ rule_id: rule, contractor_id: Number(contractor), contact_id: contact,
                  project_id: project ? Number(project) : null, preview: preview.snapshot, subject, body, is_test: isTest }),
              });
              if (!saved.id || saved.status !== "Draft" || saved.revision !== 1) throw new Error("Draft creation was not confirmed. Check history before retrying.");
              setDraft({ id: saved.id, revision: saved.revision, isTest, subject, body, recipient: isTest ? "richg@dobcogroup.com" : preview.contact_email });
            } catch (reason) { setError(reason instanceof Error ? reason.message : "Draft creation failed. Check history before retrying."); }
            finally { setBusy(false); }
          })()}>Save Notice Draft for Review</button>
      </> : null}
      {draft ? <section aria-label="Review notice send" className="space-y-2 rounded border p-3">
        <p>Draft {draft.id} · Revision {draft.revision} · Test Send: {draft.isTest ? "Yes" : "No"}</p>
        <p>Intended: {preview.contact_name} ({preview.contact_email}) · Actual recipient: {draft.recipient}</p>
        <p>Subject: {draft.subject}</p><p className="whitespace-pre-wrap">{draft.body}</p>
        {canSend ? <>
          <label className="block"><input type="checkbox" checked={confirmed} disabled={busy || sendSubmitted} onChange={event => setConfirmed(event.target.checked)} /> I reviewed the actual recipient, subject and final body.</label>
          <button type="button" className={button} disabled={!confirmed || busy || sendSubmitted}
            onClick={() => void (async () => {
              setBusy(true); setError(""); setSendSubmitted(true);
              try {
                const result = await readJson<{ communication_id: string; status: string; graph_acceptance: string }>(
                  `/api/communications/${encodeURIComponent(draft.id)}/send`,
                  { method: "POST", body: JSON.stringify({ confirmed: true, revision: draft.revision }) });
                if (result.communication_id !== draft.id || result.status !== "Sent" || result.graph_acceptance !== "Accepted") throw new Error("Send outcome was not confirmed. Review history and mailbox; do not retry automatically.");
                setStatus("Accepted by Microsoft Graph. Acceptance does not confirm delivery; review Communication History.");
              } catch (reason) { setError(`${reason instanceof Error ? reason.message : "Send failed."} Review history and mailbox before any further action; do not retry automatically.`); }
              finally { setBusy(false); }
            })()}>Confirm and Send Notice</button>
        </> : <p>Communications Delivery Manage permission is required to send.</p>}
        {status ? <p role="status">{status}</p> : null}
      </section> : null}
    </article> : null}
  </section>;
}
