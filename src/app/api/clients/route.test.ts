import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const mockDb = vi.hoisted(() => ({
  client: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
}));

const mockAccess = vi.hoisted(() => ({
  requireFeature: vi.fn(async () => ({ id: "user-1", role: "ADMIN" })),
}));

const mockInternalApi = vi.hoisted(() => ({
  hasInternalApiAccess: vi.fn(() => false),
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/access", () => mockAccess);
vi.mock("@/lib/internal-api", () => mockInternalApi);

function makeGetRequest(searchParams?: Record<string, string>) {
  const url = new URL("http://localhost/api/clients");
  if (searchParams) {
    Object.entries(searchParams).forEach(([key, value]) => url.searchParams.set(key, value));
  }
  return new NextRequest(url);
}

function makePostRequest(body: unknown) {
  return new NextRequest("http://localhost/api/clients", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/clients", () => {
  it("returns active clients including those without any Instagram connection", async () => {
    mockDb.client.findMany.mockResolvedValue([
      {
        id: "client-1",
        name: "Existing Connected",
        connections: [
          { platform: "INSTAGRAM", sourceAccountId: "acc-1", displayName: "@existing" },
        ],
        _count: { reports: 2 },
      },
      {
        id: "client-2",
        name: "Newly Created",
        connections: [],
        _count: { reports: 0 },
      },
    ]);

    const response = await GET(makeGetRequest());
    const data = (await response.json()) as { clients: unknown[] };

    expect(response.status).toBe(200);
    expect(data.clients).toHaveLength(2);
    expect((data.clients[1] as { connections: unknown[] }).connections).toEqual([]);
    expect(mockDb.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: true }) }),
    );
  });

  it("returns archived clients when requested", async () => {
    mockDb.client.findMany.mockResolvedValue([
      { id: "client-3", name: "Archived", connections: [], _count: { reports: 0 } },
    ]);

    const response = await GET(makeGetRequest({ archived: "true" }));
    const data = (await response.json()) as { clients: unknown[] };

    expect(response.status).toBe(200);
    expect(data.clients).toHaveLength(1);
    expect(mockDb.client.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: false }) }),
    );
  });
});

describe("POST /api/clients", () => {
  it("creates a client with only a name and no Instagram connection", async () => {
    mockDb.client.create.mockResolvedValue({
      id: "client-new",
      name: "New Client",
      logoUrl: null,
      active: true,
    });

    const response = await POST(makePostRequest({ name: "New Client" }));
    const data = (await response.json()) as { client?: unknown; error?: string };

    expect(response.status).toBe(201);
    expect(data.client).toEqual({
      id: "client-new",
      name: "New Client",
      logoUrl: null,
      active: true,
    });
    expect(mockDb.client.create).toHaveBeenCalledWith({
      data: { name: "New Client" },
    });
  });

  it("rejects a client without a valid name", async () => {
    const response = await POST(makePostRequest({ name: "   " }));
    const data = (await response.json()) as { error?: string };

    expect(response.status).toBe(400);
    expect(data.error).toBeTruthy();
  });
});
