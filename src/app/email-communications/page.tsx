"use client";

import { useState } from "react";
import Link from "next/link";
import EmailComposer from "@/components/EmailComposer";
import EmailHistory from "@/components/EmailHistory";
import DobcoContactsPanel from "@/components/DobcoContactsPanel";
import NotificationsPanel from "@/components/NotificationsPanel";
import CommunicationChannelSettings from "@/components/CommunicationChannelSettings";
import CommunicationTemplatesPanel from "@/components/CommunicationTemplatesPanel";
import { useSessionProfile } from "@/components/SessionContext";
import { canAccessModule } from "@/lib/permissions";
import styles from "@/components/email-workspace.module.css";

const areas = ["New Message", "Drafts", "Scheduled", "Sent", "Templates", "Contacts", "Settings"] as const;
type Area = (typeof areas)[number];
const icons = ["M4 20h4L20 8l-4-4L4 16v4Zm10-14 4 4", "M6 3h9l4 4v14H6V3Zm8 0v5h5", "M12 8v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  "m3 11 18-8-8 18-3-7-7-3Zm7 3L21 3", "M4 4h16v16H4V4Zm4 5h8M8 13h8M8 17h4", "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4 8a4 4 0 0 1 5 4v2",
  "M4 7h16M4 17h16M8 4v6M16 14v6"];

export default function EmailCommunicationsPage() {
  const [area, setArea] = useState<Area>("New Message");
  const [draft, setDraft] = useState<string | undefined>();
  const [composerKey, setComposerKey] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [contactType, setContactType] = useState("dobco");
  const { permissions } = useSessionProfile();
  const canViewSettings = canAccessModule(permissions, "settings");
  const canCompose = canAccessModule(permissions, "communications_content", "add");
  const canEdit = canAccessModule(permissions, "communications_content", "edit");
  function edit(id: string) { setDraft(id); setComposerKey(i => i + 1); setArea("New Message"); }
  return <main className={styles.workspace}>
    <header className={styles.heading}><div><h1>Email Communications</h1><p>Your SubTracker communication workspace</p></div>
      <span className={styles.badge}>Email workspace</span></header>
    <div className={styles.layout}>
      <nav className={styles.navigation} role="tablist" aria-label="Email Communications areas" aria-orientation="vertical">
        {areas.map((name, i) => <button key={name} type="button" role="tab" id={`email-tab-${i}`} aria-selected={area === name}
          aria-controls={`email-panel-${i}`} onClick={() => setArea(name)}>
          <span className={styles.navigationIcon}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d={icons[i]} /></svg></span>
          <span>{name}</span>
        </button>)}
      </nav>
      <div className={styles.body}>
        <section id="email-panel-0" role="tabpanel" aria-labelledby="email-tab-0" hidden={area !== "New Message"}>
          {canCompose || (draft && canEdit) ? <EmailComposer key={composerKey} draftId={draft} active={area === "New Message"} onClose={() => {
            setArea("Drafts"); setDraft(undefined); setComposerKey(i => i + 1);
          }} onSaved={() => setRefresh(i => i + 1)} /> : <p className={styles.hint}>Communications Content Add permission is required to start a message.</p>}
          {draft && canCompose ? <div className={styles.panel}><button type="button" className={styles.secondary} onClick={() => { setDraft(undefined); setComposerKey(i => i + 1); }}>Start another message</button></div> : null}
        </section>
        {(["Drafts", "Scheduled", "Sent"] as const).map((folder, i) => area === folder ? <section key={folder} id={`email-panel-${i + 1}`} role="tabpanel" aria-labelledby={`email-tab-${i + 1}`}>
          <EmailHistory folder={folder} refresh={refresh} onEdit={edit} />
        </section> : null)}
        {area === "Templates" ? <section id="email-panel-4" role="tabpanel" aria-labelledby="email-tab-4" className={styles.panel}>
          {canViewSettings ? <CommunicationTemplatesPanel /> : <p className={styles.hint}>Settings View permission is required.</p>}
        </section> : null}
        {area === "Contacts" ? <section id="email-panel-5" role="tabpanel" aria-labelledby="email-tab-5" className={styles.panel}>
          <header className={styles.panelHeader}><div><h2>Contacts</h2><p>Use your existing Dobco and contractor contact records.</p></div>
            <select aria-label="Contact source" value={contactType} onChange={e => setContactType(e.target.value)}><option value="dobco">Dobco contacts</option><option value="contractor">Contractor contacts</option></select></header>
          {contactType === "dobco" ? canViewSettings ? <DobcoContactsPanel /> : <p className={styles.hint}>Settings View permission is required.</p>
            : <p className={styles.hint}>Search contractor contacts in the To field. To maintain their individual email preferences, <Link href="/contractors">open the existing Contractor directory</Link> and select a company.</p>}
        </section> : null}
        {area === "Settings" ? <section id="email-panel-6" role="tabpanel" aria-labelledby="email-tab-6" className={styles.panel}>
          {canViewSettings ? <><CommunicationChannelSettings channel="email" workspace /><details className={styles.detail}><summary>Automated compliance notifications</summary><NotificationsPanel /></details></>
            : <p className={styles.hint}>Settings View permission is required.</p>}
        </section> : null}
      </div>
    </div>
  </main>;
}
