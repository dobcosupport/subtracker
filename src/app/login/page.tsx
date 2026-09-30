"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type LoginMode = "sign-in" | "recover";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);

    if (mode === "recover") {
      try {
        const response = await fetch("/api/auth/recovery", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() }),
        });
        const result = await response.json() as { error?: string; message?: string };
        setError(response.ok ? null : result.error ?? "Unable to send password reset email.");
        setMessage(response.ok ? result.message ?? "If the account exists, a password reset email has been sent." : null);
      } catch {
        setError("Unable to send password reset email.");
        setMessage(null);
      } finally {
        setBusy(false);
      }
      return;
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (signInError) {
      setError(signInError.message);
      setBusy(false);
      return;
    }
    router.replace("/");
  };

  const title = mode === "sign-in" ? "Login" : "Reset password";
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-4 py-8">
      <section className="w-full max-w-sm border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
        <div className="mb-4 flex justify-center">
          <Image src="/Logo.png" alt="Dobco Group" width={172} height={172} priority className="h-auto max-h-[100px] w-auto max-w-full object-contain" />
        </div>
        <h1 className="text-center text-2xl font-semibold text-slate-900">SubTracker</h1>
        <h2 className="mt-1 text-center text-sm font-medium text-slate-500">{title}</h2>
        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          <label className="block text-sm font-medium text-slate-700">Email
            <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
          </label>
          {mode === "sign-in" ? (
            <label className="block text-sm font-medium text-slate-700">Password
              <input type="password" autoComplete="current-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
            </label>
          ) : null}
          {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
          {message ? <p role="status" className="text-sm text-emerald-700">{message}</p> : null}
          <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">{busy ? "Please wait..." : title}</button>
        </form>
        <div className="mt-4 flex justify-between text-sm">
          {mode === "sign-in" ? <><button type="button" onClick={() => { setMode("recover"); setError(null); setMessage(null); }} className="text-indigo-700 hover:underline">Forgot password?</button><a href="/setup" className="text-slate-500 hover:text-slate-800">Initial Setup</a></> : <button type="button" onClick={() => { setMode("sign-in"); setError(null); setMessage(null); }} className="text-indigo-700 hover:underline">Back to login</button>}
        </div>
      </section>
    </main>
  );
}
