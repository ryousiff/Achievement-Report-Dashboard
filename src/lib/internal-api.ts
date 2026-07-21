import { timingSafeEqual } from "crypto";
import { NextRequest } from "next/server";

export function hasInternalApiAccess(request: NextRequest) {
  const expected = process.env.INTERNAL_API_KEY;
  const provided = request.headers.get("x-internal-api-key");
  if (!expected || !provided) return false;
  const expectedValue = Buffer.from(expected);
  const providedValue = Buffer.from(provided);
  return expectedValue.length === providedValue.length && timingSafeEqual(expectedValue, providedValue);
}
