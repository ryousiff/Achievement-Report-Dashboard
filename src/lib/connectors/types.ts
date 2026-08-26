import type { Platform } from "@prisma/client";

export type ConnectorErrorCode = "not_configured" | "not_implemented" | "rate_limited" | "request_failed" | "not_supported_for_period" | "auth_failed" | "state_invalid" | "callback_failed";

export class ConnectorError extends Error {
  constructor(message: string, readonly code: ConnectorErrorCode, readonly retryAfterMs?: number) {
    super(message);
  }
}

export type ExternalAccount = {
  platform: Platform;
  externalAccountId: string;
  displayName: string;
  token: string;
  tokenExpiresAt: Date | null;
};

export type SyncResult = { posts: number };

export interface SocialConnector {
  /** Human-readable provider name. */
  readonly label: string;
  /** Platforms this connector can produce SocialConnections for. */
  readonly supportedPlatforms: readonly Platform[];
  /** True when the provider-specific API credentials are present. */
  isConfigured(): boolean;
  /** True when the connector has a complete OAuth + sync implementation. */
  readonly isImplemented: boolean;
  /** Build the provider OAuth authorization URL. */
  createAuthorizationUrl(userId: string): string;
  /** Exchange an OAuth authorization code for an access token. */
  exchangeCode(code: string): Promise<{ token: string; expiresAt: Date | null; refreshToken?: string }>;
  /** Discover accounts available to the authenticated user. */
  discoverAccounts(token: string): Promise<ExternalAccount[]>;
  /** Persist discovered accounts after a successful OAuth callback. */
  handleCallback(code: string, state: string, userId: string): Promise<void>;
  /** Sync media and metrics for a single SocialConnection. */
  syncConnection(connectionId: string): Promise<SyncResult>;
}
