"use client";

import { createContext, useContext } from "react";
import type { PermissionAction, RolePermission, UserProfile } from "@/types/user-management";

export type SessionProfile = UserProfile & { permissions: RolePermission[] };
export const SessionContext = createContext<SessionProfile | null>(null);

export function useSessionProfile(): SessionProfile {
  const profile = useContext(SessionContext);
  if (!profile) throw new Error("Session information is unavailable.");
  return profile;
}

export function templatePermission(profile: SessionProfile, action: PermissionAction): boolean {
  if (profile.system_administrator) return true;
  const permission = profile.permissions.find((entry) => entry.module === "imports");
  if (!permission?.can_view) return false;
  return permission[`can_${action}`];
}

export function isTemplateAdministrator(profile: SessionProfile): boolean {
  return profile.system_administrator || profile.role === "Administrator";
}
