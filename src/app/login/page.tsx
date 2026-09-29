"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type LoginMode = "sign-in" | "recover" | "set-password";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const detectPasswordLink = () => {
      const hash = new URLSearchParams(window.location.hash.slice(1));
      if (["invite", "recovery"].includes(hash.get("type") ?? "")) setMode("set-password");
    };
    const frame = window.requestAnimationFrame(detectPasswordLink);
    window.addEventListener("hashchange", detectPasswordLink);
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") setMode("set-password");
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", detectPasswordLink);
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setBusy(true);

    if (mode === "recover") {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL;
      if (!appUrl) {
        setError("Application URL is not configured.");
        setBusy(false);
        return;
      }
      const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: new URL("/login", appUrl).toString(),
      });
      setError(resetError?.message ?? null);
      setMessage(resetError ? null : "Password recovery email sent.");
      setBusy(false);
      return;
    }

    if (mode === "set-password") {
      if (password.length < 8 || password !== confirmPassword) {
        setError(password.length < 8 ? "Use a password with at least 8 characters." : "Passwords do not match.");
        setBusy(false);
        return;
      }
      const { error: updateError } = await supabase.auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        setBusy(false);
        return;
      }
      router.replace("/");
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

  const title = mode === "sign-in" ? "Login" : mode === "recover" ? "Reset password" : "Set your password";
  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-4 py-8">
      <section className="w-full max-w-sm border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
        <div className="mb-4 flex justify-center">
          <Image src="/Logo.png" alt="Dobco Group" width={172} height={172} priority className="h-auto max-h-[100px] w-auto max-w-full object-contain" />
        </div>
        <h1 className="text-center text-2xl font-semibold text-slate-900">SubTracker</h1>
        <h2 className="mt-1 text-center text-sm font-medium text-slate-500">{title}</h2>
        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {mode !== "set-password" ? (
            <label className="block text-sm font-medium text-slate-700">Email
              <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
            </label>
          ) : null}
          {mode !== "recover" ? (
            <label className="block text-sm font-medium text-slate-700">{mode === "set-password" ? "New password" : "Password"}
              <input type="password" autoComplete={mode === "sign-in" ? "current-password" : "new-password"} minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
            </label>
          ) : null}
          {mode === "set-password" ? (
            <label className="block text-sm font-medium text-slate-700">Confirm password
              <input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
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
