import { beforeEach, describe, expect, it, vi } from "vitest";
import { InsightPeriodType, Platform } from "@prisma/client";
import { ConnectorError } from "@/lib/connectors/types";
import { runMonthEndCloseout } from "@/lib/month-end-closeout";

const mockDb = vi.hoisted(() => ({
  socialConnection: { findUnique: vi.fn() },
  socialInsightSnapshot: { findMany: vi.fn(), count: vi.fn() },
  socialPost: { findMany: vi.fn(), count: vi.fn() },
}));

const mockMetaSync = vi.hoisted(() => ({
  postInsights: vi.fn(),
  upsertPost: vi.fn(),
}));

const mockReportData = vi.hoisted(() => ({
  fetchAndStoreDailyFollowerMovement: vi.fn(),
}));

const mockMetaSyncInsights = vi.hoisted(() => ({
  fetchCompletedMonthTotals: vi.fn(),
  storeCompletedMonthTotals: vi.fn(),
  fetchAndStoreAccountInsight: vi.fn(),
  completedMonthsWithinLookback: vi.fn(),
}));

const mockTokenEncryption = vi.hoisted(() => ({ decryptToken: vi.fn() }));

vi.mock("@/lib/db", () => ({ db: mockDb }));
vi.mock("@/lib/meta-sync", () => mockMetaSync);
vi.mock("@/lib/meta-sync-insights", () => mockMetaSyncInsights);
vi.mock("@/lib/report-data", () => mockReportData);
vi.mock("@/lib/token-encryption", () => mockTokenEncryption);
vi.mock("@/lib/observability", () => ({ logEvent: vi.fn(), logError: vi.fn() }));
vi.mock("@/lib/post-metric-snapshots", () => ({
  monthPeriodUTC: (date: Date) => ({
    periodStart: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)),
    periodEnd: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) - 1),
  }),
  isMonthFinalized: (periodEnd: Date, now: Date) => periodEnd.valueOf() < now.valueOf(),
}));
vi.mock("@/lib/env", () => ({
  getHistoricalBackfillConfig: () => ({
    months: 15,
    accountInsightMaxLookbackDays: 450,
    accountInsightChunkDays: 30,
  }),
}));
vi.mock("@/lib/backfill-window", () => ({
  calculateBackfillStart: () => new Date("2025-01-01T00:00:00.000Z"),
}));

function pairedFollowerRows(days: number) {
  return Array.from({ length: days }, (_, i) => {
    const periodStart = new Date(`2026-08-${String(i + 1).padStart(2, "0")}T07:00:00.000Z`);
    return [
      { metric: "followers_gained", periodStart },
      { metric: "followers_lost", periodStart },
    ];
  }).flat();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTokenEncryption.decryptToken.mockReturnValue("token");
  mockDb.socialConnection.findUnique.mockResolvedValue({
    id: "conn-1",
    platform: Platform.INSTAGRAM,
    externalAccountId: "ig-1",
    encryptedToken: "encrypted",
  });
  mockMetaSyncInsights.completedMonthsWithinLookback.mockReturnValue([
    { start: new Date("2026-08-01T00:00:00.000Z"), end: new Date("2026-08-31T23:59:59.999Z") },
  ]);
  mockDb.socialInsightSnapshot.findMany.mockImplementation(async (args: { where: { periodType: InsightPeriodType; metric?: unknown } }) => {
    if (args.where.periodType === InsightPeriodType.TOTAL_VALUE) {
      return ["reach", "views", "followers_gained", "followers_lost"].map((metric) => ({ metric }));
    }
    if (args.where.periodType === InsightPeriodType.DAY && typeof args.where.metric === "object") {
      return pairedFollowerRows(30); // Aug 31 is deliberately missing.
    }
    return [];
  });
  mockDb.socialInsightSnapshot.count.mockResolvedValue(31); // reach is complete.
  mockDb.socialPost.count.mockResolvedValue(0);
  mockDb.socialPost.findMany.mockResolvedValue([]);
});

describe("month-end closeout follower response safety", () => {
  it("normalizes a raw follower parser TypeError into a delayed retryable request failure", async () => {
    mockReportData.fetchAndStoreDailyFollowerMovement.mockRejectedValue(
      new TypeError("Cannot read properties of undefined (reading 'map')"),
    );

    await expect(runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"))).rejects.toMatchObject({
      code: "request_failed",
      retryAfterMs: 15 * 60 * 1000,
    });

    try {
      await runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"));
    } catch (error) {
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as Error).message).not.toContain("reading 'map'");
    }
  });

  it("preserves Meta rate-limit errors so the shared cooldown remains authoritative", async () => {
    const rateLimit = new ConnectorError("(#4) Application request limit reached", "rate_limited", 300_000);
    mockReportData.fetchAndStoreDailyFollowerMovement.mockRejectedValue(rateLimit);

    await expect(runMonthEndCloseout("conn-1", new Date("2026-09-02T00:00:00.000Z"))).rejects.toBe(rateLimit);
  });
});
