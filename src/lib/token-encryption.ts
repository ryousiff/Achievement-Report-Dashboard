import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

export type TokenEncryptionKeyName = "META" | "GOOGLE";

const keyEnvVar: Record<TokenEncryptionKeyName, string> = {
  META: "META_TOKEN_ENCRYPTION_KEY",
  GOOGLE: "GOOGLE_TOKEN_ENCRYPTION_KEY",
};

function encryptionKey(keyName: TokenEncryptionKeyName) {
  const envVar = keyEnvVar[keyName];
  const secret = process.env[envVar];
  if (!secret) throw new Error(`${envVar} is not configured.`);
  return createHash("sha256").update(secret).digest();
}

export function encryptToken(token: string, keyName: TokenEncryptionKeyName = "META") {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(keyName), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptToken(value: string, keyName: TokenEncryptionKeyName = "META") {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Encrypted token is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(keyName), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

/** True when `value` looks like our `iv.tag.ciphertext` encrypted format rather than a raw plaintext token. */
export function looksEncrypted(value: string) {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part));
}
