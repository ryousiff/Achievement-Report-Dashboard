import { beforeEach, describe, expect, it, vi } from "vitest";
import { Role } from "@prisma/client";

const mockGetSessionUser = vi.hoisted(() => vi.fn());
vi.mock("@/lib/session", () => ({ getSessionUser: mockGetSessionUser }));

import { features, hasFeature, requireAuth, requireFeature, requireRole, roleFeatures } from "@/lib/access";
import type { NextRequest } from "next/server";

const roles = [Role.ADMIN, Role.EDITOR, Role.VIEWER];

beforeEach(() => {
  mockGetSessionUser.mockReset();
});

describe("roleFeatures", () => {
  it("grants every feature to every role", () => {
    for (const role of roles) {
      expect(new Set(roleFeatures[role])).toEqual(new Set(features));
    }
  });

  it("gives ADMIN, EDITOR, and VIEWER the exact same feature set", () => {
    const adminSet = new Set(roleFeatures[Role.ADMIN]);
    const editorSet = new Set(roleFeatures[Role.EDITOR]);
    const viewerSet = new Set(roleFeatures[Role.VIEWER]);
    expect(editorSet).toEqual(adminSet);
    expect(viewerSet).toEqual(adminSet);
  });
});

describe("hasFeature", () => {
  it("returns true for every feature regardless of role", () => {
    for (const role of roles) {
      for (const feature of features) {
        expect(hasFeature(role, feature)).toBe(true);
      }
    }
  });
});

describe("requireFeature", () => {
  it("still requires authentication (returns null when there is no session user)", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    const result = await requireFeature({} as NextRequest, "manage_users");
    expect(result).toBeNull();
  });

  it("grants any feature to an authenticated user of any role", async () => {
    for (const role of roles) {
      const user = { id: "u1", email: "u@example.com", name: "U", role };
      mockGetSessionUser.mockResolvedValue(user);
      for (const feature of ["manage_users", "delete_clients", "run_historical_sync", "connect_meta_system_user"] as const) {
        expect(await requireFeature({} as NextRequest, feature)).toEqual(user);
      }
    }
  });
});

describe("requireRole / requireAuth", () => {
  it("requireRole still enforces authentication and an explicit role allow-list", async () => {
    const viewer = { id: "u2", email: "v@example.com", name: "V", role: Role.VIEWER };
    mockGetSessionUser.mockResolvedValue(viewer);
    expect(await requireRole({} as NextRequest, [Role.VIEWER])).toEqual(viewer);
    expect(await requireRole({} as NextRequest, [Role.ADMIN])).toBeNull();

    mockGetSessionUser.mockResolvedValue(null);
    expect(await requireRole({} as NextRequest, [Role.ADMIN, Role.EDITOR, Role.VIEWER])).toBeNull();
  });

  it("requireAuth only checks that a session exists", async () => {
    mockGetSessionUser.mockResolvedValue(null);
    expect(await requireAuth({} as NextRequest)).toBeNull();

    const user = { id: "u3", email: "a@example.com", name: "A", role: Role.VIEWER };
    mockGetSessionUser.mockResolvedValue(user);
    expect(await requireAuth({} as NextRequest)).toEqual(user);
  });
});
