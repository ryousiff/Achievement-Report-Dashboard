import { ConnectorError, type ExternalAccount, type SocialConnector } from "./types";
import type { Platform } from "@prisma/client";

export function createStubConnector(label: string, platforms: Platform[], envKeys: string[]): SocialConnector {
  function guardConfigured() {
    const missing = envKeys.filter((key) => !process.env[key]);
    if (missing.length) throw new ConnectorError(`${label} OAuth is not configured.`, "not_configured");
  }

  const notImplementedError = (operation: string): never => {
    throw new ConnectorError(`${label} ${operation} is not implemented yet. Add OAuth credentials and a platform-specific adapter to enable it.`, "not_implemented");
  };

  return {
    label,
    supportedPlatforms: platforms,
    isConfigured() {
      return envKeys.every((key) => Boolean(process.env[key]));
    },
    isImplemented: false,

    createAuthorizationUrl() {
      guardConfigured();
      return notImplementedError("authorization URL");
    },

    async exchangeCode() {
      guardConfigured();
      return notImplementedError("code exchange");
    },

    async discoverAccounts() {
      return notImplementedError("account discovery");
    },

    async handleCallback() {
      return notImplementedError("callback handling");
    },

    async syncConnection() {
      return notImplementedError("sync");
    },
  };
}
