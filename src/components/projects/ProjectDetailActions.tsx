"use client";

import { useEffect, useRef, useState } from "react";
import { loadProjectExport, projectExportPdf, projectExportXlsx } from "@/services/project-export";

const button = "h-7 whitespace-nowrap rounded-md border border-transparent bg-slate-900 px-2 py-1 text-xs text-white hover:bg-slate-800 disabled:opacity-50";

export default function ProjectDetailActions({ projectId, projectNumber, disabled, onClose }: {
  projectId: number; projectNumber: string; disabled: boolean; onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  const download = async (format: "pdf" | "xlsx") => {
    setOpen(false); setBusy(true); setError(null);
    try {
      const sections = await loadProjectExport(projectId);
      const blob = format === "pdf" ? projectExportPdf(sections) : projectExportXlsx(sections);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Project-${projectNumber.replace(/[^a-z0-9_-]/gi, "_")}.${format}`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to export project.");
    } finally { setBusy(false); }
  };
  return <div className="flex min-w-0 flex-col items-end gap-2"><div className="flex shrink-0 items-center gap-2">
    <div ref={menu} className="relative">
      <button ref={trigger} type="button" className={button} disabled={disabled || busy}
        aria-expanded={open} aria-controls="project-export-options" onClick={() => setOpen(!open)}>
        {busy ? "Exporting..." : "Export"}
      </button>
      {open ? <div id="project-export-options" aria-label="Project export formats"
        className="absolute right-0 top-full z-10 mt-1 w-24 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
        {(["pdf", "xlsx"] as const).map(format => <button key={format} type="button"
          className="block w-full rounded px-2 py-1 text-left text-xs text-slate-700 hover:bg-slate-100 focus:bg-slate-100"
          onClick={() => void download(format)}>{format.toUpperCase()}</button>)}
      </div> : null}
    </div>
    <button type="button" className={button} onClick={onClose}>Close</button>
    </div>
    {error ? <p role="alert" className="max-w-64 break-words rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">{error}</p> : null}
  </div>;
}
