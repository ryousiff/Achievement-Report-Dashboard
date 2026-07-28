import { afterEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { hasInternalApiAccess } from "@/lib/internal-api";

const original = process.env.INTERNAL_API_KEY;
afterEach(() => { process.env.INTERNAL_API_KEY = original; });

describe("hasInternalApiAccess", () => {
  it("accepts only the configured internal API key", () => {
    process.env.INTERNAL_API_KEY = "test-secret";
    expect(hasInternalApiAccess(new NextRequest("http://localhost/api/reports", { headers: { "x-internal-api-key": "test-secret" } }))).toBe(true);
    expect(hasInternalApiAccess(new NextRequest("http://localhost/api/reports", { headers: { "x-internal-api-key": "wrong" } }))).toBe(false);
  });
});
