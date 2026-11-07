"use client";

import { useEffect, useState } from "react";
import { canAccessModule } from "@/lib/permissions";
import { getActiveProjectWorkTypes, type ProjectWorkTypeCount } from "@/services/style3-project-metrics";
import { useSessionProfile } from "@/components/SessionContext";
import Style3Panel from "./Style3Panel";
import styles from "./style3.module.css";

export default function ProjectWorkTypeChart() {
  const profile = useSessionProfile();
  const allowed = profile.system_administrator || canAccessModule(profile.permissions, "projects");
  return allowed ? <Chart /> : null;
}

function Chart() {
  const [counts, setCounts] = useState<ProjectWorkTypeCount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void getActiveProjectWorkTypes().then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        setError(result.error?.message ?? "Unable to load active project types.");
        return;
      }
      setCounts(result.data);
    }, (reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : "Unable to load active project types.");
    });
    return () => { active = false; };
  }, []);

  const max = Math.max(1, ...(counts ?? []).map((item) => item.count));
  return <Style3Panel title="Active Projects by Work Type" description="Current active projects; historical growth is unavailable.">
    {error ? <p role="alert" className={styles.error}>{error}</p>
      : !counts ? <p role="status" className={styles.description}>Loading active projects...</p>
        : <div className={styles.chart} aria-label="Active projects by work type">
          {counts.map((item) => <div key={item.type} className={styles.barRow}>
            <span className={styles.barLabel}>{item.type}</span>
            <span className={styles.barTrack}><span className={styles.barFill} style={{ width: `${100 * item.count / max}%` }} /></span>
            <strong>{item.count}</strong>
          </div>)}
        </div>}
  </Style3Panel>;
}
