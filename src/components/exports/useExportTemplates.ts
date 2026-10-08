"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchExportTemplates, setTemplatePreference } from "@/services/export-templates";
import type { ExportTemplate, TemplatePreference } from "@/types/export-template";

export function useExportTemplates() {
  const [templates, setTemplates] = useState<ExportTemplate[]>([]);
  const [preferences, setPreferences] = useState<TemplatePreference[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [preferenceBusy, setPreferenceBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const load = useCallback((request: AbortController) => {
    return fetchExportTemplates(request.signal).then((result) => {
      if (!request.signal.aborted) { setTemplates(result.templates); setPreferences(result.preferences); }
    }).catch((reason: unknown) => {
      if (!request.signal.aborted) setError(reason instanceof Error ? reason.message : "Unable to load templates.");
    }).finally(() => {
      if (!request.signal.aborted) setLoading(false);
    });
  }, []);
  const refresh = useCallback(async () => {
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setLoading(true);
    setError(null);
    await load(request);
  }, [load]);
  useEffect(() => {
    mounted.current = true;
    const request = new AbortController();
    controller.current = request;
    void load(request);
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [load]);
  const preference = async (id: string, favorite: boolean, isDefault: boolean) => {
    if (preferenceBusy) return;
    setPreferenceBusy(true);
    setError(null);
    try {
      await setTemplatePreference(id, favorite, isDefault);
      if (mounted.current) await refresh();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : "Unable to save preference.");
    } finally {
      if (mounted.current) setPreferenceBusy(false);
    }
  };
  return { templates, preferences, error, loading, preferenceBusy, refresh, preference, setError };
}
