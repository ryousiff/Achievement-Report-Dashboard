import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn() },
  socialPost: { findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/token-encryption", () => ({ decryptToken: (token: string) => token }));

const mockMetaSync = vi.hoisted(() => ({
  graph: vi.fn(),
  MetaSyncError: class MetaSyncError extends Error {
    code: string;
    retryAfterMs?: number;
    constructor(message: string, code: "rate_limited" | "request_failed", retryAfterMs?: number) {
      super(message);
      this.code = code;
      this.retryAfterMs = retryAfterMs;
    }
  },
}));
vi.mock("@/lib/meta-sync", () => mockMetaSync);

const mockMediaStorage = vi.hoisted(() => ({
  mediaThumbnailKey: (connectionId: string, externalPostId: string) => `posts/${connectionId}/${externalPostId}.jpg`,
  persistMediaThumbnail: vi.fn(),
}));
vi.mock("@/lib/media-storage", () => mockMediaStorage);

import { countPendingThumbnails, runThumbnailBackfillChunk } from "@/lib/media-backfill";

function post(externalPostId: string, overrides: Record<string, unknown> = {}) {
  return { id: `row-${externalPostId}`, externalPostId, mediaUrl: "https://example.com/media.jpg", thumbnailUrl: "https://example.com/thumb.jpg", ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.socialConnection.findUnique.mockResolvedValue({ encryptedToken: "token" });
  mockDb.socialPost.update.mockResolvedValue({});
});

describe("runThumbnailBackfillChunk", () => {
  it("only fetches a small, bounded batch (respects THUMBNAIL_BACKFILL_BATCH_SIZE)", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([]);
    mockDb.socialPost.count.mockResolvedValue(0);

    await runThumbnailBackfillChunk("conn-1");

    const args = mockDb.socialPost.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ connectionId: "conn-1", thumbnailStorageKey: null });
    expect(typeof args.take).toBe("number");
    expect(args.take).toBeGreaterThan(0);
  });

  it("stores posts whose fresh URL persists successfully", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([post("p1"), post("p2")]);
    mockDb.socialPost.count.mockResolvedValue(0);
    mockMetaSync.graph.mockResolvedValue({ thumbnail_url: "https://cdn.example.com/fresh.jpg" });
    mockMediaStorage.persistMediaThumbnail.mockResolvedValue("posts/conn-1/p1.jpg");

    const result = await runThumbnailBackfillChunk("conn-1");

    expect(result).toEqual({ stored: 2, skipped: 0, remaining: 0 });
    expect(mockDb.socialPost.update).toHaveBeenCalledTimes(2);
  });

  it("skips a post whose thumbnail fails to persist without aborting the rest of the batch", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([post("p1"), post("p2")]);
    mockDb.socialPost.count.mockResolvedValue(0);
    mockMetaSync.graph.mockResolvedValue({ thumbnail_url: "https://cdn.example.com/fresh.jpg" });
    mockMediaStorage.persistMediaThumbnail
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("posts/conn-1/p2.jpg");

    const result = await runThumbnailBackfillChunk("conn-1");

    expect(result).toEqual({ stored: 1, skipped: 1, remaining: 0 });
    expect(mockDb.socialPost.update).toHaveBeenCalledTimes(1);
  });

  it("skips a post whose Meta refetch fails for a non-rate-limit reason, falling back to the stored URL", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([post("p1")]);
    mockDb.socialPost.count.mockResolvedValue(0);
    mockMetaSync.graph.mockRejectedValue(new mockMetaSync.MetaSyncError("permanent error", "request_failed"));
    mockMediaStorage.persistMediaThumbnail.mockResolvedValue("posts/conn-1/p1.jpg");

    const result = await runThumbnailBackfillChunk("conn-1");

    expect(result.stored).toBe(1);
    // Falls back to the already-stored thumbnailUrl since the Meta refresh failed.
    expect(mockMediaStorage.persistMediaThumbnail).toHaveBeenCalledWith("https://example.com/thumb.jpg", "posts/conn-1/p1.jpg");
  });

  it("rethrows a rate-limit error immediately instead of continuing to process the rest of the batch", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([post("p1"), post("p2")]);
    mockMetaSync.graph.mockRejectedValue(new mockMetaSync.MetaSyncError("(#4) Application request limit reached", "rate_limited"));

    await expect(runThumbnailBackfillChunk("conn-1")).rejects.toThrow("Application request limit reached");
    expect(mockMediaStorage.persistMediaThumbnail).not.toHaveBeenCalled();
    expect(mockDb.socialPost.update).not.toHaveBeenCalled();
  });

  it("reports how many posts are still remaining after the batch", async () => {
    mockDb.socialPost.findMany.mockResolvedValue([post("p1")]);
    mockDb.socialPost.count.mockResolvedValue(37);
    mockMetaSync.graph.mockResolvedValue({ thumbnail_url: "https://cdn.example.com/fresh.jpg" });
    mockMediaStorage.persistMediaThumbnail.mockResolvedValue("posts/conn-1/p1.jpg");

    const result = await runThumbnailBackfillChunk("conn-1");

    expect(result.remaining).toBe(37);
  });

  it("returns an empty result when the connection no longer exists", async () => {
    mockDb.socialConnection.findUnique.mockResolvedValue(null);

    const result = await runThumbnailBackfillChunk("missing-conn");

    expect(result).toEqual({ stored: 0, skipped: 0, remaining: 0 });
    expect(mockDb.socialPost.findMany).not.toHaveBeenCalled();
  });
});

describe("countPendingThumbnails", () => {
  it("only counts posts with a null thumbnailStorageKey", async () => {
    mockDb.socialPost.count.mockResolvedValue(5);

    const count = await countPendingThumbnails("conn-1");

    expect(count).toBe(5);
    expect(mockDb.socialPost.count).toHaveBeenCalledWith({ where: { connectionId: "conn-1", thumbnailStorageKey: null } });
  });
});
