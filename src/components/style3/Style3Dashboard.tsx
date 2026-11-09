"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import { getOpenFollowups, type DashboardFollowup } from "@/services/followups";
import { getDashboardEligibility, summarizeDashboardCompliance } from "@/services/style3-dashboard-compliance";
import { countActiveProjectsByWorkType } from "@/services/style3-project-metrics";
import { getActiveContractorCount, getActiveDashboardProjects, getRecentDashboardEmails, getDashboardEmailDetails, summarizeFollowupDates, type ActiveDashboardProject } from "@/services/style3-dashboard-operations";
import { getPrimaryContactsForContractors, type ContractorPrimaryContact } from "@/services/contractorContacts";
import type { CommunicationSummary } from "@/types/communications";
import Style3Panel from "./Style3Panel";
import Style3Icon from "./Style3Icon";
import Style3Header from "./Style3Header";
import styles from "./dashboard.module.css";
import panelStyles from "./style3.module.css";

const DashboardExportDialog = dynamic(() => import("@/components/exports/DashboardExportDialog"), { ssr: false });
const LegacyDashboard = dynamic(() => import("@/components/LegacyDashboard"), { ssr: false });
const subscribeDate = (notify: () => void) => {
  const timer = window.setInterval(notify, 60_000);
  return () => window.clearInterval(timer);
};
const currentDate = () => new Intl.DateTimeFormat("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(new Date());
const serverDate = () => "";
const currentMonth = () => new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(new Date());

type Load<T> = { data: T | null; error: string | null };
type ComplianceSummary = ReturnType<typeof summarizeDashboardCompliance>;

function useRead<T>(enabled: boolean, read: () => Promise<T>): Load<T> {
  const [state, setState] = useState<Load<T>>({ data: null, error: null });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    void read().then(data => { if (active) setState({ data, error: null }); },
      (error: unknown) => {
        console.warn("Dashboard data read failed:", error);
        if (active) setState({ data: null, error: error instanceof Error ? error.message : "Unable to load data." });
      });
    return () => { active = false; };
  }, [enabled, read]);
  return state;
}

const loadCompliance = async () => summarizeDashboardCompliance(await getDashboardEligibility());
const loadFollowups = async () => {
  const result = await getOpenFollowups();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Unable to load follow-ups.");
  return result.data;
};

function ReadState<T>({ state, children, unavailable }: { state: Load<T>; children: (data: T) => React.ReactNode; unavailable?: string }) {
  if (state.error) return <section className={styles.unavailable} role="alert"><strong>{unavailable ?? "Dashboard data temporarily unavailable"}</strong>
    <p>Please refresh the page or try again later.</p></section>;
  if (state.data === null) return <p role="status" className={styles.muted}>Loading...</p>;
  return <>{children(state.data)}</>;
}

function Kpi({ label, value, note, icon, href, onDetails }: { label: string; value: string | number; note: string; icon: string; href: string; onDetails?: () => void }) {
  const link = <Link href={href} prefetch={false} aria-label={label} className={`${styles.kpi} ${styles[`icon${icon.replace(/[^A-Za-z]/g, "")}`] ?? ""}`}><Style3Icon name={icon} className={styles.kpiIcon} />
    <div><h2>{label}</h2><strong>{value}</strong><p>{note}</p></div></Link>;
  return onDetails ? <div className={styles.kpiWithDetails}>{link}
    <button type="button" className={styles.kpiDetails} onClick={event => { event.stopPropagation(); onDetails(); }}>Review Details →</button></div> : link;
}

function CompliancePanel({ data }: { data: ComplianceSummary }) {
  const overall = data.overallCompliance;
  const percent = (count: number) => overall.population ? count / overall.population * 100 : 0;
  const compliantEnd = percent(overall.compliant);
  const nonCompliantEnd = compliantEnd + percent(overall.nonCompliant);
  const expiringEnd = nonCompliantEnd + percent(overall.expiringSoon);
  const donutBackground = overall.population
    ? `conic-gradient(#1db977 0 ${compliantEnd}%, #f45052 ${compliantEnd}% ${nonCompliantEnd}%, #ffbf00 ${nonCompliantEnd}% ${expiringEnd}%, #8da3c3 ${expiringEnd}% 100%)`
    : "#dce5f1";
  const displayedRate = overall.rate === null ? "—" : `${overall.rate.toFixed(1)}%`;
  return <Style3Panel title="Overall Contractor Compliance" description="Based on FEIN, NJ BRC, and applicable NJ PWC">
    <div className={styles.compliance}>
      <div className={styles.donut} role="img"
        aria-label={`Overall contractor compliance: ${overall.compliant} compliant, ${overall.nonCompliant} non-compliant, ${overall.expiringSoon} expiring soon, ${overall.needsReview} needs review`}
        style={{ background: donutBackground }}>
        <div><strong>{displayedRate}</strong><span>Overall rate</span></div>
      </div>
      <div className={styles.legend}>
        <div className={styles.compliancePopulation}><strong>{overall.population.toLocaleString()} Active + Assigned Contractors</strong></div>
        <p><i className={styles.green} /><span>Compliant</span><strong>{overall.compliant} · {percent(overall.compliant).toFixed(1)}%</strong></p>
        <p><i className={styles.red} /><span>Non-Compliant</span><strong>{overall.nonCompliant} · {percent(overall.nonCompliant).toFixed(1)}%</strong></p>
        <p><i className={styles.amber} /><span>Expiring Soon</span><strong>{overall.expiringSoon} · {percent(overall.expiringSoon).toFixed(1)}%</strong></p>
        <p><i className={styles.gray} /><span>Needs Review</span><strong>{overall.needsReview} · {percent(overall.needsReview).toFixed(1)}%</strong></p>
        <Link href="/compliance" className={styles.detailButton}>View Compliance →</Link>
      </div>
    </div>
  </Style3Panel>;
}

function ContractorGrowth({ active, assigned, assignedAllowed }: { active: Load<number>; assigned: Load<ComplianceSummary>; assignedAllowed: boolean }) {
  const month = useSyncExternalStore(subscribeDate, currentMonth, serverDate);
  const activeCount = active.data;
  const assignedCount = assignedAllowed ? assigned.data?.population : undefined;
  const maximum = Math.max(activeCount ?? 0, assignedCount ?? 0, 1);
  return <div className={styles.growthCard}><section className={panelStyles.panel}>
    <Link href="/contractors" prefetch={false} aria-label="Contractor Growth: View Contractors" className={styles.growthCardLink}
      onKeyDown={event => {
        if (event.key === " ") {
          event.preventDefault();
          event.currentTarget.click();
        }
      }}>
    <h2 className={panelStyles.heading}>Contractor Growth</h2>
    <p className={panelStyles.description}>Current active contractors and project assignments</p>
    {active.error ? <p role="alert" className={styles.muted}>Contractor growth temporarily unavailable.</p>
      : activeCount === null ? <p role="status" className={styles.muted}>Loading...</p> : <>
        <div className={styles.growthLegend}><span><i className={styles.growthBlue} />Active Contractors</span>
          <span><i className={styles.growthGreen} />Active + Assigned Contractors</span></div>
        <div className={styles.growthChart} role="img" aria-label={`${month}: ${activeCount} active contractors; ${assignedCount === undefined ? "active and assigned count unavailable" : `${assignedCount} active and assigned contractors`}`}>
          <div className={styles.growthPeriod}><div className={styles.growthBars}>
            <div className={styles.growthBarGroup}><strong>{activeCount.toLocaleString()}</strong><div className={styles.growthBlue} style={{ height: `${activeCount / maximum * 100}%` }} /></div>
            {assignedCount !== undefined ? <div className={styles.growthBarGroup}><strong>{assignedCount.toLocaleString()}</strong><div className={styles.growthGreen} style={{ height: `${assignedCount / maximum * 100}%` }} /></div> : null}
          </div><span className={styles.growthMonth}>{month}</span></div>
        </div>
      </>}
    </Link>
  </section></div>;
}

function Expirations({ data }: { data: ComplianceSummary }) {
  const [days, setDays] = useState(30);
  const rows = data.expirations.filter(item => item.days >= 1 && item.days <= days)
    .sort((a, b) => a.date.localeCompare(b.date) || a.companyName.localeCompare(b.companyName));
  return <Style3Panel title="Upcoming Expirations" description="Current applicable requirements approaching expiration">
    <div className={`${styles.panelLink} ${styles.expirationLink}`}><Link href="/compliance" aria-label="View all compliance expirations">View all →</Link></div>
    <div className={styles.tabs}>{[30, 60, 90].map(value => <button key={value} type="button" aria-pressed={days === value}
      aria-label={`Next ${value} Days`} onClick={() => setDays(value)}><span>Next {value} Days</span>
      <strong>{data.expirations.filter(item => item.days >= 1 && item.days <= value).length}</strong><small>within {value} days</small></button>)}</div>
    {rows.length ? <div className={`${styles.tableWrap} ${styles.expirationTable}`}><table><thead><tr><th>Contractor</th><th>Requirement</th><th>Expiration</th><th>Days Remaining</th></tr></thead>
      <tbody>{rows.slice(0, 3).map(item => <tr key={`${item.contractorId}:${item.requirement}:${item.date}`}>
        <td title={item.companyName}><Link href={`/contractors/${item.contractorId}`}>{item.companyName}</Link></td><td title={item.requirement}>{item.requirement}</td><td>{item.date}</td><td><span className={styles.expirationDays}>{item.days} days</span></td>
      </tr>)}</tbody></table></div> : <p className={styles.muted}>No known-applicable expirations in this period.</p>}
  </Style3Panel>;
}

function ComplianceExceptions({ data }: { data: ComplianceSummary }) {
  return <Style3Panel title="Known Requirement Exceptions" description="Expired or missing current information for known-applicable requirements.">
    {data.exceptions.length ? <div className={styles.tableWrap}><table><thead><tr><th>Contractor</th><th>Requirement</th><th>Status</th></tr></thead>
      <tbody>{data.exceptions.map(row => <tr key={`${row.contractorId}:${row.requirement}`}>
        <td><Link href={`/contractors/${row.contractorId}`}>{row.companyName}</Link></td><td>{row.requirement}</td>
        <td><span className={styles.badge}>{row.status}</span></td></tr>)}</tbody></table></div>
      : <p className={styles.muted}>No known requirement exceptions.</p>}
  </Style3Panel>;
}

function FollowupsPanel({ rows }: { rows: DashboardFollowup[] }) {
  const today = useSyncExternalStore(subscribeDate, () => new Date().toDateString(), serverDate);
  const summary = today ? summarizeFollowupDates(rows, new Date(today)) : null;
  return <Style3Panel title="Open Follow-Ups" description="Open and Waiting Response items">
    <div className={styles.panelLink}><span>Follow-up dates</span><Link href="/followups" aria-label="View all follow-ups">View all →</Link></div>
    <div className={styles.followupStats}>
      <div><strong>{rows.length}</strong><span>Open</span></div>
      <div><strong>{summary?.past ?? "—"}</strong><span>Past date</span></div>
      <div><strong>{summary?.thisWeek ?? "—"}</strong><span>This week</span></div>
    </div>
    {rows.length ? <div className={styles.tableWrap}><table><thead><tr><th>Date</th><th>Contractor</th><th>Subject</th><th>Status</th></tr></thead>
      <tbody>{rows.slice(0, 5).map(row => <tr key={row.id}><td>{row.followup_date || "—"}</td>
        <td><Link href={`/contractors/${row.contractor_id}`}>{row.contractor.company_name}</Link></td><td>{row.subject}</td>
        <td><span className={`${styles.badge} ${summary?.classify(row.followup_date) === "past" ? styles.pastBadge : summary?.classify(row.followup_date) === "week" ? styles.weekBadge : ""}`}>{row.status}</span></td></tr>)}</tbody></table></div>
      : <p className={styles.muted}>No open follow-ups.</p>}
  </Style3Panel>;
}

function ProjectsPanel({ rows }: { rows: ActiveDashboardProject[] }) {
  const counts = countActiveProjectsByWorkType(rows);
  return <Style3Panel title="Projects">
    <div className={styles.panelLink}><span className={styles.projectCount}><Style3Icon name="Projects" /><strong>{rows.length}</strong> Active Projects</span><Link href="/projects" aria-label="View all projects">View all →</Link></div>
    <div className={styles.projectStats}>{counts.map(item => <span key={item.type}><b>{item.count}</b> {item.type}</span>)}</div>
  </Style3Panel>;
}

function EmailPanel({ rows, canViewContent }: { rows: CommunicationSummary[]; canViewContent: boolean }) {
  const [details, setDetails] = useState<Map<string, { subject: string | null; recipients: string[] }> | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (!canViewContent || rows.length === 0) return;
    let active = true;
    void getDashboardEmailDetails(rows.slice(0, 3).map(row => row.id)).then(result => {
      if (active) { setDetails(result); setError(false); }
    }, (reason: unknown) => {
      console.warn("Dashboard email details read failed:", reason);
      if (active) setError(true);
    });
    return () => { active = false; };
  }, [rows, canViewContent]);
  return <Style3Panel title="Recent Email Communications">
    <div className={styles.panelLink}><span>Latest entries from history</span><Link href="/email-communications" aria-label="View all email communications">View all →</Link></div>
    {canViewContent && error ? <p role="alert" className={styles.emailError}>Email details temporarily unavailable.</p> : null}
    {rows.length ? <div className={styles.emailTable}><table><thead><tr><th>Date</th><th>Recipient</th><th>Subject</th><th>Status</th></tr></thead>
      <tbody>{rows.slice(0, 3).map(row => {
        const content = canViewContent ? details?.get(row.id) : undefined;
        const recipient = content ? content.recipients.length ? `${content.recipients[0]}${content.recipients.length > 1 ? ` +${content.recipients.length - 1}` : ""}` : "No recipients"
          : canViewContent ? error ? "Unavailable" : "Loading..." : "Restricted";
        const subject = content ? content.subject || "No subject" : canViewContent ? error ? "Unavailable" : "Loading..." : "Restricted";
        return <tr key={row.id}><td>{new Date(row.created_at).toLocaleDateString()}</td><td title={recipient}>{recipient}</td>
          <td title={subject}>{subject}</td><td><span className={`${styles.badge} ${row.status === "Failed" ? styles.pastBadge : row.status === "Scheduled" ? styles.weekBadge : row.status === "Sent" || row.status === "Delivered" ? styles.sentBadge : row.status === "Cancelled" ? styles.cancelledBadge : ""}`}>{row.status}</span></td></tr>;
      })}</tbody></table></div>
      : <p className={styles.muted}>No email communications.</p>}
  </Style3Panel>;
}

function AssignedContractors({ rows }: { rows: ComplianceSummary["contractors"] }) {
  const [contacts, setContacts] = useState<Map<number, ContractorPrimaryContact> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [exportOpen, setExportOpen] = useState(false);
  useEffect(() => {
    let active = true;
    void getPrimaryContactsForContractors(rows.map(row => row.contractor_id)).then(result => {
      if (!active) return;
      if (result.error || !result.data) setError(result.error?.message ?? "Unable to load primary contacts.");
      else setContacts(result.data);
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load primary contacts.");
    });
    return () => { active = false; };
  }, [rows]);
  const visible = rows.filter(row => row.company_name.toLowerCase().includes(search.trim().toLowerCase()));
  return <Style3Panel title="Assigned Contractors" description="Active contractors with an active assignment on an active project.">
    <div className={styles.directorySearch}><label htmlFor="assigned-contractor-search">Search contractors</label>
      <input id="assigned-contractor-search" value={search} onChange={event => setSearch(event.target.value)} type="search" />
      <button type="button" className={styles.actionButton} onClick={() => setExportOpen(true)}>Export assigned contractors</button></div>
    {error ? <p role="alert" className={styles.error}>Unable to load primary contacts: {error}</p> : null}
    <div className={styles.tableWrap}><table><thead><tr><th>Contractor</th><th>Primary Contact</th></tr></thead>
      <tbody>{visible.map(row => {
        const contact = contacts?.get(row.contractor_id);
        return <tr key={row.contractor_id}><td><Link href={`/contractors/${row.contractor_id}`}>{row.company_name}</Link></td>
          <td>{error ? "Unavailable" : !contacts ? "Loading..." : contact
            ? <>{contact.contact_name}{contact.email ? <><br />{contact.email}</> : null}
              {contact.business_phone || contact.mobile_phone ? <><br />{contact.business_phone || contact.mobile_phone}</> : null}</>
            : "No Primary Contact"}</td></tr>;
      })}</tbody></table></div>
    {!visible.length ? <p className={styles.muted}>No assigned contractors found.</p> : null}
    {exportOpen ? <DashboardExportDialog contractorIds={visible.map(row => row.contractor_id)}
      dashboardFilter="Active Assigned Contractors" dashboardSearch={search} onClose={() => setExportOpen(false)} /> : null}
  </Style3Panel>;
}

function DashboardDetails({ data, onClose }: { data: ComplianceSummary; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<"filters" | "exceptions" | "assigned">("exceptions");
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="dashboard-details-title"
    onClose={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className={styles.dialogHeader}><h2 id="dashboard-details-title">Dashboard details</h2>
      <button type="button" onClick={() => dialog.current?.close()} aria-label="Close Dashboard details">×</button></div>
    <div className={styles.detailTabs} role="group" aria-label="Dashboard detail views">
      <button type="button" aria-pressed={tab === "filters"} onClick={() => setTab("filters")}>Status filters and PWC Missing</button>
      <button type="button" aria-pressed={tab === "exceptions"} onClick={() => setTab("exceptions")}>Known requirement exceptions</button>
      <button type="button" aria-pressed={tab === "assigned"} onClick={() => setTab("assigned")}>Assigned contractors</button>
    </div>
    {tab === "filters" ? <><p className={styles.detailNotice}>Legacy status filters use their existing company-wide record rules; they do not establish requirement applicability or the overall compliance rate above.</p><LegacyDashboard drilldown /></> : tab === "exceptions" ? <ComplianceExceptions data={data} />
      : <AssignedContractors rows={data.contractors} />}
  </dialog>;
}

export default function Style3Dashboard() {
  const profile = useSessionProfile();
  const allowed = (module: Parameters<typeof canAccessModule>[1]) => profile.system_administrator || canAccessModule(profile.permissions, module);
  const complianceAllowed = allowed("contractors") && allowed("projects") && allowed("compliance");
  const projectsAllowed = allowed("projects");
  const followupsAllowed = allowed("followups") && allowed("contractors");
  const emailAllowed = allowed("communications_summary");
  const activeContractors = useRead(allowed("contractors"), getActiveContractorCount);
  const compliance = useRead(complianceAllowed, loadCompliance);
  const projects = useRead(projectsAllowed, getActiveDashboardProjects);
  const followups = useRead(followupsAllowed, loadFollowups);
  const emails = useRead(emailAllowed, getRecentDashboardEmails);
  const [search, setSearch] = useState("");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const today = useSyncExternalStore(subscribeDate, currentDate, serverDate);
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return [
      ...(compliance.data?.contractors.filter(row => row.company_name.toLowerCase().includes(term)).map(row => ({
        label: row.company_name, href: `/contractors/${row.contractor_id}`,
      })) ?? []),
      ...(projects.data?.filter(row => `${row.project_number} ${row.project_name}`.toLowerCase().includes(term))
        .map(row => ({ label: `${row.project_number} ${row.project_name}`, href: `/projects?projectId=${row.id}` })) ?? []),
    ].filter((item, index, all) => all.findIndex(other => other.href === item.href) === index).slice(0, 8);
  }, [search, compliance.data, projects.data]);
  const val = <T,>(state: Load<T>, render: (data: T) => string | number) => state.error ? "!" : state.data === null ? "—" : render(state.data);
  return <main className={styles.dashboard}>
    <Style3Header help="Search current projects and assigned contractors. Use the navigation to open each module.">
      <div className={styles.search}><label className="sr-only" htmlFor="dashboard-search">Search active projects and assigned contractors</label>
        <Style3Icon name="Search" />
        <input id="dashboard-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search active projects or assigned contractors" />
        {search.trim() ? <div className={styles.searchResults}>{matches.length ? matches.map(row => <Link key={row.href} href={row.href}>{row.label}</Link>)
          : <p>No matches in loaded projects or assigned contractors.</p>}</div> : null}
      </div>
    </Style3Header>
    <div className={styles.content}>
      <div className={styles.welcome}><div><h1>Welcome back, {profile.name.split(" ")[0] || profile.name}!</h1>
        <p>Here&apos;s what&apos;s happening with your contractors and projects today.</p></div>
        <div className={styles.welcomeAside}><span>PEOPLE &nbsp; | &nbsp; PROJECTS &nbsp; | &nbsp; PROGRESS</span><time>{today}</time></div></div>
      <section className={styles.kpis} aria-label="Dashboard overview">
        {complianceAllowed ? <Kpi label="Active Contractors" value={val(activeContractors, value => value)} note={compliance.error ? "Assignment count unavailable" : compliance.data === null ? "Loading project assignments..." : `${compliance.data.population.toLocaleString()} with active project assignments`} icon="Contractors" href="/contractors" /> : null}
        {projectsAllowed ? <Kpi label="Active Projects" value={val(projects, value => value.length)} note="Current projects" icon="Projects" href="/projects" /> : null}
        {complianceAllowed ? <Kpi label="Compliance Rate" value={compliance.data?.overallCompliance.rate === null || compliance.data?.overallCompliance.rate === undefined
          ? "—" : `${compliance.data.overallCompliance.rate.toFixed(1)}%`}
        note="FEIN, NJ BRC, and applicable NJ PWC" icon="Compliance" href="/compliance" onDetails={compliance.data ? () => setDetailsOpen(true) : undefined} /> : null}
        {followupsAllowed ? <Kpi label="Open Follow-Ups" value={val(followups, value => value.length)} note="Company-wide" icon="Follow-Ups" href="/followups" /> : null}
        {complianceAllowed ? <Kpi label="Expiring Soon" value={val(compliance, value => value.expirations.filter(item => item.days <= 30).length)} note="Current requirements · next 30 days" icon="Calendar" href="/compliance" /> : null}
      </section>
      <div className={styles.charts}>
        {complianceAllowed ? <ReadState state={compliance} unavailable="Expiration data temporarily unavailable">{value => <Expirations data={value} />}</ReadState> : null}
        {complianceAllowed ? <ReadState state={compliance} unavailable="Compliance data temporarily unavailable">{value => <CompliancePanel data={value} />}</ReadState> : null}
      </div>
      <div className={styles.operations}>
        {allowed("contractors") ? <ContractorGrowth active={activeContractors} assigned={compliance} assignedAllowed={complianceAllowed} /> : null}
        {followupsAllowed ? <ReadState state={followups}>{value => <FollowupsPanel rows={value} />}</ReadState> : null}
        <div className={styles.stack}>
          {projectsAllowed && !projects.error ? <ReadState state={projects}>{value => <ProjectsPanel rows={value} />}</ReadState> : null}
          {emailAllowed ? <ReadState state={emails}>{value => <EmailPanel rows={value} canViewContent={allowed("communications_content")} />}</ReadState> : null}
        </div>
      </div>
      {complianceAllowed && compliance.data && detailsOpen ? <DashboardDetails data={compliance.data} onClose={() => setDetailsOpen(false)} /> : null}
      <footer className={styles.footer}><div><Style3Icon name="Reports" /><strong>Building a safer, more compliant tomorrow.</strong></div><span>Success is built through strong relationships. — Dobco</span></footer>
    </div>
  </main>;
}
