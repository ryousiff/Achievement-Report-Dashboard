import { google } from "googleapis";
import { db } from "@/lib/db";

const requiredDomain = process.env.GOOGLE_WORKSPACE_DOMAIN;

export function getGoogleOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) throw new Error("Google OAuth is not configured.");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function createGoogleAuthorizationUrl(userId: string) {
  const client = getGoogleOAuthClient();
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: true,
    state: userId,
    hd: requiredDomain,
    scope: [
      "https://www.googleapis.com/auth/presentations",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "openid",
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
  if (!tokens.refresh_token || !tokens.access_token || !tokens.expiry_date) throw new Error("Google did not return a complete token.");
  const userInfo = await getGoogleUserInfo(tokens.access_token);
  if (requiredDomain && userInfo.hd !== requiredDomain && !userInfo.email.endsWith(`@${requiredDomain}`)) {
    throw new Error(`Only @${requiredDomain} accounts are allowed.`);
  }
  return {
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: new Date(tokens.expiry_date),
    email: userInfo.email,
  };
}

export async function getGoogleAuthClient(refreshToken: string) {
  const client = getGoogleOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  client.setCredentials(credentials);
  return client;
}

export async function saveGoogleToken(userId: string, refreshToken: string, expiresAt: Date) {
  await db.user.update({ where: { id: userId }, data: { googleRefreshToken: refreshToken, googleTokenExpiresAt: expiresAt } });
}
