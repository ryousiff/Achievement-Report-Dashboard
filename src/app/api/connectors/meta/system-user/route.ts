import { NextRequest, NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { debugMetaToken, fetchBusinessAdAccounts, fetchBusinessManagedPages, maskMetaToken, validateMetaSystemUserToken } from "@/lib/meta";
import { encryptToken } from "@/lib/token-encryption";

const systemUserProfileName = "Meta Business · Kaan Creative (System user)";

function sanitizeError(error: unknown) {
  return error instanceof Error ? error.message : "Meta connection failed.";
}

// Admin-only: connects Kaan's own Business Portfolio (Pages + Instagram accounts) using a non-expiring
// System User access token generated in Meta Business Settings, instead of Facebook Login (which cannot
// onboard a business that owns the app itself — see createMetaAuthorizationUrl in src/lib/meta.ts).
// The token is validated on every call and is never persisted, echoed back, or logged in full; only the
// per-Page access tokens Meta returns are encrypted and stored, exactly like the OAuth connect flow does.
export async function POST(request: NextRequest) {
  const user = await requireFeature(request, "connect_meta_system_user");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const businessId = process.env.META_BUSINESS_ID;
  if (!businessId) return NextResponse.json({ error: "META_BUSINESS_ID is not configured." }, { status: 503 });

  let body: { token?: unknown; confirm?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if (!token) return NextResponse.json({ error: "A Meta system-user access token is required." }, { status: 400 });
  const confirm = body.confirm === true;

  try {
    const debug = await debugMetaToken(token);
    const issues = validateMetaSystemUserToken(debug);
    if (issues.length > 0) return NextResponse.json({ error: issues.join(" ") }, { status: 400 });

    const [{ pages, warnings: pageWarnings }, { adAccounts, warnings: adWarnings }] = await Promise.all([
      fetchBusinessManagedPages(token, businessId),
      fetchBusinessAdAccounts(token, businessId),
    ]);
    const warnings = [...pageWarnings, ...adWarnings];

    if (pages.length === 0 && warnings.length === 0) {
      return NextResponse.json({ error: "No Pages were found for this Business Portfolio. Confirm the system user was assigned the Pages in Business Settings." }, { status: 400 });
    }

    const preview = {
      tokenPreview: maskMetaToken(token),
      pages: pages.map((page) => ({ id: page.id, name: page.name, instagram: page.instagram_business_account ? { id: page.instagram_business_account.id, username: page.instagram_business_account.username ?? null } : null })),
      adAccounts: adAccounts.map((account) => ({ id: account.id, name: account.name })),
      warnings,
    };
    if (!confirm) return NextResponse.json({ preview });

    // Replace (update in place) an existing Kaan system-user profile rather than creating duplicates every time.
    let profile = await db.metaProfile.findFirst({ where: { displayName: systemUserProfileName }, orderBy: { createdAt: "desc" } });
    if (profile) {
      profile = await db.metaProfile.update({ where: { id: profile.id }, data: { lastSyncedAt: new Date(), updatedAt: new Date() } });
    } else {
      profile = await db.metaProfile.create({
        data: { displayName: systemUserProfileName, createdById: user.id, tokenExpiresAt: null, lastSyncedAt: new Date() },
      });
    }

    for (const page of pages) {
      if (!page.access_token) continue;
      const shared = { profileId: profile.id, encryptedToken: encryptToken(page.access_token), tokenExpiresAt: null, lastSyncedAt: new Date() };
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

    return NextResponse.json({ profileId: profile.id, pagesConnected: pages.length, warnings });
  } catch (error) {
    // Never log the token itself — only the error message, same as the OAuth callback's error handling.
    console.error("META SYSTEM USER CONNECT ERROR:", sanitizeError(error));
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}

// Disconnect/revoke the local Kaan system-user connection. Removes the profile (which cascades to its
// MetaAccounts) and deletes any SocialConnection rows that were sourced from those MetaAccounts.
// The actual token on Meta's side can only be revoked from Business Settings; this just clears local state.
export async function DELETE(request: NextRequest) {
  const user = await requireFeature(request, "connect_meta_system_user");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const profile = await db.metaProfile.findFirst({ where: { displayName: systemUserProfileName }, orderBy: { createdAt: "desc" }, include: { accounts: { select: { id: true } } } });
    if (!profile) return NextResponse.json({ error: "No Kaan system-user connection found." }, { status: 404 });

    const accountIds = profile.accounts.map((account) => account.id);
    await db.$transaction([
      db.socialConnection.deleteMany({ where: { sourceAccountId: { in: accountIds } } }),
      db.metaProfile.delete({ where: { id: profile.id } }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("META SYSTEM USER DISCONNECT ERROR:", sanitizeError(error));
    return NextResponse.json({ error: sanitizeError(error) }, { status: 500 });
  }
}
