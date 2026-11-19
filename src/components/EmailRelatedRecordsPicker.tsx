"use client";

import { useEffect, useState } from "react";
import { composeRows } from "@/lib/communication-compose-client";
import type { ComposeCompliance, ComposeOptions } from "@/types/communication-compose";
import styles from "./email-workspace.module.css";

type Contractors = ComposeOptions["contractors"];
type Projects = ComposeOptions["projects"];
type Props = {
  contractors: Contractors;
  projects: Projects;
  complianceIds: number[];
  canSelectContractors: boolean;
  canSelectProjects: boolean;
  canSelectCompliance: boolean;
  onCancel: () => void;
  onApply: (contractors: Contractors, projects: Projects, record: ComposeCompliance | null) => void;
};

export default function EmailRelatedRecordsPicker(props: Props) {
  const [contractors, setContractors] = useState(props.contractors);
  const [projects, setProjects] = useState(props.projects);
  const [records, setRecords] = useState<ComposeCompliance[]>([]);
  const [recordId, setRecordId] = useState(props.complianceIds.length === 1 ? String(props.complianceIds[0]) : "");
  const [contractorSearch, setContractorSearch] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [contractorChoices, setContractorChoices] = useState<Contractors>([]);
  const [projectChoices, setProjectChoices] = useState<Projects>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const contractorId = contractors.length === 1 ? contractors[0].id : null;

  useEffect(() => {
    let current = true;
    const timer = setTimeout(() => {
      setLoading(true); setError("");
      void Promise.all([
        props.canSelectContractors ? composeRows<Contractors[number]>("contractors", { search: contractorSearch }) : [],
        props.canSelectProjects ? composeRows<Projects[number]>("projects", { search: projectSearch }) : [],
        props.canSelectCompliance && contractorId ? composeRows<ComposeCompliance>("compliance", { contractor_id: String(contractorId) }) : [],
      ]).then(([companies, jobs, compliance]) => {
        if (!current) return;
        setContractorChoices(companies); setProjectChoices(jobs); setRecords(compliance); setLoading(false);
      }).catch(reason => {
        if (current) { setError(reason instanceof Error ? reason.message : "Unable to load related records."); setLoading(false); }
      });
    }, 250);
    return () => { current = false; clearTimeout(timer); };
  }, [contractorSearch, projectSearch, contractorId, props.canSelectContractors, props.canSelectProjects, props.canSelectCompliance]);

  const selectedRecord = recordId ? records.find(r => String(r.compliance_record_id) === recordId) ?? null : null;
  const unresolvedRecord = Boolean(recordId && !selectedRecord);
  return <section className={styles.relatedPicker} aria-label="Related To selection">
    <p>Choose the applicable records, then Apply once. Leave categories blank when they are not needed. Recipients do not change these selections.</p>
    <div className={styles.relatedColumns}>
      <fieldset disabled={!props.canSelectProjects}>
        <legend>Project</legend>
        <input aria-label="Search related projects" placeholder="Search projects" value={projectSearch} onChange={e => setProjectSearch(e.target.value)} />
        <div className={styles.relatedChoices}>
          {[...projects, ...projectChoices.filter(p => !projects.some(selected => selected.id === p.id))].map(project =>
            <label key={project.id}><input type="checkbox" checked={projects.some(p => p.id === project.id)} onChange={e =>
              setProjects(e.target.checked ? [...projects, project] : projects.filter(p => p.id !== project.id))} />{project.project_number} - {project.project_name}</label>)}
        </div>
        {!props.canSelectProjects ? <small>Projects View permission is required.</small> : null}
      </fieldset>
      <fieldset disabled={!props.canSelectContractors}>
        <legend>Contractor</legend>
        <input aria-label="Search related contractors" placeholder="Search contractors" value={contractorSearch} onChange={e => setContractorSearch(e.target.value)} />
        <div className={styles.relatedChoices}>
          {[...contractors, ...contractorChoices.filter(c => !contractors.some(selected => selected.id === c.id))].map(contractor =>
            <label key={contractor.id}><input type="checkbox" checked={contractors.some(c => c.id === contractor.id)} onChange={e => {
              setContractors(e.target.checked ? [...contractors, contractor] : contractors.filter(c => c.id !== contractor.id));
              setRecordId(""); setLoading(true);
            }} />{contractor.company_name}</label>)}
        </div>
        {!props.canSelectContractors ? <small>Contractors View permission is required.</small> : null}
      </fieldset>
      <fieldset disabled={!props.canSelectCompliance || !contractorId || loading}>
        <legend>Compliance Record</legend>
        <select aria-label="Related compliance record" value={recordId} onChange={e => setRecordId(e.target.value)}>
          <option value="">None</option>
          {recordId && !records.some(r => String(r.compliance_record_id) === recordId)
            ? <option value={recordId}>Saved compliance record #{recordId}</option> : null}
          {records.map(r => <option key={r.compliance_record_id} value={r.compliance_record_id}>
            {[r.compliance_name, r.registration_number, r.calculated_status, r.expiration_date ? `Expires ${r.expiration_date}` : null].filter(Boolean).join(" | ")}
          </option>)}
        </select>
        <small>{!props.canSelectCompliance ? "Compliance and Contractors View permissions are required."
          : !contractorId ? "Select one contractor to see its compliance records."
            : "Only records belonging to the selected contractor are shown."}</small>
      </fieldset>
    </div>
    {loading ? <p role="status">Loading related records...</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {!loading && unresolvedRecord ? <p role="alert">The saved compliance record is unavailable. Select another record or None before applying.</p> : null}
    <div className={styles.inline}>
      <button type="button" className={styles.secondary} onClick={props.onCancel}>Cancel</button>
      <button type="button" className={styles.primary} disabled={loading || Boolean(error) || unresolvedRecord}
        onClick={() => props.onApply(contractors, projects, selectedRecord)}>Apply</button>
    </div>
  </section>;
}
