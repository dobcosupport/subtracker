"use client";

import { useCallback, useEffect, useState } from "react";

export default function InitialAdminSetupPage() {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ensureSystemAdministrator = useCallback(async () => {
    setError(null);
    setMessage(null);
    setBusy(true);
    try {
      const response = await fetch("/api/admin/bootstrap", { method: "POST", cache: "no-store" });
      const result = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(result.error ?? "System administrator setup failed.");
      setMessage(result.message ?? "System administrator account is ready.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "System administrator setup failed.");
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => { void ensureSystemAdministrator(); }, 0);
    return () => window.clearTimeout(timeout);
  }, [ensureSystemAdministrator]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-5 py-10">
      <section className="w-full max-w-md border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-xs font-semibold uppercase text-indigo-600">Administration</p>
        <h1 className="mt-2 text-2xl font-semibold text-slate-900">System administrator</h1>
        <dl className="mt-6 space-y-3 text-sm">
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Name</dt><dd className="font-medium text-slate-800">Rich Gulino</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Email</dt><dd className="font-medium text-slate-800">richg@dobcogroup.com</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Role</dt><dd className="font-medium text-slate-800">Administrator</dd></div>
          <div className="flex justify-between gap-4"><dt className="text-slate-500">Authentication Source</dt><dd className="font-medium text-slate-800">Local</dd></div>
        </dl>
        {busy ? <p role="status" className="mt-5 text-sm text-slate-500">Checking administrator account...</p> : null}
        {message ? <p role="status" className="mt-5 border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{message}</p> : null}
        {error ? <p role="alert" className="mt-5 border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
        <div className="mt-6 flex items-center justify-between gap-3">
          <button type="button" onClick={() => void ensureSystemAdministrator()} disabled={busy} className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">Retry setup</button>
          <a href="/login" className="text-sm font-medium text-indigo-700 hover:underline">Sign in</a>
        </div>
      </section>
    </main>
  );
}
