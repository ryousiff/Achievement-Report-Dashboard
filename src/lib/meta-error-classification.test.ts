import { describe, expect, it } from "vitest";
import {
  isEmployeeVisibleSyncError,
  isInternalSyncImplementationError,
  isMetaApplicationRateLimitError,
  isUnsupportedFollowerCountPeriodError,
} from "@/lib/meta-error-classification";

describe("sync error classification", () => {
  it("classifies the permanent follower_count Meta limitation as unsupported for the period", () => {
    const message = "(#100) (follower_count) metric only supports querying data for the last 30 days excluding the current day";
    expect(isUnsupportedFollowerCountPeriodError(new Error(message))).toBe(true);
    expect(isEmployeeVisibleSyncError(message)).toBe(false);
  });

  it("hides Meta application request-limit errors from employees", () => {
    const message = "(#4) Application request limit reached";
    expect(isMetaApplicationRateLimitError(message)).toBe(true);
    expect(isEmployeeVisibleSyncError(message)).toBe(false);
  });

  it("hides raw JavaScript implementation errors from employees", () => {
    const message = "Cannot read properties of undefined (reading 'map')";
    expect(isInternalSyncImplementationError(message)).toBe(true);
    expect(isEmployeeVisibleSyncError(message)).toBe(false);
  });

  it("keeps meaningful non-technical errors employee-visible", () => {
    expect(isEmployeeVisibleSyncError("Instagram permission is missing.")).toBe(true);
  });
});
