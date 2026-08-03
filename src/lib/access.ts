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
  "connect_meta",
  "assign_accounts",
  "view_audit",
  "manage_users",
  "manage_settings",
  "run_historical_sync",
] as const;

export type Feature = (typeof features)[number];

export const roleFeatures: Record<Role, Feature[]> = {
  [Role.ADMIN]: [...features],
  [Role.EDITOR]: [
    "view_dashboard",
    "view_reports",
    "create_report",
    "edit_report",
    "approve_report",
    "export_report",
    "manage_clients",
    "connect_meta",
    "assign_accounts",
  ],
  [Role.VIEWER]: [
    "view_dashboard",
    "view_reports",
  ],
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
