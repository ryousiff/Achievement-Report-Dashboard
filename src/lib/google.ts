import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { google } from "googleapis";
import { db } from "@/lib/db";
import { decryptToken, encryptToken } from "@/lib/token-encryption";

const requiredDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;

// ---- Sign-in OAuth state (separate from the Drive/Slides connect flow below) ----
// Mirrors the signed state pattern already used by src/lib/meta.ts (HMAC + expiry + nonce), but has no
// userId, since sign-in state is created before anyone is authenticated. The nonce doubles as the OIDC
// `nonce` sent to Google and checked against the returned ID token, so a single signed value provides
// both CSRF protection (via the HMAC signature + expiry) and OpenID Connect replay protection.
type GoogleSignInState = { expiresAt: number; nonce: string };

function stateSecret() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not configured.");
  return secret;
}

function signature(value: string) {
  return createHmac("sha256", stateSecret()).update(value).digest("base64url");
}

export function createGoogleSignInState() {
  const nonce = randomBytes(16).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ expiresAt: Date.now() + 10 * 60 * 1000, nonce } satisfies GoogleSignInState)).toString("base64url");
  return { state: `${payload}.${signature(payload)}`, nonce };
}

export function parseGoogleSignInState(state: string) {
  const [payload, receivedSignature] = state.split(".");
  if (!payload || !receivedSignature) throw new Error("Sign-in state is invalid.");
  const expectedSignature = signature(payload);
  if (Buffer.byteLength(receivedSignature) !== Buffer.byteLength(expectedSignature) || !timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) {
    throw new Error("Sign-in state signature is invalid.");
  }
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as GoogleSignInState;
  if (!value.nonce || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) throw new Error("Sign-in state has expired.");
  return value;
}

// ---- Shared OAuth client ----
// Sign-in and the Drive/Slides connect flow hit different callback routes, so each needs its own registered
// redirect URI on the same Google OAuth client (both must be added to the app's Authorized redirect URIs
// in Google Cloud Console).
export function getGoogleOAuthClient(purpose: "signin" | "connect" = "connect") {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = purpose === "signin" ? (process.env.GOOGLE_SIGNIN_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI) : process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Google OAuth is not configured.");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// ---- Sign-in flow (identity only: openid + email + profile). No Drive/Slides access is requested here. ----
export function createSignInAuthorizationUrl() {
  const client = getGoogleOAuthClient("signin");
  const { state, nonce } = createGoogleSignInState();
  const url = client.generateAuthUrl({
    // No access_type/prompt=consent here: we don't need a refresh token for sign-in, only an ID token.
    include_granted_scopes: false,
    state,
    nonce,
    hd: requiredDomain,
    scope: ["openid", "email", "profile"],
  });
  return url;
}

export type VerifiedGoogleIdentity = { subject: string; email: string; emailVerified: boolean; hd?: string; name?: string; nonce?: string };

/** Verifies signature, issuer, audience, and expiry (via google-auth-library), then returns the claims we care about. */
export async function verifyGoogleIdToken(idToken: string): Promise<VerifiedGoogleIdentity> {
  const client = getGoogleOAuthClient();
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const ticket = await client.verifyIdToken({ idToken, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new Error("Google ID token is missing required claims.");
  return { subject: payload.sub, email: payload.email, emailVerified: payload.email_verified === true, hd: payload.hd, name: payload.name, nonce: payload.nonce };
}

export function assertWorkspaceDomain(identity: { email: string; hd?: string }) {
  if (!requiredDomain) return;
  if (identity.hd !== requiredDomain && !identity.email.toLowerCase().endsWith(`@${requiredDomain.toLowerCase()}`)) {
    throw new Error(`Only @${requiredDomain} accounts are allowed.`);
  }
}

/** Exchanges the sign-in authorization code for an ID token. No refresh token is requested/needed here. */
export async function exchangeSignInCode(code: string) {
  const client = getGoogleOAuthClient("signin");
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new Error("Google did not return an ID token.");
  return { idToken: tokens.id_token };
}

// ---- Drive/Slides export connection flow (separate, feature-level; requires an existing session) ----
export function createGoogleAuthorizationUrl(userId: string) {
  const client = getGoogleOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    state: userId,
    hd: requiredDomain,
    // Only what Slides export actually needs: writing/creating files in Drive, editing presentations, and
    // the domain-safety email check below. No `profile`/`openid` here — identity is handled by sign-in.
    scope: [
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
  });
}

export async function getGoogleUserInfo(accessToken: string) {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error("Unable to verify Google account.");
  const data = await response.json() as { email: string; hd?: string };
  return data;
}

export async function exchangeGoogleCode(code: string) {
  const client = getGoogleOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.access_token || !tokens.expiry_date) throw new Error("Google did not return a complete token.");
  const userInfo = await getGoogleUserInfo(tokens.access_token);
  assertWorkspaceDomain(userInfo);
  return {
    // May be undefined on a reconnect where Google doesn't re-issue a refresh token; callers must preserve
    // the previously stored one in that case rather than treating this as an error (see saveGoogleToken).
    refreshToken: tokens.refresh_token ?? undefined,
    accessToken: tokens.access_token,
    expiresAt: new Date(tokens.expiry_date),
    email: userInfo.email,
  };
}

export class GoogleReconnectRequiredError extends Error {
  constructor(message = "Google access needs to be reconnected.") { super(message); }
}

/** Refreshes an access token from an encrypted-at-rest refresh token, surfacing revoked/expired tokens distinctly. */
export async function getGoogleAuthClient(encryptedRefreshToken: string) {
  const client = getGoogleOAuthClient();
  const refreshToken = decryptToken(encryptedRefreshToken, "GOOGLE");
  client.setCredentials({ refresh_token: refreshToken });
  try {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    return client;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("invalid_grant") || message.includes("invalid_token")) throw new GoogleReconnectRequiredError();
    throw error;
  }
}

/** True once a token has been through refreshAccessToken and its granted scope covers Drive + Slides export. */
export function hasExportScope(grantedScope: string | null | undefined) {
  if (!grantedScope) return false;
  return grantedScope.includes("/auth/drive") && grantedScope.includes("/auth/presentations");
}

export async function saveGoogleToken(userId: string, refreshToken: string | undefined, expiresAt: Date) {
  await db.user.update({
    where: { id: userId },
    // Only overwrite the stored refresh token when Google actually returned a new one; otherwise keep the
    // existing encrypted token untouched (Part 1.5 — never erase a working connection on reconnect).
    data: refreshToken ? { googleRefreshToken: encryptToken(refreshToken, "GOOGLE"), googleTokenExpiresAt: expiresAt } : { googleTokenExpiresAt: expiresAt },
  });
}
