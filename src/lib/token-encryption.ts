import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

function encryptionKey() {
  const secret = process.env.META_TOKEN_ENCRYPTION_KEY;
  if (!secret) throw new Error("META_TOKEN_ENCRYPTION_KEY is not configured.");
  return createHash("sha256").update(secret).digest();
}

export function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptToken(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("Encrypted token is invalid.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}
