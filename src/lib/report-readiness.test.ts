import { describe, expect, it } from "vitest";
import {
  COVERAGE_CHECK_ERROR_MESSAGE,
  COVERAGE_READY_MESSAGE,
  isCoverageReady,
  mapCoverageCheckFailure,
  summarizeCoverageIssues,
} from "@/lib/report-readiness";

describe("mapCoverageCheckFailure", () => {
  it("never exposes the raw/technical error message, e.g. 'fetch failed'", () => {
    expect(mapCoverageCheckFailure(new Error("fetch failed"))).toBe(COVERAGE_CHECK_ERROR_MESSAGE);
    expect(mapCoverageCheckFailure(new TypeError("Failed to fetch"))).toBe(COVERAGE_CHECK_ERROR_MESSAGE);
    expect(mapCoverageCheckFailure("some raw string thrown")).toBe(COVERAGE_CHECK_ERROR_MESSAGE);
    expect(mapCoverageCheckFailure(undefined)).toBe(COVERAGE_CHECK_ERROR_MESSAGE);
  });

  it("always returns the same friendly Arabic message regardless of the failure", () => {
    const message = mapCoverageCheckFailure(new Error("connection refused"));
    expect(message).toContain("تعذّر التحقق من حالة البيانات");
    expect(message).not.toContain("fetch");
    expect(message).not.toContain("refused");
  });
});

describe("summarizeCoverageIssues", () => {
  it("returns backend coverage warnings when coverage is incomplete", () => {
    const issues = summarizeCoverageIssues(
      { status: "PARTIAL", warnings: ["بيانات المنشورات لا تزال قيد المزامنة لهذه الفترة."] },
      null,
    );
    expect(issues).toEqual(["بيانات المنشورات لا تزال قيد المزامنة لهذه الفترة."]);
  });

  it("returns the collaborative-post coverage warning unchanged", () => {
    const issues = summarizeCoverageIssues(
      { status: "PARTIAL", warnings: ["بيانات المنشورات التعاونية لا تزال قيد المزامنة لهذه الفترة."] },
      null,
    );
    expect(issues).toEqual(["بيانات المنشورات التعاونية لا تزال قيد المزامنة لهذه الفترة."]);
  });

  it("returns no issues when coverage is COMPLETE and the check itself succeeded", () => {
    expect(summarizeCoverageIssues({ status: "COMPLETE", warnings: [] }, null)).toEqual([]);
  });

  it("appends (never replaces) a failed status-check message alongside already-known coverage warnings", () => {
    const issues = summarizeCoverageIssues(
      { status: "PARTIAL", warnings: ["بيانات المنشورات لا تزال قيد المزامنة لهذه الفترة."] },
      COVERAGE_CHECK_ERROR_MESSAGE,
    );
    expect(issues).toEqual([
      "بيانات المنشورات لا تزال قيد المزامنة لهذه الفترة.",
      COVERAGE_CHECK_ERROR_MESSAGE,
    ]);
  });

  it("shows only the check-failure message when there is no previously-known coverage yet", () => {
    expect(summarizeCoverageIssues(null, COVERAGE_CHECK_ERROR_MESSAGE)).toEqual([
      COVERAGE_CHECK_ERROR_MESSAGE,
    ]);
  });
});

describe("isCoverageReady", () => {
  it("is true only when coverage is COMPLETE and there is no pending check error", () => {
    expect(isCoverageReady({ status: "COMPLETE", warnings: [] }, null)).toBe(true);
  });

  it("is false when coverage is not COMPLETE", () => {
    expect(isCoverageReady({ status: "PARTIAL", warnings: [] }, null)).toBe(false);
  });

  it("is false when the most recent status check failed, even if coverage was previously COMPLETE", () => {
    expect(isCoverageReady({ status: "COMPLETE", warnings: [] }, COVERAGE_CHECK_ERROR_MESSAGE)).toBe(false);
  });

  it("is false when coverage is not yet known", () => {
    expect(isCoverageReady(null, null)).toBe(false);
  });
});

describe("COVERAGE_READY_MESSAGE", () => {
  it("is the simple positive confirmation shown once all coverage checks are complete", () => {
    expect(COVERAGE_READY_MESSAGE).toBe("البيانات جاهزة للاعتماد.");
  });
});
