import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockMinioInstance = vi.hoisted(() => ({
  bucketExists: vi.fn(async () => true),
  makeBucket: vi.fn(async () => {}),
  putObject: vi.fn(async () => {}),
  statObject: vi.fn(async () => ({ metaData: { "content-type": "image/jpeg" } })),
  getObject: vi.fn(async () => ({})),
}));

vi.mock("minio", () => ({
  Client: vi.fn().mockImplementation(() => mockMinioInstance),
}));

vi.mock("@/lib/observability", () => ({
  logError: vi.fn(),
  logEvent: vi.fn(),
}));

const originalEnv = { ...process.env };

function setConfigured() {
  process.env.MINIO_ENDPOINT = "localhost";
  process.env.MINIO_PORT = "9000";
  process.env.MINIO_ACCESS_KEY = "access-key";
  process.env.MINIO_SECRET_KEY = "secret-key";
  process.env.MINIO_BUCKET = "test-bucket";
}

function setUnconfigured() {
  delete process.env.MINIO_ACCESS_KEY;
  delete process.env.MINIO_SECRET_KEY;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("mediaThumbnailKey / mediaThumbnailUrl", () => {
  it("builds a stable per-connection/per-post key", async () => {
    const { mediaThumbnailKey } = await import("@/lib/media-storage");
    expect(mediaThumbnailKey("conn-1", "post-1")).toBe("posts/conn-1/post-1.jpg");
  });

  it("returns null for a missing key and a proxy URL for a present one", async () => {
    const { mediaThumbnailUrl } = await import("@/lib/media-storage");
    expect(mediaThumbnailUrl(null)).toBeNull();
    expect(mediaThumbnailUrl(undefined)).toBeNull();
    expect(mediaThumbnailUrl("posts/conn-1/post-1.jpg")).toBe("/api/media/posts/conn-1/post-1.jpg");
  });
});

describe("persistMediaThumbnail", () => {
  it("returns null without attempting network access when MinIO is not configured", async () => {
    setUnconfigured();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { persistMediaThumbnail } = await import("@/lib/media-storage");

    const result = await persistMediaThumbnail("https://example.com/thumb.jpg", "posts/conn-1/post-1.jpg");

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("downloads and stores the image, returning the storage key", async () => {
    setConfigured();
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    vi.stubGlobal("fetch", fetchSpy);
    const { persistMediaThumbnail } = await import("@/lib/media-storage");

    const result = await persistMediaThumbnail("https://example.com/thumb.jpg", "posts/conn-1/post-1.jpg");

    expect(result).toBe("posts/conn-1/post-1.jpg");
    expect(mockMinioInstance.putObject).toHaveBeenCalledWith(
      "test-bucket",
      "posts/conn-1/post-1.jpg",
      expect.any(Buffer),
      8,
      { "Content-Type": "image/jpeg" },
    );
    vi.unstubAllGlobals();
  });

  it("returns null when the source URL has expired (non-2xx response)", async () => {
    setConfigured();
    const fetchSpy = vi.fn(async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }));
    vi.stubGlobal("fetch", fetchSpy);
    const { persistMediaThumbnail } = await import("@/lib/media-storage");

    const result = await persistMediaThumbnail("https://example.com/expired.jpg", "posts/conn-1/post-2.jpg");

    expect(result).toBeNull();
    expect(mockMinioInstance.putObject).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("returns null and does not throw when the download itself fails", async () => {
    setConfigured();
    const fetchSpy = vi.fn(async () => { throw new Error("network error"); });
    vi.stubGlobal("fetch", fetchSpy);
    const { persistMediaThumbnail } = await import("@/lib/media-storage");

    await expect(persistMediaThumbnail("https://example.com/thumb.jpg", "posts/conn-1/post-3.jpg")).resolves.toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("readMediaThumbnail", () => {
  it("returns null when MinIO is not configured", async () => {
    setUnconfigured();
    const { readMediaThumbnail } = await import("@/lib/media-storage");
    expect(await readMediaThumbnail("posts/conn-1/post-1.jpg")).toBeNull();
  });

  it("returns the object stream and content type when found", async () => {
    setConfigured();
    const { readMediaThumbnail } = await import("@/lib/media-storage");

    const result = await readMediaThumbnail("posts/conn-1/post-1.jpg");

    expect(result).not.toBeNull();
    expect(result?.contentType).toBe("image/jpeg");
  });

  it("returns null when the object does not exist", async () => {
    setConfigured();
    mockMinioInstance.statObject.mockRejectedValueOnce(new Error("NotFound"));
    const { readMediaThumbnail } = await import("@/lib/media-storage");

    expect(await readMediaThumbnail("posts/conn-1/missing.jpg")).toBeNull();
  });
});
