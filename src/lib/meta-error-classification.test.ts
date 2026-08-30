import { describe, expect, it } from "vitest";
import {
  isEmployeeVisibleSyncError,
  isInternalSyncImplementationError,
  isMetaApplicationRateLimitError,
  isUnsupportedFollowerCountPeriodError,
} from "@/lib/meta-error-classification";

describe("employee sync error classification", () => {
  const followerLimit = "(#100) (follower_count) metric only supports querying data for the last 30 days excluding the current day";
  const appLimit = "(#4) Application request limit reached";
  const implementationError = "Cannot read properties of undefined (reading 'map')";

  it("classifies the permanent follower_count period limitation", () => {
    expect(isUnsupportedFollowerCountPeriodError(new Error(followerLimit))).toBe(true);
  });

  it("classifies Meta application request limits as transient provider errors", () => {
    expect(isMetaApplicationRateLimitError(appLimit)).toBe(true);
  });

  it("classifies raw JavaScript implementation errors", () => {
    expect(isInternalSyncImplementationError(implementationError)).toBe(true);
  });

  it("hides raw provider/runtime errors from employee data-health output", () => {
    expect(isEmployeeVisibleSyncError(followerLimit)).toBe(false);
    expect(isEmployeeVisibleSyncError(appLimit)).toBe(false);
    expect(isEmployeeVisibleSyncError(implementationError)).toBe(false);
    expect(isEmployeeVisibleSyncError("fetch failed")).toBe(false);
  });

  it("keeps other actionable connection messages eligible for employee display", () => {
    expect(isEmployeeVisibleSyncError("Account connection needs attention")).toBe(true);
  });
});
