"use client";

import { useState } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";
import styles from "./login.module.css";

type LoginMode = "sign-in" | "recover";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<LoginMode>("sign-in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

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

  const title = mode === "sign-in" ? "Sign In" : "Reset password";
  return (
    <main className={styles.page}>
      <section className={styles.card} aria-label="Account access">
        <div className={styles.authContent}>
          <div className={styles.brand}>
            <Image src="/Logo.png" alt="Dobco Group" width={172} height={172} priority className={styles.brandLogo} />
            <h1>Sub<span>Tracker</span></h1>
            <p>{mode === "sign-in" ? "Sign in to your account" : "Reset your password"}</p>
          </div>
          <form onSubmit={handleSubmit} className={styles.form}>
            <label className={styles.label}>Email
              <span className={styles.inputWrap}>
                <svg className={styles.inputIcon} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="5" width="18" height="14" rx="1" /><path d="m4 7 8 6 8-6" /></svg>
                <input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Enter your email address" />
              </span>
            </label>
            {mode === "sign-in" ? (
              <>
                <div className={styles.label}>
                  <label htmlFor="login-password">Password</label>
                  <span className={styles.inputWrap}>
                    <svg className={styles.inputIcon} aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>
                    <input id="login-password" type={showPassword ? "text" : "password"} autoComplete="current-password" minLength={8} required value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" />
                    <button className={styles.visibility} type="button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword}>
                      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></svg>
                    </button>
                  </span>
                </div>
                <div className={styles.formOptions}>
                  <span>Session stays signed in on this device</span>
                  <button type="button" onClick={() => { setMode("recover"); setError(null); setMessage(null); }}>Forgot password?</button>
                </div>
              </>
            ) : <p className={styles.recoveryHelp}>Enter your email address to request a password reset link.</p>}
            {error ? <p role="alert" className={styles.error}>{error}</p> : null}
            {message ? <p role="status" className={styles.message}>{message}</p> : null}
            <button type="submit" disabled={busy} className={styles.submit}>{busy ? "Please wait..." : title}{!busy && mode === "sign-in" ? <span aria-hidden="true">→</span> : null}</button>
          </form>
          {mode === "sign-in" ? (
            <div className={styles.setupSection}>
              <div className={styles.divider}><span>OR</span></div>
              <a href="/setup" className={styles.setup}>
                <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M10 2h4l.6 2.4 2.1.9 2.1-1.3 2.8 2.8-1.3 2.1.9 2.1 2.4.6v4l-2.4.6-.9 2.1 1.3 2.1-2.8 2.8-2.1-1.3-2.1.9L14 22h-4l-.6-2.4-2.1-.9-2.1 1.3-2.8-2.8 1.3-2.1-.9-2.1L2 15.4v-4l2.4-.6.9-2.1L4 6.6l2.8-2.8 2.1 1.3 2.1-.9L10 2Z" /><circle cx="12" cy="13" r="3" /></svg>
                Initial Setup
              </a>
            </div>
          ) : <button type="button" className={styles.back} onClick={() => { setMode("sign-in"); setError(null); setMessage(null); }}>Back to login</button>}
        </div>
        <p className={styles.secure}><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></svg>Secure access to Dobco SubTracker</p>
      </section>
    </main>
  );
}
