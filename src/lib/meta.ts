import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const META_API_URL = "https://graph.facebook.com/v23.0";
const META_AUTHORIZATION_URL = "https://www.facebook.com/v23.0/dialog/oauth";

type MetaState = { clientId: string; userId: string; expiresAt: number; nonce: string };
type MetaPage = { id: string; name: string; access_token: string; instagram_business_account?: { id: string; username?: string } };

function stateSecret() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not configured.");
  return secret;
}

function signature(value: string) {
  return createHmac("sha256", stateSecret()).update(value).digest("base64url");
}

export function createMetaState(clientId: string, userId: string) {
  const payload = Buffer.from(JSON.stringify({ clientId, userId, expiresAt: Date.now() + 10 * 60 * 1000, nonce: randomBytes(16).toString("base64url") } satisfies MetaState)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function parseMetaState(state: string) {
  const [payload, receivedSignature] = state.split(".");
  if (!payload || !receivedSignature) throw new Error("Meta OAuth state is invalid.");
  const expectedSignature = signature(payload);
  if (Buffer.byteLength(receivedSignature) !== Buffer.byteLength(expectedSignature) || !timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) throw new Error("Meta OAuth state is invalid.");
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as MetaState;
  if (!value.clientId || !value.userId || !value.nonce || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error("Meta OAuth state has expired.");
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
  url.searchParams.set("scope", "pages_show_list,pages_read_engagement,instagram_basic,instagram_manage_insights");
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
  if (!response.ok) throw new Error("Meta authorization code could not be exchanged.");
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("Meta did not return an access token.");
  return { token: data.access_token, expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null };
}

export async function fetchMetaPages(accessToken: string) {
  const url = new URL(`${META_API_URL}/me/accounts`);
  url.searchParams.set("fields", "id,name,access_token,instagram_business_account{id,username}");
  url.searchParams.set("access_token", accessToken);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Meta pages could not be loaded.");
  const data = await response.json() as { data?: MetaPage[] };
  return data.data ?? [];
}
