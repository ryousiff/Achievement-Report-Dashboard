import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackfillStatus, MediaSource } from "@prisma/client";

vi.hoisted(() => {
  process.env.META_SYNC_MIN_INTERVAL_MS = "1";
});

const stores = vi.hoisted(() => ({
  connections: new Map<string, any>(),
  posts: new Map<string, any>(),
}));

function applyUpdate(existing: Record<string, unknown>, data: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value && typeof value === "object" && "increment" in value && typeof value.increment === "number") {
      existing[key] = ((existing[key] as number) ?? 0) + value.increment;
    } else {
      existing[key] = value;
    }
  }
  return existing;
}

const mockDb = vi.hoisted(() => ({
  socialConnection: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => stores.connections.get(where.id) ?? null),
    findMany: vi.fn(async () => Array.from(stores.connections.values())),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const existing = stores.connections.get(where.id) ?? {};
      const updated = applyUpdate(existing, data);
      stores.connections.set(where.id, updated);
      return updated;
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => data),
  },
  socialPost: {
    upsert: vi.fn(async ({ where, create, update }: {
      where: { connectionId_externalPostId: { connectionId: string; externalPostId: string } };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }) => {
      const key = `${where.connectionId_externalPostId.connectionId}:${where.connectionId_externalPostId.externalPostId}`;
      const existing = stores.posts.get(key);
      if (existing) {
        const updated = { ...existing };
        for (const [k, v] of Object.entries(update)) {
          if (v === undefined) continue;
          updated[k] = v;
        }
        stores.posts.set(key, updated);
        return updated;
      }
      stores.posts.set(key, { ...create });
      return stores.posts.get(key);
    }),
    findMany: vi.fn(async () => Array.from(stores.posts.values())),
    aggregate: vi.fn(async () => ({ _min: { publishedAt: null }, _max: { publishedAt: null }, _count: 0 })),
  },
  socialInsightSnapshot: { findMany: vi.fn(async () => []) },
  syncJob: { create: vi.fn(async (data: unknown) => data), findFirst: vi.fn(async () => null) },
}));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/token-encryption", () => ({ decryptToken: (token: string) => token }));

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

import { runIncrementalSync, runHistoricalBackfillChunk, runHistoricalCollaborativeBackfillChunk, MetaSyncError } from "@/lib/meta-sync";

const defaultConnection = {
  id: "conn-1",
  platform: "INSTAGRAM" as const,
  externalAccountId: "17841400000000000",
  encryptedToken: "fake-token",
  lastSuccessfulSyncAt: null,
  lastIncrementalSyncAt: null,
  historicalBackfillStatus: BackfillStatus.NOT_STARTED,
  historicalBackfillStart: null,
  historicalBackfillCursor: null,
  historicalBackfillPageIndex: 0,
  historicalBackfillStartedAt: null,
  historicalBackfillCompletedAt: null,
  historicalBackfillLastError: null,
  historicalBackfillRetryCount: 0,
  historicalBackfillProcessedPosts: 0,
  collaborativeBackfillStatus: BackfillStatus.NOT_STARTED,
  collaborativeBackfillStart: null,
  collaborativeBackfillCursor: null,
  collaborativeBackfillPageIndex: 0,
  collaborativeBackfillStartedAt: null,
  collaborativeBackfillCompletedAt: null,
  collaborativeBackfillLastError: null,
  collaborativeBackfillRetryCount: 0,
  collaborativeBackfillProcessedPosts: 0,
};

function setupConnection(overrides: Record<string, unknown> = {}) {
  stores.connections.set("conn-1", { ...defaultConnection, ...overrides });
  stores.posts.clear();
}

function buildResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    headers: { get: () => null },
    json: async () => body,
  };
}

type MockFetchMatch = { test: (url: string) => boolean; response: (url: string) => unknown; status?: (url: string) => number };

function setFetch(matches: MockFetchMatch[]) {
  mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const match of matches) {
      if (match.test(url)) {
        const body = match.response(url);
        const status = match.status ? match.status(url) : 200;
        return buildResponse(body, status);
      }
    }
    return buildResponse({ data: [] }, 200);
  });
}

function mediaItem(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    caption: "Post",
    media_type: "IMAGE",
    media_url: "https://example.com/image.jpg",
    thumbnail_url: "https://example.com/thumb.jpg",
    permalink: `https://instagram.com/p/${id}`,
    timestamp: new Date().toISOString(),
    like_count: 10,
    comments_count: 2,
    ...overrides,
  };
}

function emptyPage() {
  return { data: [], paging: {} };
}

function paginatedPage(items: unknown[], nextCursor?: string) {
  return { data: items, paging: nextCursor ? { cursors: { after: nextCursor } } : {} };
}

const metricValues: Record<string, number> = { views: 100, total_views: 100, reach: 50, saved: 5, shares: 2, total_interactions: 117, follows: 1, facebook_views: 0 };

function singleInsight(metric: string, value: number) {
  return { data: [{ name: metric, values: [{ value }] }] };
}

function insightFor(url: string) {
  const u = new URL(url);
  const metric = u.searchParams.get("metric") ?? "views";
  const metrics = metric.split(",").map((m) => m.trim()).filter(Boolean);
  if (metrics.length === 0) metrics.push("views");
  return { data: metrics.map((m) => ({ name: m, values: [{ value: metricValues[m] ?? 1 }] })) };
}

function defaultMatches(pageData: Record<string, unknown> = {}) {
  return [
    {
      test: (url: string) => url.includes("/insights"),
      response: (url: string) => insightFor(url),
    },
    ...Object.entries(pageData).map(([endpoint, page]) => ({
      test: (url: string) => url.includes(`/${endpoint}`) && url.includes("access_token="),
      response: () => page,
    })),
  ];
}

beforeEach(() => {
  mockFetch.mockReset();
  stores.connections.clear();
  stores.posts.clear();
  process.env.HISTORICAL_BACKFILL_POSTS_PER_RUN = "100";
  process.env.HISTORICAL_BACKFILL_API_CALL_BUDGET = "1000";
  process.env.HISTORICAL_BACKFILL_MAX_RUNTIME_MS = "60000";
  process.env.COLLABORATIVE_RECONCILIATION_DAYS = "60";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("runIncrementalSync", () => {
  it("stores owned media and skips empty collaborative media", async () => {
    setupConnection();
    setFetch(defaultMatches({
      media: paginatedPage([mediaItem("owned-1")]),
      collaborative_media: emptyPage(),
    }));

    const result = await runIncrementalSync("conn-1");
    expect(result.posts).toBe(1);

    const post = stores.posts.get("conn-1:owned-1")!;
    expect(post).toBeDefined();
    expect(post.mediaSource).toBe(MediaSource.OWNED);
    expect(post.mediaMetadata).toBeUndefined();
    expect(post.metrics.views).toBe(100);
    expect(post.metrics.total_views).toBe(100);
    expect(post.metrics.follows).toBe(1);
    expect(post.metricAvailabilityState.follows).toBe("AVAILABLE");
  });

  it("stores collaborative media with owner and collaborator metadata", async () => {
    setupConnection();
    setFetch(defaultMatches({
      media: emptyPage(),
      collaborative_media: paginatedPage([mediaItem("collab-1", {
        owner: { id: "owner-1", username: "original_owner" },
        collaborators: [{ id: "conn-1", username: "me" }],
      })]),
    }));

    const result = await runIncrementalSync("conn-1");
    expect(result.posts).toBe(1);

    const post = stores.posts.get("conn-1:collab-1")!;
    expect(post).toBeDefined();
    expect(post.mediaSource).toBe(MediaSource.COLLABORATIVE);
    expect(post.mediaMetadata).toEqual({
      originalOwnerId: "owner-1",
      originalOwnerUsername: "original_owner",
      collaborators: [{ id: "conn-1", username: "me" }],
    });
  });

  it("stores both owned and collaborative media in one run", async () => {
    setupConnection();
    setFetch(defaultMatches({
      media: paginatedPage([mediaItem("owned-1")]),
      collaborative_media: paginatedPage([mediaItem("collab-1", { owner: { id: "o1" } })]),
    }));

    const result = await runIncrementalSync("conn-1");
    expect(result.posts).toBe(2);
    expect(stores.posts.size).toBe(2);
  });

  it("does not duplicate when the same media id appears in both endpoints", async () => {
    setupConnection();
    setFetch(defaultMatches({
      media: paginatedPage([mediaItem("shared-1")]),
      collaborative_media: paginatedPage([mediaItem("shared-1", { owner: { id: "owner-1" } })]),
    }));

    const result = await runIncrementalSync("conn-1");
    expect(result.posts).toBe(2);
    expect(stores.posts.size).toBe(1);

    const post = stores.posts.get("conn-1:shared-1")!;
    expect(post.mediaSource).toBe(MediaSource.OWNED); // owned wins and is never downgraded
    expect(post.mediaMetadata).toBeUndefined(); // owned refresh clears metadata on update
  });

  it("paginates through collaborative media", async () => {
    setupConnection();
    setFetch([
      { test: (url: string) => url.includes("/insights"), response: (url: string) => insightFor(url) },
      { test: (url: string) => url.includes("/media"), response: () => emptyPage() },
      { test: (url: string) => url.includes("/collaborative_media") && !url.includes("after="), response: () => paginatedPage([mediaItem("collab-1")], "page2") },
      { test: (url: string) => url.includes("/collaborative_media") && url.includes("after=page2"), response: () => paginatedPage([mediaItem("collab-2")]) },
    ]);

    const result = await runIncrementalSync("conn-1");
    expect(result.posts).toBe(2);
    expect(stores.posts.get("conn-1:collab-2")).toBeDefined();
  });

  it("discovers a newly accepted collaboration older than the 2-day owned window", async () => {
    const anchor = new Date("2026-08-10T00:00:00.000Z");
    const postDate = new Date("2026-08-05T00:00:00.000Z"); // 5 days before anchor, within 60-day collab window
    setupConnection({
      lastIncrementalSyncAt: anchor,
    });

    setFetch([
      {
        test: (url: string) => url.includes("/insights"),
        response: (url: string) => insightFor(url),
      },
      {
        test: (url: string) => url.includes("/media"),
        response: () => emptyPage(),
      },
      {
        test: (url: string) => url.includes("/collaborative_media"),
        response: () => paginatedPage([mediaItem("collab-1", { timestamp: postDate.toISOString(), owner: { id: "owner-1" } })]),
      },
    ]);

    const result = await runIncrementalSync("conn-1");
    expect(result.posts).toBe(1);
    const post = stores.posts.get("conn-1:collab-1")!;
    expect(post.mediaSource).toBe(MediaSource.COLLABORATIVE);
  });

  it("does not store an unavailable collaborative insight as zero", async () => {
    setupConnection();
    setFetch([
      {
        test: (url: string) => url.includes("/insights") && url.includes("follows"),
        response: () => ({ error: { code: 200, message: "Permissions error" } }),
        status: () => 403,
      },
      {
        test: (url: string) => url.includes("/insights"),
        response: (url: string) => insightFor(url),
      },
      {
        test: (url: string) => url.includes("/collaborative_media"),
        response: () => paginatedPage([mediaItem("collab-1", { owner: { id: "owner-1" } })]),
      },
      {
        test: (url: string) => url.includes("/media"),
        response: () => emptyPage(),
      },
    ]);

    await runIncrementalSync("conn-1");
    const post = stores.posts.get("conn-1:collab-1")!;
    expect(post).toBeDefined();
    expect("follows" in (post.metrics as Record<string, unknown>)).toBe(false);
    expect((post.metricAvailabilityState as Record<string, unknown>).follows).toBe("PERMISSION_DENIED");
  });
});

describe("runHistoricalCollaborativeBackfillChunk", () => {
  it("resumes safely from a mid-page stop", async () => {
    process.env.HISTORICAL_BACKFILL_POSTS_PER_RUN = "1";
    const start = new Date("2026-01-01T00:00:00.000Z");
    setupConnection({
      collaborativeBackfillStart: start,
    });

    const page = paginatedPage([
      mediaItem("collab-1", { timestamp: "2026-02-01T00:00:00.000Z" }),
      mediaItem("collab-2", { timestamp: "2026-02-02T00:00:00.000Z" }),
    ]);

    let requestCount = 0;
    setFetch([
      {
        test: (url: string) => url.includes("/insights"),
        response: (url: string) => insightFor(url),
      },
      {
        test: (url: string) => url.includes("/collaborative_media"),
        response: () => { requestCount++; return page; },
      },
    ]);

    const first = await runHistoricalCollaborativeBackfillChunk("conn-1");
    expect(first.completed).toBe(false);

    const conn = stores.connections.get("conn-1")!;
    expect(conn.collaborativeBackfillStatus).toBe(BackfillStatus.PARTIAL);
    expect(conn.collaborativeBackfillPageIndex).toBe(1);
    expect(conn.collaborativeBackfillCursor).toBeNull();
    expect(conn.collaborativeBackfillProcessedPosts).toBe(1);
    expect(stores.posts.get("conn-1:collab-1")).toBeDefined();

    const second = await runHistoricalCollaborativeBackfillChunk("conn-1");
    expect(second.completed).toBe(true);
    expect(conn.collaborativeBackfillStatus).toBe(BackfillStatus.COMPLETED);
    expect(stores.posts.size).toBe(2);
    expect(requestCount).toBe(2);
  });
});

describe("MetaSyncError", () => {
  it("classifies permission errors as permanent", () => {
    const err = new MetaSyncError("Permission denied", "request_failed", undefined, true, 200);
    expect(err.permanent).toBe(true);
    expect(err.metaErrorCode).toBe(200);
  });
});
