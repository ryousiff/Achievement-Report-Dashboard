/**
 * One-time migration: encrypts any plaintext User.googleRefreshToken values in place.
 * Safe to run multiple times — already-encrypted tokens (matching the `iv.tag.ciphertext` format) are left untouched.
 *
 * Usage: npx tsx scripts/encrypt-google-tokens.ts
 */
import { db } from "@/lib/db";
import { encryptToken, looksEncrypted } from "@/lib/token-encryption";

async function main() {
  const users = await db.user.findMany({ where: { googleRefreshToken: { not: null } }, select: { id: true, email: true, googleRefreshToken: true } });
  let migrated = 0;
  for (const user of users) {
    const token = user.googleRefreshToken;
    if (!token || looksEncrypted(token)) continue;
    await db.user.update({ where: { id: user.id }, data: { googleRefreshToken: encryptToken(token, "GOOGLE") } });
    migrated += 1;
    console.log(`Encrypted googleRefreshToken for ${user.email}`);
  }
  console.log(`Done. ${migrated} of ${users.length} token(s) migrated.`);
  await db.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
