import { Platform } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConnector, getConnectorForPlatform, listImplementedConnectors } from "./registry";

describe("connector registry", () => {
  describe("lookup", () => {
    it("returns the Meta connector for the meta provider", () => {
      expect(getConnector("meta")?.label).toBe("Meta");
      expect(getConnector("META")?.label).toBe("Meta");
    });

    it("returns stub connectors for future platforms", () => {
      expect(getConnector("tiktok")?.label).toBe("TikTok");
      expect(getConnector("linkedin")?.label).toBe("LinkedIn");
      expect(getConnector("youtube")?.label).toBe("YouTube");
      expect(getConnector("x")?.label).toBe("X");
    });

    it("maps platform enums to the Meta connector", () => {
      expect(getConnectorForPlatform(Platform.INSTAGRAM)?.label).toBe("Meta");
      expect(getConnectorForPlatform(Platform.FACEBOOK)?.label).toBe("Meta");
    });

    it("returns undefined for unknown providers", () => {
      expect(getConnector("pinterest")).toBeUndefined();
    });
  });

  describe("implementation status", () => {
    beforeEach(() => {
      vi.stubEnv("META_APP_ID", "app-id");
      vi.stubEnv("META_APP_SECRET", "app-secret");
      vi.stubEnv("META_REDIRECT_URI", "http://localhost:3000/api/connectors/meta/callback");
      vi.stubEnv("META_TOKEN_ENCRYPTION_KEY", "token-key");
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("lists only configured and implemented connectors", () => {
      const implemented = listImplementedConnectors();
      expect(implemented).toHaveLength(1);
      expect(implemented[0]?.label).toBe("Meta");
    });
  });
});
