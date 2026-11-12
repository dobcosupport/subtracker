"use client";

import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import type { DashboardFollowup } from "@/services/followups";
import { localCalendarDate, matchesFollowupFilter, type FollowupQueueFilter } from "@/services/followup-queue";
import Style3SummaryCards from "./Style3SummaryCards";
import shared from "./style3.module.css";
import styles from "./operations.module.css";

const subscribeDate = (notify: () => void) => {
  const timer = window.setInterval(notify, 60_000);
  window.addEventListener("focus", notify);
  return () => { window.clearInterval(timer); window.removeEventListener("focus", notify); };
};
const serverDate = () => "";
const currentDate = () => localCalendarDate();
const filterLabels: Record<FollowupQueueFilter, string> = {
  open: "All open follow-ups", overdue: "Overdue follow-ups", today: "Follow-ups due today", upcoming: "Upcoming follow-ups",
};
const cards: readonly { key: FollowupQueueFilter; label: string; note: string; icon: string }[] = [
  { key: "open", label: "Open", note: "Open + Waiting Response", icon: "Follow-Ups" },
  { key: "overdue", label: "Overdue", note: "Before today", icon: "Compliance" },
  { key: "today", label: "Due Today", note: "Today's follow-up date", icon: "Calendar" },
  { key: "upcoming", label: "Upcoming", note: "After today", icon: "Calendar" },
];

export default function Style3FollowupsQueue({ followups, loading, error, reload }: {
  followups: DashboardFollowup[];
  loading: boolean;
  error: string | null;
  reload: () => void;
}) {
  const [filter, setFilter] = useState<FollowupQueueFilter>("open");
  const today = useSyncExternalStore(subscribeDate, currentDate, serverDate);
  const unavailable = loading || error !== null || !today;
  const items = cards.map(item => ({ ...item, value: followups.filter(row => matchesFollowupFilter(row, item.key, today)).length }));
  const rows = followups.filter(row => matchesFollowupFilter(row, filter, today));
  const undated = followups.filter(row => !row.followup_date).length;
  return <>
    <Style3SummaryCards label="Follow-up overview" items={items} selected={filter} onSelect={setFilter} unavailable={unavailable} />
    <section className={shared.surface} aria-labelledby="followups-queue-heading">
      <div className={styles.directoryHeader}><div>
        <h2 id="followups-queue-heading" className={shared.heading}>Open Follow-Ups</h2>
        <p className={shared.description}>Open and Waiting Response items, oldest follow-up date first. Manage items on the company card.</p>
      </div><button type="button" className={styles.compactButton} disabled={loading} onClick={reload}>Refresh Follow-Ups</button></div>
      <div className={styles.filterBar}><span aria-live="polite">{filterLabels[filter]}{!unavailable ? ` \u00b7 ${rows.length.toLocaleString()} items` : ""}</span>
        {filter !== "open" ? <button type="button" className={styles.compactButton} onClick={() => setFilter("open")}>Show all open</button> : null}
      </div>
      {error ? <p role="alert" className={`${shared.empty} ${shared.error}`}>{error}</p>
        : loading ? <p role="status" className={shared.empty}>Loading open follow-ups...</p>
        : !rows.length ? <p className={shared.empty}>{filter === "open" ? "No open follow-ups." : "No follow-ups in this view."}</p>
        : <div className={styles.tableScroll}><table className={`${shared.operationalTable} ${styles.table} ${styles.queue}`} aria-label="Follow-up work queue">
          <thead><tr>{["Company Name", "Follow-Up Item", "Follow-Up Date", "Status", "Company"].map(label =>
            <th scope="col" key={label}>{label}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}><td>{row.contractor.company_name}</td><td>
            {row.subject.length > 160 ? <details className={styles.details}><summary>{row.subject.slice(0, 157)}...</summary><p className={styles.subject}>{row.subject}</p></details>
              : <p className={styles.subject}>{row.subject}</p>}
            {row.notes ? row.notes.length > 180 || row.notes.split("\n").length > 3
              ? <details className={styles.details}><summary>View follow-up details</summary><p className={styles.notes}>{row.notes}</p></details>
              : <p className={styles.notes}>{row.notes}</p> : null}
          </td><td className={styles.nowrap}>{row.followup_date || "No date"}</td>
            <td><span className={`${shared.badge} ${row.status === "Waiting Response" ? shared.yellow : shared.blue}`}>{row.status}</span></td>
            <td><Link prefetch={false} href={`/contractors/${row.contractor_id}`} className={styles.compactButton}>Open Company</Link></td>
          </tr>)}</tbody>
        </table></div>}
      {!unavailable ? <footer className={styles.queueFooter}><span>{undated ? `${undated} undated items remain in Open.` : "Dates use your local calendar day."}</span>
        <span>Update status, dates and details on the company card.</span></footer> : null}
    </section>
  </>;
}
