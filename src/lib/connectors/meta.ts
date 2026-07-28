import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/token-encryption";
import { createMetaAuthorizationUrl, createMetaState, exchangeMetaCode, fetchMetaPages, parseMetaState } from "@/lib/meta";
import { syncInstagramConnection } from "@/lib/meta-sync";
import { ConnectorError, type ExternalAccount, type SocialConnector, type SyncResult } from "./types";

export const metaConnector: SocialConnector = {
  label: "Meta",
  supportedPlatforms: [Platform.FACEBOOK, Platform.INSTAGRAM],
  isConfigured() {
    return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_REDIRECT_URI && process.env.META_TOKEN_ENCRYPTION_KEY);
  },
  isImplemented: true,

  createAuthorizationUrl(userId) {
    if (!this.isConfigured()) throw new ConnectorError("Meta OAuth is not configured.", "not_configured");
    return createMetaAuthorizationUrl(createMetaState(userId));
  },

  async exchangeCode(code) {
    if (!this.isConfigured()) throw new ConnectorError("Meta OAuth is not configured.", "not_configured");
    return exchangeMetaCode(code);
  },

  async discoverAccounts(token) {
    const pages = await fetchMetaPages(token);
    const accounts: ExternalAccount[] = [];
    for (const page of pages) {
      accounts.push({
        platform: Platform.FACEBOOK,
        externalAccountId: page.id,
        displayName: page.name,
        token: page.access_token,
        tokenExpiresAt: null,
      });
      if (page.instagram_business_account) {
        const account = page.instagram_business_account;
        accounts.push({
          platform: Platform.INSTAGRAM,
          externalAccountId: account.id,
          displayName: account.username ? `@${account.username}` : page.name,
          token: page.access_token,
          tokenExpiresAt: null,
        });
      }
    }
    return accounts;
  },

  async handleCallback(code, state, userId) {
    if (!this.isConfigured()) throw new ConnectorError("Meta OAuth is not configured.", "not_configured");
    const parsed = parseMetaState(state);
    if (parsed.userId !== userId) throw new ConnectorError("OAuth state user mismatch.", "state_invalid");

    const authorization = await exchangeMetaCode(code);
    const pages = await fetchMetaPages(authorization.token);
    const user = await db.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
    const profile = await db.metaProfile.create({
      data: {
        displayName: `Meta · ${user?.name ?? user?.email ?? "user"}`,
        createdById: userId,
        tokenExpiresAt: authorization.expiresAt,
        lastSyncedAt: new Date(),
      },
    });

    for (const page of pages) {
      const shared = {
        profileId: profile.id,
        encryptedToken: encryptToken(page.access_token),
        tokenExpiresAt: authorization.expiresAt,
        lastSyncedAt: new Date(),
      };
      await db.metaAccount.upsert({
        where: { profileId_platform_externalAccountId: { profileId: profile.id, platform: Platform.FACEBOOK, externalAccountId: page.id } },
        create: { ...shared, platform: Platform.FACEBOOK, externalAccountId: page.id, displayName: page.name },
        update: { ...shared, displayName: page.name },
      });
      if (page.instagram_business_account) {
        const account = page.instagram_business_account;
        await db.metaAccount.upsert({
          where: { profileId_platform_externalAccountId: { profileId: profile.id, platform: Platform.INSTAGRAM, externalAccountId: account.id } },
          create: { ...shared, platform: Platform.INSTAGRAM, externalAccountId: account.id, displayName: account.username ? `@${account.username}` : page.name },
          update: { ...shared, displayName: account.username ? `@${account.username}` : page.name },
        });
      }
    }
  },

  async syncConnection(connectionId): Promise<SyncResult> {
    const connection = await db.socialConnection.findUnique({
      where: { id: connectionId },
      select: { platform: true },
    });
    if (!connection) throw new ConnectorError("Connection not found.", "request_failed");

    if (connection.platform === Platform.INSTAGRAM) {
      const result = await syncInstagramConnection(connectionId);
      return { posts: result.posts };
    }

    if (connection.platform === Platform.FACEBOOK) {
      // TODO: Implement Facebook Page feed + insights sync.
      return { posts: 0 };
    }

    throw new ConnectorError("Unsupported Meta platform.", "not_implemented");
  },
};
