import { describe, expect, it } from "vitest";
import { isEmployeeVisibleSyncError, isUnsupportedFollowerCountPeriodError, mapEmployeeSyncErrorPresentation } from "@/lib/meta-error-classification";

describe("follower_count period limitation", () => {
  const message = "(#100) (follower_count) metric only supports querying data for the last 30 days excluding the current day";

  it("classifies the permanent Meta limitation as unsupported for the period", () => {
    expect(isUnsupportedFollowerCountPeriodError(new Error(message))).toBe(true);
  });

  it("hides the raw limitation from employee data-health output", () => {
    expect(isEmployeeVisibleSyncError(message)).toBe(false);
    expect(isEmployeeVisibleSyncError("Application request limit reached")).toBe(true);
  });
});

describe("mapEmployeeSyncErrorPresentation", () => {
  it("maps Meta rate-limit errors to a friendly pause warning", () => {
    expect(mapEmployeeSyncErrorPresentation("(#4) Application request limit reached")).toEqual({
      label: "تم إيقاف المزامنة مؤقتاً، وستُستأنف تلقائياً.",
      state: "warn",
    });
    expect(mapEmployeeSyncErrorPresentation("rate limited")).toEqual({
      label: "تم إيقاف المزامنة مؤقتاً، وستُستأنف تلقائياً.",
      state: "warn",
    });
  });

  it("maps internal/unexpected retryable errors to a friendly retry warning", () => {
    expect(mapEmployeeSyncErrorPresentation("Cannot read properties of undefined (reading 'map')")).toEqual({
      label: "تعذّر إكمال إحدى عمليات المزامنة، وسيحاول النظام استكمالها تلقائياً.",
      state: "warn",
    });
    expect(mapEmployeeSyncErrorPresentation("fetch failed")).toEqual({
      label: "تعذّر إكمال إحدى عمليات المزامنة، وسيحاول النظام استكمالها تلقائياً.",
      state: "warn",
    });
  });

  it("maps non-rate-limit errors to a terminal failure label when marked terminal", () => {
    expect(mapEmployeeSyncErrorPresentation("Some permanent error", { terminal: true })).toEqual({
      label: "فشلت المزامنة.",
      state: "error",
    });
  });

  it("returns null for unsupported-follower-period limitations", () => {
    expect(mapEmployeeSyncErrorPresentation("(#100) (follower_count) metric only supports querying data for the last 30 days excluding the current day")).toBeNull();
  });

  it("returns null for empty messages", () => {
    expect(mapEmployeeSyncErrorPresentation(null)).toBeNull();
    expect(mapEmployeeSyncErrorPresentation("")).toBeNull();
  });
});
