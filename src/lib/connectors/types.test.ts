import { describe, expect, it } from "vitest";
import { ConnectorError } from "./types";

describe("ConnectorError", () => {
  it("exposes the error code and optional retry-after duration", () => {
    const error = new ConnectorError("Rate limited", "rate_limited", 5000);
    expect(error.code).toBe("rate_limited");
    expect(error.retryAfterMs).toBe(5000);
    expect(error.message).toBe("Rate limited");
  });
});
