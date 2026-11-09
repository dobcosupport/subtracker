"use client";

import { useEffect, useState, type ReactNode } from "react";
import AppSidebar from "@/components/AppSidebar";
import { useSessionProfile } from "@/components/SessionContext";
import styles from "./shell.module.css";

export default function Style3Shell({ children }: { children: ReactNode }) {
  const profile = useSessionProfile();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 900px)");
    const update = () => setSidebarOpen(!media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return <>
    <button type="button" className={`${styles.menuButton} ${!sidebarOpen ? styles.menuClosed : ""}`} aria-expanded={sidebarOpen} aria-controls="app-navigation"
      aria-label={sidebarOpen ? "Close menu" : "Menu"} onClick={() => setSidebarOpen(value => !value)}><span aria-hidden="true">☰</span></button>
    <AppSidebar profile={profile} permissions={profile.permissions} style3 open={sidebarOpen}
      onNavigate={() => { if (window.matchMedia("(max-width: 900px)").matches) setSidebarOpen(false); }} />
    <div className={`${styles.dashboardContent} ${!sidebarOpen ? styles.contentExpanded : ""}`}>{children}</div>
  </>;
}
