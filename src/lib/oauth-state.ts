import { createHmac, randomBytes, timingSafeEqual } from "crypto";

export type OAuthState = { userId: string; provider: string; expiresAt: number; nonce: string };

function stateSecret() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new Error("NEXTAUTH_SECRET is not configured.");
  return secret;
}

function signature(value: string) {
  return createHmac("sha256", stateSecret()).update(value).digest("base64url");
}

export function createOAuthState(userId: string, provider: string) {
  const payload = Buffer.from(JSON.stringify({
    userId,
    provider,
    expiresAt: Date.now() + 10 * 60 * 1000,
    nonce: randomBytes(16).toString("base64url"),
  } satisfies OAuthState)).toString("base64url");
  return `${payload}.${signature(payload)}`;
}

export function parseOAuthState(state: string, provider: string) {
  const [payload, receivedSignature] = state.split(".");
  if (!payload || !receivedSignature) throw new Error("OAuth state is invalid.");
  const expectedSignature = signature(payload);
  if (Buffer.byteLength(receivedSignature) !== Buffer.byteLength(expectedSignature) || !timingSafeEqual(Buffer.from(receivedSignature), Buffer.from(expectedSignature))) {
    throw new Error("OAuth state signature is invalid.");
  }
  const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OAuthState;
  if (!value.userId || value.provider !== provider || !value.nonce || !Number.isSafeInteger(value.expiresAt) || value.expiresAt <= Date.now()) {
    throw new Error("OAuth state has expired or is not valid for this provider.");
  }
  return value;
}
