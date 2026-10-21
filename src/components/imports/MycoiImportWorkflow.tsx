"use client";

import { useEffect, useState } from "react";
import { adminFetch } from "@/lib/admin-client";
import { useSessionProfile } from "@/components/SessionContext";
import { mycoiKey, safeEmail, safePhone } from "@/lib/mycoi-preview";
import styles from "./MycoiImportWorkflow.module.css";
import type { ImportDecisions, ImportPreview, ImportReference, MycoiImportRun } from "@/types/mycoi-import";

type Review = {
  run: MycoiImportRun; preview: ImportPreview; token: string;
  contractors: ImportReference["contractors"]; projects: ImportReference["projects"];
};
type History = Pick<MycoiImportRun, "id" | "file_name" | "created_at" | "updated_at" | "last_imported_at" | "status" | "metrics" | "source_row_count">;
const button = styles.button;
const primaryButton = `${button} ${styles.primary}`;
const secondaryButton = `${button} ${styles.secondary}`;
const select = "max-w-full rounded-lg border border-slate-300 bg-white p-2 text-sm";
const summaryLabels: Record<keyof ImportPreview["summary"], string> = {
  rowsRead: "Rows Read", uniqueVendors: "Unique Vendors", matchedVendors: "Matched Vendors", vendorsRequiringReview: "Vendors Requiring Review",
  matchedDivisions: "Matched Divisions", divisionsRequiringReview: "Divisions Requiring Review", policiesParsed: "Policies Parsed",
  policyParseErrors: "Policy Parse Errors", contactChanges: "Contact Changes", insuranceChanges: "Insurance Changes",
  readyRows: "Ready Rows", unresolvedRows: "Unresolved Rows", ignoredRows: "Ignored Rows",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await adminFetch(url, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "myCOI request failed.");
  return value as T;
}

export default function MycoiImportWorkflow() {
  const profile = useSessionProfile();
  const permitted = (module: string, write = false) => profile.system_administrator || profile.permissions.some((entry) =>
    entry.module === module && entry.can_view && (!write || (entry.can_add && entry.can_edit)));
  const canView = ["imports", "insurance", "contractors", "projects"].every((module) => permitted(module));
  const canWrite = permitted("imports", true) && permitted("insurance", true);
  const [review, setReview] = useState<Review | null>(null);
  const [decisions, setDecisions] = useState<ImportDecisions | null>(null);
  const [history, setHistory] = useState<History[]>([]);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [contractorChoices, setContractorChoices] = useState<Record<string, string>>({});
  const [projectChoices, setProjectChoices] = useState<Record<string, string>>({});
  const contractors = [...(review?.contractors ?? [])].sort((left, right) =>
    left.company_name.localeCompare(right.company_name, "en", { sensitivity: "base" }) || left.id - right.id);
  const projects = [...(review?.projects ?? [])].sort((left, right) =>
    left.project_number.localeCompare(right.project_number, "en", { numeric: true, sensitivity: "base" })
    || left.project_name.localeCompare(right.project_name, "en", { sensitivity: "base" }) || left.id - right.id);
  const accept = (value: Review) => { setReview(value); setDecisions(value.run.decisions); setDirty(false); setContractorChoices({}); setProjectChoices({}); };
  const historyPage = async (start: number) => {
    const result = await api<{ runs: History[] }>(`/api/imports/mycoi?offset=${start}`);
    setHistory(result.runs);
    setOffset(start);
  };
  useEffect(() => {
    if (!canView) return;
    let cancelled = false;
    void api<{ runs: History[] }>("/api/imports/mycoi?offset=0").then((value) => {
      if (!cancelled) setHistory(value.runs);
    }).catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Unable to load myCOI history."); });
    return () => { cancelled = true; };
  }, [canView]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(null); setMessage(null);
    try { await operation(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "myCOI operation failed."); }
    finally { setBusy(false); }
  };
  const update = (next: ImportDecisions) => {
    if (!review) return;
    setDecisions(next); setDirty(true);
    void perform(async () => {
      accept(await api<Review>(`/api/imports/mycoi/${review.run.id}`, {
        method: "PATCH", body: JSON.stringify({ revision: review.run.revision, decisions: next }),
      }));
    });
  };
  const contact = (key: string, field: "email" | "phone", value: string) => {
    if (!decisions) return;
    const next = { ...decisions, contacts: { ...decisions.contacts, [key]: { ...decisions.contacts[key] } } };
    if (value) next.contacts[key][field] = value;
    else delete next.contacts[key][field];
    update(next);
  };
  const choose = (field: "vendors" | "divisions", key: string, id: string) => {
    if (!decisions) return;
    const next = { ...decisions, [field]: { ...decisions[field] } };
    if (id) next[field][key] = Number(id);
    else delete next[field][key];
    if (field === "vendors") next.addContractors = (next.addContractors ?? []).filter((item) => item !== key);
    update(next);
  };
  const addContractor = (key: string, raw: string) => {
    if (!decisions || !window.confirm(`Stage Add Contractor for "${raw}"? A contractor will be created only when this reviewed import is executed, after duplicate checks. Only supplied reliable company information will be used.`)) return;
    const next = { ...decisions, vendors: { ...decisions.vendors },
      addContractors: [...new Set([...(decisions.addContractors ?? []), key])] };
    delete next.vendors[key];
    update(next);
  };
  return <section aria-labelledby="mycoi-import-title" className={`${styles.workflow} space-y-4 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm`}>
    <header className={styles.vendorHeader} aria-label="Import actions header">
    <h2 id="mycoi-import-title" className="text-xl font-semibold">myCOI Insurance Import</h2>
    {canView && review && decisions ? <fieldset disabled={busy || !canWrite} className={`${styles.actions} ${styles.importActions}`}>
      <button type="button" disabled={!dirty} className={primaryButton} onClick={() => void perform(async () => {
        accept(await api<Review>(`/api/imports/mycoi/${review.run.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: review.run.revision, decisions }) }));
      })}>Save Review / Refresh Preview</button>
      <button type="button" className={secondaryButton} onClick={() => {
        if (dirty && !window.confirm("Discard unsaved review selections?")) return;
        void perform(async () => accept(await api<Review>(`/api/imports/mycoi/${review.run.id}`)));
      }}>Reload Saved Preview</button>
      <button type="button" disabled={dirty || !review.preview.ready.length || review.run.status === "Complete"} className={primaryButton} onClick={() => {
        if (!window.confirm(`Import ${review.preview.summary.readyRows} ready rows? ${review.preview.summary.unresolvedRows} rows remain unresolved. Ignored rows do not delete existing data.`)) return;
        void perform(async () => {
          const value = await api<Review>(`/api/imports/mycoi/${review.run.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: review.run.revision, token: review.token }) });
          accept(value); setMessage(`Import ${value.run.status}: ${value.run.metrics.rows} rows imported, ${value.run.metrics.exceptions} unresolved. ${value.run.metrics.changes} total recorded changes.`);
          await historyPage(0);
        });
      }}>Import Ready Vendors ({review.preview.ready.length})</button>
      <button type="button" className={primaryButton}
        disabled={dirty || review.preview.summary.unresolvedRows > 0 || review.run.decisions.ignored.length > 0}
        onClick={() => {
          if (!window.confirm("Confirm this is a COMPLETE portfolio report, not a partial extract. Accepting it replaces MYCOI project ownership across ALL contractors, including contractors absent from this file. MANUAL ownership is preserved. Every row must be resolved; ignored rows are not allowed.")) return;
          void perform(async () => {
            accept(await api<Review>(`/api/imports/mycoi/${review.run.id}`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ revision: review.run.revision, token: review.token, acceptCompleteSnapshot: true }),
            }));
            setMessage("COMPLETE project snapshot accepted. MYCOI ownership synchronized; MANUAL ownership preserved.");
            await historyPage(0);
          });
        }}>Accept COMPLETE Portfolio Snapshot</button>
    </fieldset> : null}
    </header>
    <p className="text-sm text-slate-500">myCOI is the insurance source of truth. Import Ready Vendors does not synchronize project ownership. Only Accept COMPLETE Portfolio Snapshot synchronizes MYCOI projects globally; MANUAL projects are always protected. Company names, general contacts and project names are unchanged.</p>
    {!canView ? <p>You need Imports, Insurance, Contractors and Projects View permissions.</p> : <>
      {canWrite ? <label className="block text-sm font-medium">Select myCOI report (XLSX or CSV, up to 3 MB)
        <input aria-label="myCOI report" disabled={busy} type="file" accept=".xlsx,.csv" className={`${styles.fileInput} mt-2 block max-w-full`} onChange={(event) => {
          const file = event.target.files?.[0]; if (!file) return;
          if (dirty && !window.confirm("Discard unsaved review selections and upload another report?")) { event.target.value = ""; return; }
          void perform(async () => {
            const form = new FormData(); form.set("file", file);
            accept(await api<Review>("/api/imports/mycoi", { method: "POST", body: form }));
            await historyPage(0);
          });
          event.target.value = "";
        }} />
      </label> : <p className="text-sm text-slate-500">Read-only history. Imports and Insurance View/Add/Edit permissions are required to upload or review.</p>}
      {error ? <p role="alert" className={`${styles.blockers} ${styles.red}`}>{error}</p> : null}
      {message ? <p role="status" className={`${styles.badge} ${styles.green}`}>{message}</p> : null}
      {review && decisions ? <div className="space-y-4 border-t pt-4">
        <h3 className="font-semibold">Preview: {review.run.file_name}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{Object.entries(review.preview.summary).map(([key, value]) =>
          <div key={key} className="rounded-lg bg-slate-50 p-2 text-xs"><p>{summaryLabels[key as keyof typeof summaryLabels]}</p><strong>{value}</strong></div>)}</div>
        <p className="text-xs text-slate-500">Accepted review decisions are staged automatically and readiness is recalculated. Permanent mappings are written only when importing ready vendors. Contact changes count fields; insurance changes count new/changed policy or status records, not provenance refreshes. A vendor is held until all its remaining rows are safe. Ignored/absent policy data never deletes existing data.</p>
        <p className="font-semibold" aria-live="polite">Ready to Import: {review.preview.ready.length} | Unresolved: {review.preview.vendors.length - review.preview.ready.length}</p>
        {dirty ? <p className="text-sm text-amber-700">Review changes are not yet saved. Readiness below reflects the last saved preview; retry saving or reload before importing.</p> : null}
        <fieldset disabled={busy || !canWrite} className="space-y-4 disabled:opacity-70">
          <details open={review.preview.vendors.length > 0}>
            <summary className="cursor-pointer font-semibold">Vendor Review Required / Vendor Mappings</summary>
            <div className="mt-2 space-y-3">{review.preview.vendors.map((vendor) => {
              const ready = review.preview.ready.some((item) => item.key === vendor.key);
              const issues = review.preview.issues.filter((issue) => issue.rows.some((id) => vendor.rows.some((row) => row.row === id)));
              const contractorName = review.contractors.find((item) => item.id === vendor.contractorId)?.company_name;
              const choice = contractorChoices[vendor.key];
              const exactMatch = vendor.suggestions.some((suggestion) => suggestion.id === vendor.contractorId && suggestion.reason === "Exact Name Match");
              return <div key={vendor.key} role="group" aria-label={`Vendor review: ${vendor.raw}`} className="space-y-2 rounded-lg border p-3 text-sm">
              <header className={styles.vendorHeader}>
              <div className={styles.vendorIdentity}>
              <p className="break-words font-medium">myCOI Vendor Name: {vendor.raw || "(missing)"}</p>
              <p>Vendor Email: {vendor.emailValues.join(" | ") || "(blank)"}</p><p>Vendor Phone: {vendor.phoneValues.join(" | ") || "(blank)"}</p>
              <p className={`${styles.badge} ${ready ? styles.green : vendor.contractorId || vendor.addContractor ? styles.blue : styles.amber}`}>{ready ? "Ready to Import" : vendor.addContractor ? "Add Contractor Staged" : vendor.contractorId ? "Matched" : "Unmatched"}</p>
              </div>
              <div className={styles.vendorControls} aria-label="Vendor matching actions">
              {vendor.contractorId && choice === undefined ? <div>
                <p className={`${styles.badge} ${styles.green}`}>&#10003; {exactMatch ? "Exact Vendor Match" : `Matched to ${contractorName}`}</p>
                {vendor.saved ? <p>Saved mapping reused automatically.</p> : <button type="button" className={`${secondaryButton} ${styles.compactButton}`} onClick={() => setContractorChoices({ ...contractorChoices, [vendor.key]: "" })}>Change Contractor</button>}
              </div> : !vendor.saved ? <>
                {choice !== undefined ? <div className="space-y-2">
                  <label className="block">Select an Existing SubTracker Contractor
                    <select aria-label={`Contractor for ${vendor.raw}`} className={select} value={choice} onChange={(event) => setContractorChoices({ ...contractorChoices, [vendor.key]: event.target.value })}>
                      <option value="">Select a contractor</option>{contractors.map((item) => <option key={item.id} value={item.id}>{item.company_name}{item.active ? "" : " (Inactive)"}</option>)}
                    </select>
                  </label>
                  <p className="text-xs text-slate-500">Selecting a contractor does not accept the mapping. Select Accept Match to stage it.</p>
                </div> : null}
                <div className={styles.actions}>
                  {choice === undefined ? vendor.suggestions.map((suggestion) =>
                    <button key={suggestion.id} type="button" aria-label={`Accept Match: ${suggestion.label}`} className={primaryButton} onClick={() => choose("vendors", vendor.key, String(suggestion.id))}>Accept Match</button>)
                    : <button type="button" disabled={!choice} className={primaryButton} onClick={() => choose("vendors", vendor.key, choice)}>Accept Match</button>}
                  <button type="button" className={secondaryButton} onClick={() => setContractorChoices({ ...contractorChoices, [vendor.key]: "" })}>Match Existing Contractor</button>
                  <button type="button" className={primaryButton} onClick={() => addContractor(vendor.key, vendor.raw)}>Add Contractor</button>
                  <button type="button" className={button} onClick={() => choose("vendors", vendor.key, "")}>Leave Unmatched / Review Later</button>
                </div>
              </> : null}
              </div>
              </header>
              {vendor.contractorId ? <p>{vendor.raw} &rarr; {contractorName}</p> : null}
              {vendor.addContractor ? <p className="font-semibold">Add Contractor staged: {vendor.raw}. Creation and MYCOI provenance will be recorded atomically during import.</p> : null}
              {!vendor.saved && choice === undefined ? vendor.suggestions.map((suggestion) => <div key={suggestion.id}>
                <p>Suggested SubTracker Contractor: <strong>{suggestion.label}</strong></p><p className="text-xs text-slate-500">{suggestion.reason}</p>
              </div>) : null}
              {!ready && issues.length > 0 ? <div className={styles.blockers}>
                <p className={`${styles.badge} ${styles.amber}`}>Review Required</p>
                <p className="font-semibold">Needs review:</p>
                <ul>{!vendor.contractorId && !vendor.addContractor ? <li>Match Existing Contractor, Add Contractor, or leave unmatched for review later.</li> : null}
                  {(["Project Review Required", "Contact Review Required", "Policy Parse Errors"] as const).map((category) => {
                    const relevant = issues.filter((issue) => issue.category === category);
                    const count = category === "Project Review Required"
                      ? new Set(relevant.flatMap((issue) => issue.rows.map((id) => vendor.rows.find((row) => row.row === id)?.["Division Name"]))).size
                      : relevant.length;
                    return count ? <li key={category}>{count} {category === "Project Review Required" ? `Project Match${count === 1 ? " Requires" : "es Require"} Review` : category === "Contact Review Required" ? `Contact Conflict${count === 1 ? " Requires" : "s Require"} Review` : `Policy Parse Exception${count === 1 ? "" : "s"}`}</li> : null;
                  })}
                  {issues.filter((issue) => issue.category === "Source Review Required").map((issue, index) => <li key={index}>{issue.reason}</li>)}
                </ul>
              </div> : null}
              <h4 className="font-semibold">Division / Project Matches</h4>
              {review.preview.divisions.filter((division) => vendor.rows.some((row) => mycoiKey(row["Division Name"]) === division.key)).map((division) => {
                const project = review.projects.find((item) => item.id === division.projectId);
                const selected = projectChoices[division.key];
                const suggestedId = division.suggestions.length === 1 ? String(division.suggestions[0].id) : "";
                const candidate = selected ?? suggestedId;
                return <section key={division.key} aria-label={`Division review: ${division.raw}`} className={styles.policyReview}>
                  {project ? <div>
                    {division.automatic ? <p className={styles.rowLabel}>Project Matched Automatically</p> : null}
                    <p className={`${styles.badge} ${styles.green}`}>&#10003; {project.project_number} - {project.project_name}</p>
                    {division.automatic ? <div className={styles.rowLabel}><p>myCOI: {division.raw}</p><p>SubTracker: {project.project_number} - {project.project_name}</p></div> : null}
                  </div> : <>
                    <p><strong>myCOI Division:</strong> {division.raw || "(missing)"}</p>
                    <p>Detected Project Number: {/^([0-9]+)(?:\s|$|-)/.exec(division.raw.trim())?.[1] ?? "Not available"}</p>
                    {division.suggestions.length ? division.suggestions.map((suggestion) => <p key={suggestion.id}>Suggested SubTracker Project: <strong>{suggestion.label}</strong></p>) : <p>Suggested SubTracker Project: No reliable match; choose an existing project.</p>}
                    {selected !== undefined ? <label className="block">Select an Existing SubTracker Project
                      <select aria-label={`Existing project for ${division.raw}`} className={select} value={selected} onChange={(event) => setProjectChoices({ ...projectChoices, [division.key]: event.target.value })}>
                        <option value="">Select a project</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.project_number} - {item.project_name}</option>)}
                      </select>
                    </label> : null}
                    <div className={styles.actions}>
                      <button type="button" disabled={!candidate} aria-label={`Accept Project Match: ${division.raw}`} className={primaryButton} onClick={() => choose("divisions", division.key, candidate)}>Accept Project Match</button>
                      <button type="button" className={secondaryButton} onClick={() => setProjectChoices({ ...projectChoices, [division.key]: "" })}>Choose Different Project</button>
                      <button type="button" className={button} onClick={() => choose("divisions", division.key, "")}>Leave Unresolved</button>
                    </div>
                    {selected !== undefined ? <p className={styles.rowLabel}>Selecting a project does not accept it. Select Accept Project Match to stage the mapping.</p> : null}
                  </>}
                </section>;
              })}
              <h4 className="font-semibold">Parsed Insurance</h4>
              {vendor.rows.map((row) => {
                const parsed = review.preview.rowPolicies[row.row];
                const division = review.preview.divisions.find((item) => item.key === mycoiKey(row["Division Name"]));
                const project = review.projects.find((item) => item.id === division?.projectId);
                return <section key={row.row} aria-label={`Insurance review for source row ${row.row}`} className={styles.policyReview}>
                  <h5>Project: {project ? `${project.project_number} - ${project.project_name}` : "Mapping requires review"} <span className={styles.rowLabel}>(Source row {row.row})</span></h5>
                  <p>myCOI Status: {row["Compliance Status"] || "Not provided"}</p>
                  {parsed.errors.length ? <div className={`${styles.blockers} ${styles.red}`} role="note">
                    <strong>Policy Parse Exception — this row requires review.</strong>
                    <ul>{parsed.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
                    <p>Expand Source Details below to troubleshoot. Parsed entries below do not make this row safe to import.</p>
                  </div> : null}
                  {parsed.policies.length ? <div className="overflow-x-auto"><table className={styles.policyTable} aria-label={`Parsed insurance for source row ${row.row}`}>
                    <thead><tr>{["Insurance Type", "Policy Number", "Expiration Date", "Status"].map((heading) => <th key={heading}>{heading}</th>)}</tr></thead>
                    <tbody>{parsed.policies.flatMap((policy, index) => policy.policyLines.map((line, lineIndex) => <tr key={`${index}-${lineIndex}`}>
                      <td>{line}</td><td>{policy.policyNumber}</td><td>{`${policy.expirationDate.slice(5, 7)}/${policy.expirationDate.slice(8, 10)}/${policy.expirationDate.slice(0, 4)}`}</td>
                      <td><span className={`${styles.badge} ${policy.isExpired ? styles.gray : styles.green}`}>{policy.isExpired ? "Expired" : "Current"}</span></td>
                    </tr>))}</tbody>
                  </table><p className={styles.rowLabel}>Current / Expired reflects the myCOI source flag.</p></div> : <p>{parsed.errors.length ? "No safely parsed policies for this row." : "No policies supplied for this row; existing policies are retained."}</p>}
                  <details className={styles.sourceDetails}>
                    <summary>Source Details</summary>
                    <p>Source Excel row: {row.row}</p>
                    <p>Complete raw Division Name: {row["Division Name"] || "(blank)"}</p>
                    <p>Complete raw Policy Expiration Dates:</p><pre>{row["Policy Expiration Dates"] || "(blank)"}</pre>
                    <p>Parser errors: {parsed.errors.length ? parsed.errors.join(" | ") : "None"}</p>
                    <pre>{JSON.stringify(row, null, 2)}</pre>
                  </details>
                </section>;
              })}
              {(["email", "phone"] as const).map((field) => {
                const relevant = review.preview.issues.some((issue) => issue.category === "Contact Review Required" && issue.reason.startsWith(field === "email" ? "Vendor Email" : "Vendor Phone") && issue.rows.some((row) => vendor.rows.some((item) => item.row === row)));
                if (!relevant && decisions.contacts[vendor.key]?.[field] === undefined) return null;
                const values = field === "email" ? vendor.emailValues : vendor.phoneValues;
                const valid = field === "email" ? safeEmail : safePhone;
                return <label key={field} className="block">Review Vendor {field === "email" ? "Email" : "Phone"}
                  <select aria-label={`${field} for ${vendor.raw}`} className={`${select} ml-2`} value={decisions.contacts[vendor.key]?.[field] ?? ""} onChange={(event) => contact(vendor.key, field, event.target.value)}>
                    <option value="">Leave Unresolved</option><option value="__KEEP__">Keep Existing Contact Value: {(field === "email" ? vendor.existingEmail : vendor.existingPhone) ?? "(none)"}</option>
                    {values.map((value) => <option key={value} value={value} disabled={!valid(value)}>Accept Contact Value: {value}{valid(value) ? "" : " (unsafe / placeholder)"}</option>)}
                  </select>
                </label>;
              })}
            </div>; })}</div>
          </details>
          <details open={review.preview.issues.length > 0}>
            <summary className="cursor-pointer font-semibold">Exceptions / Policy Parse Errors ({review.preview.issues.length})</summary>
            {review.preview.issues.map((issue, index) => <div key={index} className="mt-2 rounded-lg border border-amber-200 p-3 text-sm">
              <p><span className={`${styles.badge} ${issue.category === "Policy Parse Errors" ? styles.red : styles.amber}`}>{issue.category}</span>: {issue.reason}</p>
              {issue.rows.map((id) => {
                const row = review.run.source_rows.find((source) => source.row === id)!;
                return <div key={id} className="mt-2"><details className={styles.sourceDetails}><summary>Source Details — Row {id}: {row["Vendor Name"] || "(missing vendor)"} | {row["Division Name"] || "(missing division)"}</summary><pre>{JSON.stringify({ ...row, parserErrors: review.preview.rowPolicies[id]?.errors ?? [] }, null, 2)}</pre></details>
                  <button type="button" className={button} onClick={() => update({ ...decisions, ignored: [...new Set([...decisions.ignored, id])] })}>Ignore This Source Record #{id}</button>
                </div>;
              })}
              <p className="mt-1 text-xs text-slate-500">Leave Unresolved: take no action; this exception remains stored with this run.</p>
            </div>)}
          </details>
          {decisions.ignored.length > 0 ? <div><h4 className={`${styles.badge} ${styles.gray}`}>Ignored source rows</h4>{decisions.ignored.map((id) => <button key={id} type="button" className={`${button} mr-2`} onClick={() => update({ ...decisions, ignored: decisions.ignored.filter((row) => row !== id) })}>Restore row #{id}</button>)}</div> : null}
          <div><h4 className="font-semibold">Ready to Import</h4>{review.preview.ready.map((vendor) => <p key={vendor.key} className="text-sm">{vendor.raw}: {vendor.rows.length} rows, {vendor.policies.length} distinct policy lines, {vendor.divisions.length} divisions</p>)}</div>
          {!review.preview.ready.length ? <p>No vendors are currently ready to import.</p> : null}
        </fieldset>
      </div> : null}
      <div className="border-t pt-4"><h3 className="font-semibold">myCOI Import History</h3>
      <p className="text-xs text-gray-500">Counts reflect the last applied execution, not unsaved or staged review decisions. Rows is the original source row count.</p>
        <div className="overflow-x-auto"><table className="mt-2 w-full text-left text-xs"><thead><tr>{["File Name", "Import / Last Update", "Rows Read / Imported", "Vendors", "Policies", "Changes", "Exceptions", "Status", "Review"].map((label) => <th key={label} className="p-2">{label}</th>)}</tr></thead><tbody>
          {history.map((run) => <tr key={run.id} className="border-t"><td className="p-2">{run.file_name}</td><td className="p-2">{run.last_imported_at ? new Date(run.last_imported_at).toLocaleString() : "Not imported"}<br />Review updated: {new Date(run.updated_at).toLocaleString()}</td><td className="p-2">{run.source_row_count} / {run.metrics.rows}</td><td className="p-2">{run.metrics.vendors}</td><td className="p-2">{run.metrics.policies}</td><td className="p-2">{run.metrics.changes}</td><td className="p-2">{run.metrics.exceptions}</td><td className="p-2"><span className={`${styles.badge} ${run.status === "Complete" ? styles.green : styles.amber}`}>{run.status}</span>{run.last_imported_at ? <span className={`${styles.badge} ${styles.green}`}>Imported</span> : null}</td><td className="p-2"><button type="button" disabled={busy} className={button} onClick={() => {
            if (dirty && !window.confirm("Discard unsaved review selections?")) return;
            void perform(async () => accept(await api<Review>(`/api/imports/mycoi/${run.id}`)));
          }}>Review {run.file_name}</button></td></tr>)}
        </tbody></table></div>
        {!history.length ? <p className="mt-2 text-sm text-slate-500">No myCOI import runs loaded.</p> : null}
        <div className="mt-2 flex gap-2"><button type="button" className={button} disabled={busy || offset === 0} onClick={() => void perform(() => historyPage(Math.max(0, offset - 20)))}>Previous</button><button type="button" className={button} disabled={busy || history.length < 20} onClick={() => void perform(() => historyPage(offset + 20))}>Next</button><button type="button" disabled={busy} className={button} onClick={() => void perform(() => historyPage(0))}>Refresh myCOI History</button></div>
      </div>
    </>}
  </section>;
}
