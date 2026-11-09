"use client";

import type { ReactNode } from "react";
import { useSessionProfile } from "@/components/SessionContext";
import { supabase } from "@/lib/supabase";
import Style3Icon from "./Style3Icon";
import styles from "./header.module.css";

export default function Style3Header({ children, pageName, help = "Use the navigation to open each module." }: {
  children?: ReactNode; pageName?: string; help?: string;
}) {
  const profile = useSessionProfile();
  return <header className={styles.topbar}><strong>Sub<span>Tracker</span></strong>
    {children ?? <span className={styles.pageName}>{pageName}</span>}
    <details className={styles.headerDetail}><summary aria-label="Help">?</summary><div>{help}</div></details>
    <details className={styles.headerDetail}><summary aria-label="Notifications"><Style3Icon name="Follow-Ups" /></summary><div>Notification center is not available.</div></details>
    <details className={styles.headerDetail}><summary aria-label="Account menu"><span className={styles.headerAvatar}>{profile.name.split(/\s+/).slice(0, 2).map(part => part[0]).join("").toUpperCase()}</span><span aria-hidden="true">⌄</span></summary>
      <div>{profile.name}<br />{profile.role}<br /><button type="button" className={styles.headerSignOut}
        onClick={() => void supabase.auth.signOut()}>Sign Out</button></div></details>
  </header>;
}
