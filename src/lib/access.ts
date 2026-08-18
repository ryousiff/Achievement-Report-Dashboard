import type { NextRequest } from "next/server";
import { Role } from "@prisma/client";
import { getSessionUser } from "@/lib/session";

export const features = [
  "view_dashboard",
  "view_reports",
  "create_report",
  "edit_report",
  "approve_report",
  "export_report",
  "manage_clients",
  "delete_clients",
  "connect_meta",
  "assign_accounts",
  "view_audit",
  "manage_users",
  "manage_settings",
  "run_historical_sync",
  "connect_meta_system_user",
] as const;

export type Feature = (typeof features)[number];

// Role-based restrictions have been intentionally removed: every authenticated user gets every
// feature, regardless of ADMIN/EDITOR/VIEWER. The Role enum/column is kept (for display and any
// future need to reintroduce distinctions), but it no longer affects what a user can do.
export const roleFeatures: Record<Role, Feature[]> = {
  [Role.ADMIN]: [...features],
  [Role.EDITOR]: [...features],
  [Role.VIEWER]: [...features],
};

export function hasFeature(role: Role, feature: Feature) {
  return roleFeatures[role]?.includes(feature);
}

export async function requireFeature(request: NextRequest, feature: Feature) {
  const user = await getSessionUser(request);
  if (!user) return null;
  if (!hasFeature(user.role as Role, feature)) return null;
  return user;
}

export async function requireRole(request: NextRequest, roles: Role[]) {
  const user = await getSessionUser(request);
  if (!user || !roles.includes(user.role as Role)) return null;
  return user;
}

export async function requireAuth(request: NextRequest) {
  return getSessionUser(request);
}
