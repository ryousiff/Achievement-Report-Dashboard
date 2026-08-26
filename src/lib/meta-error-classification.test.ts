import { describe, expect, it } from "vitest";
import { isEmployeeVisibleSyncError, isUnsupportedFollowerCountPeriodError } from "@/lib/meta-error-classification";

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
