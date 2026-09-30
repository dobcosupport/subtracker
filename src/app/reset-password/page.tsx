"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Stage = "loading" | "ready" | "success" | "invalid";

export default function ResetPasswordPage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const markReady = () => {
      if (active) setStage("ready");
    };

    const checkSession = async () => {
      const { data } = await supabase.auth.getSession();
      if (data.session) markReady();
      else if (active) setStage((current) => (current === "loading" ? "invalid" : current));
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) markReady();
    });
    const frame = window.requestAnimationFrame(checkSession);
    return () => {
      active = false;
      window.cancelAnimationFrame(frame);
      subscription.unsubscribe();
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Use a password with at least 8 characters.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }
    // Sign out after reset; the user must log in explicitly with the new password.
    await supabase.auth.signOut();
    setStage("success");
    window.setTimeout(() => router.replace("/login"), 2500);
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#f5f7fb] px-4 py-8">
      <section className="w-full max-w-sm border border-slate-200 bg-white p-6 shadow-sm sm:p-7">
        <div className="mb-4 flex justify-center">
          <Image src="/Logo.png" alt="Dobco Group" width={172} height={172} priority className="h-auto max-h-[100px] w-auto max-w-full object-contain" />
        </div>
        <h1 className="text-center text-2xl font-semibold text-slate-900">SubTracker</h1>

        {stage === "loading" ? (
          <p className="mt-5 text-center text-sm text-slate-500">Verifying your password reset link...</p>
        ) : stage === "invalid" ? (
          <>
            <h2 className="mt-1 text-center text-sm font-medium text-slate-500">Reset link invalid or expired</h2>
            <p className="mt-5 text-center text-sm text-slate-600">Request a new password reset from the login page.</p>
            <a href="/login" className="mt-5 block text-center text-sm text-indigo-700 hover:underline">Back to login</a>
          </>
        ) : stage === "success" ? (
          <>
            <h2 className="mt-4 text-center text-lg font-semibold text-emerald-700">Password Updated Successfully</h2>
            <p className="mt-4 text-center text-sm text-slate-500">Redirecting to login...</p>
          </>
        ) : (
          <>
            <h2 className="mt-1 text-center text-sm font-medium text-slate-500">Reset your password</h2>
            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <label className="block text-sm font-medium text-slate-700">New Password
                <input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
              </label>
              <label className="block text-sm font-medium text-slate-700">Confirm Password
                <input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
              </label>
              {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
              <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">{busy ? "Please wait..." : "Update Password"}</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
