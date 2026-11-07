import type { ReactNode } from "react";

const icons: Record<string, ReactNode> = {
  Dashboard: <><path d="M3 11 12 3l9 8" /><path d="M5 10v10h14V10M10 20v-6h4v6" /></>,
  Contractors: <><circle cx="9" cy="8" r="3" /><path d="M3 20v-2a6 6 0 0 1 12 0v2zM16 5a3 3 0 0 1 0 6M17 14a5 5 0 0 1 4 5v1h-3" /></>,
  Projects: <><path fill="currentColor" stroke="none" d="M10 3.2a2 2 0 0 1 4 0v1.1c3.5.8 5.8 3.7 5.8 7.5v3h.7c.8 0 1.5.7 1.5 1.5v.7c0 1-1 1.8-2 2.1-4.9 1.4-11.1 1.4-16 0C3 18.8 2 18 2 17v-.7c0-.8.7-1.5 1.5-1.5h.7v-3c0-3.8 2.3-6.7 5.8-7.5z" /><path d="M10 4v7M14 4v7M4.5 16.8c4.8 1.2 10.2 1.2 15 0" stroke="white" strokeWidth="1.15" /></>,
  Documents: <><path d="M5 3h9l5 5v13H5zM14 3v5h5M8 12h8M8 16h8" /></>,
  Compliance: <><path d="m12 3 8 3v5c0 5-3 8-8 10-5-2-8-5-8-10V6z" /><path d="m8 12 3 3 5-6" /></>,
  "Follow-Ups": <><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5zM10 20h4" /></>,
  "Email Communications": <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></>,
  Reports: <><path d="M4 20V11h4v9M10 20V4h4v16M16 20v-7h4v7" /></>,
  "User Management": <><circle cx="12" cy="8" r="4" /><path d="M4 20a8 8 0 0 1 16 0" /></>,
  "Roles & Permissions": <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
  "Company Merge": <><path d="M4 20V5h7v15M11 20V9h9v11M7 8h1M7 12h1M14 12h2M14 16h2" /></>,
  "Import / Export": <><path d="M3 8h17m-4-4 4 4-4 4M21 16H4m4-4-4 4 4 4" /></>,
  Logs: <><path d="M9 6h12M9 12h12M9 18h12M4 6h1M4 12h1M4 18h1" /></>,
  "Compliance Sync": <><path d="M4 10a8 8 0 0 1 14-4l2 2M20 4v4h-4M20 14a8 8 0 0 1-14 4l-2-2M4 20v-4h4" /></>,
  Settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>,
  Calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4M17 3v4M3 10h18M7 14h2M12 14h2M7 18h2" /></>,
  Search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
};

export default function Style3Icon({ name, className }: { name: string; className?: string }) {
  return <svg className={className} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{icons[name] ?? icons.Dashboard}</svg>;
}
