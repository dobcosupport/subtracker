"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import AppSidebar from "@/components/AppSidebar";
import { canAccessModule, moduleForPath } from "@/lib/permissions";
import { supabase } from "@/lib/supabase";
import type { RolePermission, UserProfile } from "@/types/user-management";
import { SessionContext, type SessionProfile } from "./SessionContext";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublicPage = pathname === "/login" || pathname === "/setup";
  const bootstrapStarted = useRef(false);
  const [profile, setProfile] = useState<SessionProfile | null>(null);
  const [accessError, setAccessError] = useState<string | null>(null);

  useEffect(() => {
    if (isPublicPage) return;

    let active = true;
    const loadProfile = async (accessToken: string) => {
      const response = await fetch("/api/auth/session", {
        headers: { Authorization: `Bearer ${accessToken}` },
        cache: "no-store",
      });
      const body = await response.json() as { profile?: UserProfile; permissions?: RolePermission[]; error?: string };
      if (!active) return;
      if (!response.ok || !body.profile) {
        setProfile(null);
        setAccessError(body.error ?? "Unable to verify account access.");
        await supabase.auth.signOut();
        router.replace("/login");
        return;
      }
      setProfile({ ...body.profile, permissions: body.permissions ?? [] });
      setAccessError(null);
    };

    const restoreSession = async () => {
      if (!bootstrapStarted.current) {
        bootstrapStarted.current = true;
        try {
          await fetch("/api/admin/bootstrap", { method: "POST", cache: "no-store" });
        } catch {
          // Continue to session restoration if the seed endpoint is unavailable.
        }
      }
      const { data: { session } } = await supabase.auth.getSession();
      if (!active) return;
      if (!session) {
        router.replace(`/login?next=${encodeURIComponent(pathname)}`);
        return;
      }
      await loadProfile(session.access_token);
    };

    void restoreSession();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_OUT" || !session) {
        setProfile(null);
        router.replace("/login");
      } else if (event === "SIGNED_IN" || event === "TOKEN_REFRESHED" || event === "USER_UPDATED") {
        void loadProfile(session.access_token);
      }
    });

    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [isPublicPage, pathname, router]);

  if (isPublicPage) return <>{children}</>;
  if (!profile && !accessError) return <div className="flex min-h-screen items-center justify-center text-sm text-slate-500">Checking account access...</div>;
  if (!profile) return <div className="flex min-h-screen items-center justify-center px-6 text-center text-sm text-red-700">{accessError}</div>;

  const currentModule = moduleForPath(pathname);
  if (!canAccessModule(profile.permissions, currentModule, "view")) {
    const moduleName = currentModule === "imports" ? "Import / Export" : "this";
    return (
      <div className="ml-72 flex min-h-screen items-center justify-center p-8">
        <div className="max-w-md text-center">
          <h1 className="text-xl font-semibold text-slate-900">Access Denied</h1>
          <p className="mt-2 text-sm text-slate-600">You do not have permission to access the {moduleName} module.</p>
          <Link href="/" className="mt-4 inline-block rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800">Return to Dashboard</Link>
        </div>
      </div>
    );
  }

  return (
    <SessionContext.Provider value={profile}>
      <AppSidebar profile={profile} permissions={profile.permissions} />
      <div className="ml-72 min-h-screen">{children}</div>
    </SessionContext.Provider>
  );
}
