"use client";

import Link from "next/link";
import { useState } from "react";
import Style3Icon from "@/components/style3/Style3Icon";
import { complianceSummary, type ComplianceCompany, type RequirementAssessment } from "@/services/project-compliance-assessment";
import styles from "@/app/reports/reports.module.css";

const statusClass: Record<RequirementAssessment["status"], string> = {
  Current: styles.good, "61-90 Days": styles.yellow, "31-60 Days": styles.orange,
  "0-30 Days": styles.red, Expired: styles.expired, Missing: styles.missing,
  "Not Required": styles.neutral, Unavailable: styles.neutral,
};
function dateLabel(value: string | null) {
  if (!value) return "N/A";
  const [year, month, day] = value.split("-");
  return `${month}/${day}/${year}`;
}
export default function ComplianceReport({ companies, status, onSort, sortKey, sortAscending }: {
  companies: ComplianceCompany[]; status: string; onSort: (key: "companyName" | "status") => void;
  sortKey: string; sortAscending: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set(companies.slice(0, 1).map(company => company.id)));
  const [page, setPage] = useState(0);
  const lastPage = Math.max(0, Math.ceil(companies.length / 25) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = companies.slice(currentPage * 25, currentPage * 25 + 25);
  const cards = complianceSummary(companies);
  return <>
    <section className={styles.summaryCards} aria-label="Compliance summary">
      {cards.map((card, i) => <article key={card.label} className={styles.summaryCard}>
        <span aria-hidden="true" className={`${styles.summaryIcon} ${[styles.blue, styles.good, styles.orange, styles.expired, styles.neutral][i]}`}><Style3Icon name={["Contractors", "Compliance", "Follow-Ups", "Compliance", "Reports"][i]} /></span>
        <div><strong>{card.count}</strong><span>{card.label}</span>{i > 0 ? <small>{companies.length ? (card.count / companies.length * 100).toFixed(1) : "0.0"}%</small> : null}</div>
      </article>)}
    </section>
    <section className={styles.matrix} aria-label="Compliance requirements">
      <div className={styles.matrixHeading}><span><button type="button" aria-label="Sort by Company Name" onClick={() => onSort("companyName")}>Contractor / Requirement{sortKey === "companyName" ? sortAscending ? " ^" : " v" : ""}</button></span><span><button type="button" aria-label="Sort by Status" onClick={() => onSort("status")}>Status{sortKey === "status" ? sortAscending ? " ^" : " v" : ""}</button></span><span>Expiration Date</span><span>Details</span>
        <button type="button" className={styles.expandAll} onClick={() => setExpanded(current =>
          visible.every(company => current.has(company.id)) ? new Set() : new Set(visible.map(company => company.id)))}>
          {visible.length && visible.every(company => expanded.has(company.id)) ? "Collapse All" : "Expand All"}
        </button>
      </div>
      {visible.map(company => {
        const open = expanded.has(company.id);
        const id = `company-requirements-${company.id}`;
        return <article key={company.id} className={styles.company} data-company-id={company.id}>
          <div className={styles.companyHeading}>
            <Link href={`/contractors/${company.id}`} className={styles.companyLink}><Style3Icon name="Contractors" />{company.name}</Link>
            <span className={`${styles.badge} ${company.state === "Fully Compliant" ? styles.good : company.state === "Non-Compliant" ? styles.missing : company.state === "Needs Review" ? styles.neutral : styles.orange}`}>{company.state}</span>
            <button type="button" aria-expanded={open} aria-controls={id} aria-label={`${open ? "Collapse" : "Expand"} ${company.name}`}
              onClick={() => setExpanded(current => { const next = new Set(current); if (open) next.delete(company.id); else next.add(company.id); return next; })}>
              <span aria-hidden="true">{open ? "⌃" : "⌄"}</span>
            </button>
          </div>
          {open ? <div id={id} className={styles.requirements}>
            {company.requirements.map(row => <div key={row.requirement} className={`${styles.requirementRow} ${status !== "All statuses" && row.applicable && row.status === status ? styles.matching : ""}`}>
              <span className={styles.requirementName}>{row.requirement === "FEIN" ? "FEIN (Taxpayer ID)" : row.requirement}</span>
              <span><span className={`${styles.badge} ${statusClass[row.status]}`}>{row.status}</span></span>
              <span><small className={styles.mobileLabel}>Expiration Date </small>{dateLabel(row.expirationDate)}</span>
              <span><small className={styles.mobileLabel}>Details </small>{row.detail}</span>
            </div>)}
          </div> : null}
        </article>;
      })}
      {!companies.length ? <p className={styles.empty}>No matching accessible contractors in this report scope. No broader population has been substituted.</p> : null}
      <footer className={styles.matrixFooter}><span>Showing {companies.length ? currentPage * 25 + 1 : 0} - {Math.min((currentPage + 1) * 25, companies.length)} of {companies.length} contractors</span>
        <div><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</button><span>{currentPage + 1}</span><button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Next</button></div>
      </footer>
    </section>
    <p className={styles.footnote}>FEIN, NJ BRC and NJ PWC only. Insurance remains in its dedicated report. Counts are unique contractors; issue categories can overlap. Unavailable requirements need review and are never counted as compliant.</p>
  </>;
}
