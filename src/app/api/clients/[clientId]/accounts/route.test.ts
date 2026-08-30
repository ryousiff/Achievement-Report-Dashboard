import { describe, expect, it, vi, beforeEach } from "vitest";
import { PUT } from "./route";

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(async (ops: unknown[]) => Promise.all(ops as Promise<unknown>[])),
  client: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  metaAccount: {
    findMany: vi.fn(),
  },
  socialConnection: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    upsert: vi.fn(),
  },
}));

const mockAccess = vi.hoisted(() => ({
  requireFeature: vi.fn(async () => ({ id: "user-1", role: "ADMIN" })),
}));

const mockTokenEncryption = vi.hoisted(() => ({
  decryptToken: vi.fn(() => "token-123"),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/access", () => mockAccess);
vi.mock("@/lib/token-encryption", () => mockTokenEncryption);

function makeRequest(clientId: string, body: unknown) {
  return new Request(`http://localhost/api/clients/${clientId}/accounts`, {
    method: "PUT",
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  global.fetch = vi.fn();
});

describe("PUT /api/clients/[clientId]/accounts", () => {
  it("persists an Instagram SocialConnection for a previously unconnected client", async () => {
    mockDb.client.findUnique.mockResolvedValue({
      id: "client-new",
      logoUrl: null,
    });
    mockDb.metaAccount.findMany.mockResolvedValue([
      {
        id: "meta-account-ig",
        platform: "INSTAGRAM",
        externalAccountId: "17841400000000000",
        displayName: "@newclient",
        encryptedToken: "enc-token",
        tokenExpiresAt: null,
        lastSyncedAt: null,
      },
    ]);
    mockDb.socialConnection.findMany.mockResolvedValue([]);

    const response = await PUT(makeRequest("client-new", { accountIds: ["meta-account-ig"] }), {
      params: Promise.resolve({ clientId: "client-new" }),
    });

    expect(response.status).toBe(200);
    expect(mockDb.socialConnection.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ clientId: "client-new" }) }),
    );
    expect(mockDb.socialConnection.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          clientId_platform_externalAccountId: {
            clientId: "client-new",
            platform: "INSTAGRAM",
            externalAccountId: "17841400000000000",
          },
        },
        create: expect.objectContaining({
          clientId: "client-new",
          sourceAccountId: "meta-account-ig",
          platform: "INSTAGRAM",
          externalAccountId: "17841400000000000",
          displayName: "@newclient",
        }),
      }),
    );
  });

  it("does not change other clients when assigning an account", async () => {
    mockDb.client.findUnique.mockResolvedValue({ id: "client-new", logoUrl: null });
    mockDb.metaAccount.findMany.mockResolvedValue([
      {
        id: "meta-account-ig",
        platform: "INSTAGRAM",
        externalAccountId: "17841400000000000",
        displayName: "@newclient",
        encryptedToken: "enc-token",
        tokenExpiresAt: null,
        lastSyncedAt: null,
      },
    ]);
    mockDb.socialConnection.findMany.mockResolvedValue([]);

    await PUT(makeRequest("client-new", { accountIds: ["meta-account-ig"] }), {
      params: Promise.resolve({ clientId: "client-new" }),
    });

    expect(mockDb.socialConnection.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clientId: "client-new",
          sourceAccountId: { not: null },
        }),
      }),
    );
  });

  it("rejects assigning an account already assigned to another client", async () => {
    mockDb.client.findUnique.mockResolvedValue({ id: "client-new", logoUrl: null });
    mockDb.metaAccount.findMany.mockResolvedValue([
      {
        id: "meta-account-ig",
        platform: "INSTAGRAM",
        externalAccountId: "17841400000000000",
        displayName: "@taken",
        encryptedToken: "enc-token",
        tokenExpiresAt: null,
        lastSyncedAt: null,
      },
    ]);
    mockDb.socialConnection.findMany.mockResolvedValue([
      { displayName: "@taken" },
    ]);

    const response = await PUT(makeRequest("client-new", { accountIds: ["meta-account-ig"] }), {
      params: Promise.resolve({ clientId: "client-new" }),
    });
    const data = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(data.error).toContain("already assigned");
    expect(mockDb.socialConnection.upsert).not.toHaveBeenCalled();
  });
});
