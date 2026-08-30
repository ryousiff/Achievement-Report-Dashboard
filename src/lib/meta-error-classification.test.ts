import { describe, expect, it } from "vitest";
import { isEmployeeVisibleSyncError, isUnsupportedFollowerCountPeriodError, mapEmployeeSyncErrorLabel } from "@/lib/meta-error-classification";

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

describe("mapEmployeeSyncErrorLabel", () => {
  it("maps Meta rate-limit errors to a friendly pause message", () => {
    expect(mapEmployeeSyncErrorLabel("(#4) Application request limit reached")).toBe("تم إيقاف المزامنة مؤقتاً، وستُستأنف تلقائياً.");
    expect(mapEmployeeSyncErrorLabel("rate limited")).toBe("تم إيقاف المزامنة مؤقتاً، وستُستأنف تلقائياً.");
  });

  it("maps internal/unexpected errors to a friendly retry message", () => {
    expect(mapEmployeeSyncErrorLabel("Cannot read properties of undefined (reading 'map')")).toBe("تعذّر إكمال إحدى عمليات المزامنة، وسيحاول النظام استكمالها تلقائياً.");
    expect(mapEmployeeSyncErrorLabel("fetch failed")).toBe("تعذّر إكمال إحدى عمليات المزامنة، وسيحاول النظام استكمالها تلقائياً.");
  });

  it("returns null for unsupported-follower-period limitations", () => {
    expect(mapEmployeeSyncErrorLabel("(#100) (follower_count) metric only supports querying data for the last 30 days excluding the current day")).toBeNull();
  });

  it("returns null for empty messages", () => {
    expect(mapEmployeeSyncErrorLabel(null)).toBeNull();
    expect(mapEmployeeSyncErrorLabel("")).toBeNull();
  });
});
