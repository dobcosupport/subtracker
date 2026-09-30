"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

type Stage = "loading" | "ready" | "success" | "invalid";

export default function InvitePage() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const applyUser = (user: { email?: string | null; user_metadata?: Record<string, unknown> } | null) => {
      if (!active || !user) return;
      setEmail(user.email ?? null);
      const metadataRole = user.user_metadata?.role;
      setRole(typeof metadataRole === "string" ? metadataRole : null);
      setStage("ready");
    };

    const loadInvitedUser = async () => {
      const { data } = await supabase.auth.getUser();
      if (data.user) applyUser(data.user);
      else if (active) setStage((current) => (current === "loading" ? "invalid" : current));
    };
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      applyUser(session?.user ?? null);
    });
    const frame = window.requestAnimationFrame(loadInvitedUser);
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
    // Password is set for a brand new account; sign out so the user must log in explicitly.
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
          <p className="mt-5 text-center text-sm text-slate-500">Verifying your invitation...</p>
        ) : stage === "invalid" ? (
          <>
            <h2 className="mt-1 text-center text-sm font-medium text-slate-500">Invitation link invalid or expired</h2>
            <p className="mt-5 text-center text-sm text-slate-600">Ask your administrator to send a new invitation, or return to the login page.</p>
            <a href="/login" className="mt-5 block text-center text-sm text-indigo-700 hover:underline">Back to login</a>
          </>
        ) : stage === "success" ? (
          <>
            <h2 className="mt-4 text-center text-lg font-semibold text-emerald-700">Password Successfully Set</h2>
            <p className="mt-2 text-center text-sm text-slate-600">Your SubTracker account is now active.</p>
            <p className="mt-4 text-center text-sm text-slate-500">Redirecting to login...</p>
          </>
        ) : (
          <>
            <h2 className="mt-1 text-center text-sm font-medium text-slate-500">Activate your account</h2>
            <div className="mt-4 space-y-1 border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm">
              <p><span className="font-medium text-slate-700">Email:</span> <span className="text-slate-600">{email}</span></p>
              {role ? <p><span className="font-medium text-slate-700">Role:</span> <span className="text-slate-600">{role}</span></p> : null}
            </div>
            <form onSubmit={handleSubmit} className="mt-5 space-y-4">
              <label className="block text-sm font-medium text-slate-700">Password
                <input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
              </label>
              <label className="block text-sm font-medium text-slate-700">Confirm Password
                <input type="password" autoComplete="new-password" minLength={8} required value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2.5 font-normal" />
              </label>
              {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : null}
              <button type="submit" disabled={busy} className="w-full rounded-md bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50">{busy ? "Please wait..." : "Activate Account"}</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
