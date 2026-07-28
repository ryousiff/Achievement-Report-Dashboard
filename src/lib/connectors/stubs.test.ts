import { afterEach, describe, expect, it, vi } from "vitest";
import { tiktokConnector } from "./tiktok";
import { linkedInConnector } from "./linkedin";
import { youtubeConnector } from "./youtube";
import { xConnector } from "./x";
import type { SocialConnector } from "./types";

const cases = [
  { label: "TikTok", connector: tiktokConnector, idKey: "TIKTOK_CLIENT_KEY", secretKey: "TIKTOK_CLIENT_SECRET", redirectKey: "TIKTOK_REDIRECT_URI" },
  { label: "LinkedIn", connector: linkedInConnector, idKey: "LINKEDIN_CLIENT_ID", secretKey: "LINKEDIN_CLIENT_SECRET", redirectKey: "LINKEDIN_REDIRECT_URI" },
  { label: "YouTube", connector: youtubeConnector, idKey: "YOUTUBE_CLIENT_ID", secretKey: "YOUTUBE_CLIENT_SECRET", redirectKey: "YOUTUBE_REDIRECT_URI" },
  { label: "X", connector: xConnector, idKey: "X_CLIENT_ID", secretKey: "X_CLIENT_SECRET", redirectKey: "X_REDIRECT_URI" },
] as const;

describe("stub connectors", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it.each(cases)("$label reports not configured when credentials are missing", ({ connector }) => {
    expect(connector.isConfigured()).toBe(false);
    expect(() => connector.createAuthorizationUrl("user")).toThrow(/not configured/i);
  });

  it.each(cases)("$label reports not implemented when credentials are present", ({ connector, idKey, secretKey, redirectKey }) => {
    vi.stubEnv(idKey, "id");
    vi.stubEnv(secretKey, "secret");
    vi.stubEnv(redirectKey, "http://localhost/callback");
    expect(connector.isConfigured()).toBe(true);
    expect(connector.isImplemented).toBe(false);
    expect(() => connector.createAuthorizationUrl("user")).toThrow(/not implemented/i);
  });
});
