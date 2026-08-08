import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const META_API_URL = "https://graph.facebook.com/v23.0";
const META_AUTHORIZATION_URL = "https://www.facebook.com/v23.0/dialog/oauth";

type MetaState = { userId: string; expiresAt: number; nonce: string };
type MetaPage = { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } };

function stateSecret() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not configured.");
  return secret;
}

function signature(value: string) {
  return createHmac("sha256", stateSecret()).update(value).digest("base64url");
}

export function createMetaState(userId: string) {
  const payload = Buffer.from(JSON.stringify({ userId, expiresAt: Date.now() + 10 * 60 * 1000, nonce: randomBytes(16).toString("base64url") } satisfies MetaState)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function parseMetaState(state: string) {
  const [payload, receivedSignature] = state.split(".");
  if (!payload || !receivedSignature) throw new Error("Meta OAuth state is invalid.");
  const expectedSignature = signature(payload);
  if (Buffer.byteLength(receivedSignature) !== Buffer.byteLength(expectedSignature) || !timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) throw new Error("Meta OAuth state is invalid.");
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MetaState;
  if (!value.userId || !value.nonce || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error("Meta OAuth state has expired.");
  return value;
}

export function createMetaAuthorizationUrl(state: string) {
  const appId = process.env.META_APP_ID;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !redirectUri) throw new Error("Meta OAuth is not configured.");
  const url = new URL(META_AUTHORIZATION_URL);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("response_type", "code");
  // A Facebook Login for Business configuration (config_id) lets the user grant access to Pages/Instagram
  // accounts owned by a Business Portfolio (e.g. Kaan Creative), not just Pages they personally administer.
  // Without it, Meta's classic Login only exposes personally-owned assets ("Other assets" in the picker).
  const loginConfigId = process.env.META_LOGIN_CONFIG_ID;
  if (loginConfigId) url.searchParams.set("config_id", loginConfigId);
  else url.searchParams.set("scope", "pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_insights");
  return url.toString();
}

export async function exchangeMetaCode(code: string) {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  const redirectUri = process.env.META_REDIRECT_URI;
  if (!appId || !appSecret || !redirectUri) throw new Error("Meta OAuth is not configured.");
  const url = new URL(`${META_API_URL}/oauth/access_token`);
  url.searchParams.set("client_id", appId);
  url.searchParams.set("client_secret", appSecret);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("code", code);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Meta token exchange failed with status ${response.status}. Check the app secret and redirect URI.`);
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Meta did not return an access token.");
  return { token: data.access_token, expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null };
}

export async function fetchMetaPages(accessToken: string) {
  const url = new URL(`${META_API_URL}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Meta Pages request failed with status ${response.status}. Check Page permissions and access.`);
  const data = await response.json() as { data?: MetaPage[] };
  return data.data ?? [];
}

// --- Meta Business system-user token support -------------------------------------------------------
// For an agency's own Business Portfolio (e.g. Kaan Creative owns both this app and the client Pages),
// Facebook Login for Business cannot be used: Meta requires the app's business to be separate from the
// client business a Login Configuration onboards (see createMetaAuthorizationUrl). Instead, an admin
// generates a non-expiring System User access token directly in Business Settings and pastes it here;
// we discover that business's Pages/Instagram/ad accounts via the Business Manager API instead of /me/accounts.

export type MetaAdAccount = { id: string; name: string; account_id?: string };
export type MetaTokenDebugInfo = { app_id?: string; type?: string; is_valid?: boolean; expires_at?: number; scopes?: string[] };

/** Never log or return the full token — only this short, non-reversible preview. */
export function maskMetaToken(token: string) {
  if (token.length <= 10) return "•".repeat(token.length);
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}

export const REQUIRED_META_SYSTEM_USER_SCOPES = ["pages_show_list", "pages_read_engagement", "instagram_basic", "instagram_manage_insights"] as const;

/** Inspects a token via Meta's debug_token endpoint without ever needing to store or log it. */
export async function debugMetaToken(token: string): Promise<MetaTokenDebugInfo> {
  const appId = process.env.META_APP_ID;
  const appSecret = process.env.META_APP_SECRET;
  if (!appId || !appSecret) throw new Error("Meta OAuth is not configured.");
  const url = new URL(`${META_API_URL}/debug_token`);
  url.searchParams.set("input_token", token);
  url.searchParams.set("access_token", `${appId}|${appSecret}`);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Meta token validation failed with status ${response.status}.`);
  const data = await response.json() as { data?: MetaTokenDebugInfo };
  if (!data.data) throw new Error("Meta did not return token validation details.");
  return data.data;
}

/** Returns a list of human-readable problems, or an empty array if the token is usable as-is. */
export function validateMetaSystemUserToken(debug: MetaTokenDebugInfo) {
  const issues: string[] = [];
  if (!debug.is_valid) issues.push("Token is not valid.");
  if (debug.app_id && debug.app_id !== process.env.META_APP_ID) issues.push("Token was not issued for this Meta app.");
  if (debug.expires_at) issues.push("Token has an expiration date; generate a non-expiring System User token in Business Settings instead.");
  const grantedScopes = new Set(debug.scopes ?? []);
  const missingScopes = REQUIRED_META_SYSTEM_USER_SCOPES.filter((scope) => !grantedScopes.has(scope));
  if (missingScopes.length > 0) issues.push(`Token is missing required permissions: ${missingScopes.join(", ")}.`);
  return issues;
}

async function fetchAllMetaBusinessAssets<T>(path: string, accessToken: string, fields: string): Promise<T[]> {
  const results: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`${META_API_URL}${path}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("limit", "100");
    url.searchParams.set("access_token", accessToken);
    if (after) url.searchParams.set("after", after);
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new Error(`Meta Business API request to ${path} failed with status ${response.status}${body?.error?.message ? `: ${body.error.message}` : ""}.`);
    }
    const data = await response.json() as { data?: T[]; paging?: { cursors?: { after?: string } } };
    results.push(...(data.data ?? []));
    after = data.paging?.cursors?.after;
    if (!after || !data.data?.length) break;
  }
  return results;
}

/** Pages owned directly by the Business Portfolio, plus Pages shared with it by partner businesses. */
export async function fetchBusinessManagedPages(accessToken: string, businessId: string) {
  const fields = "id,name,access_token,instagram_business_account{id,username}";
  const [owned, shared] = await Promise.all([
    fetchAllMetaBusinessAssets<MetaPage>(`/${businessId}/owned_pages`, accessToken, fields),
    fetchAllMetaBusinessAssets<MetaPage>(`/${businessId}/client_pages`, accessToken, fields),
  ]);
  const byId = new Map<string, MetaPage>();
  for (const page of [...owned, ...shared]) byId.set(page.id, page);
  return [...byId.values()];
}

/** Ad accounts owned by or shared with the Business Portfolio. Informational only today — no sync pipeline yet. */
export async function fetchBusinessAdAccounts(accessToken: string, businessId: string) {
  const fields = "id,name,account_id";
  const [owned, shared] = await Promise.all([
    fetchAllMetaBusinessAssets<MetaAdAccount>(`/${businessId}/owned_ad_accounts`, accessToken, fields),
    fetchAllMetaBusinessAssets<MetaAdAccount>(`/${businessId}/client_ad_accounts`, accessToken, fields),
  ]);
  const byId = new Map<string, MetaAdAccount>();
  for (const account of [...owned, ...shared]) byId.set(account.id, account);
  return [...byId.values()];
}
