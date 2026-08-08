import { NextRequest, NextResponse } from "next/server";
import { Platform } from "@prisma/client";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { debugMetaToken, fetchBusinessAdAccounts, fetchBusinessManagedPages, maskMetaToken, validateMetaSystemUserToken } from "@/lib/meta";
import { encryptToken } from "@/lib/token-encryption";

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

    const [pages, adAccounts] = await Promise.all([
      fetchBusinessManagedPages(token, businessId),
      fetchBusinessAdAccounts(token, businessId).catch(() => []),
    ]);
    if (pages.length === 0) return NextResponse.json({ error: "No Pages were found for this Business Portfolio. Confirm the system user was assigned the Pages in Business Settings." }, { status: 400 });

    const preview = {
      tokenPreview: maskMetaToken(token),
      pages: pages.map((page) => ({ id: page.id, name: page.name, instagram: page.instagram_business_account ? { id: page.instagram_business_account.id, username: page.instagram_business_account.username ?? null } : null })),
      adAccounts: adAccounts.map((account) => ({ id: account.id, name: account.name })),
    };
    if (!confirm) return NextResponse.json({ preview });

    const profile = await db.metaProfile.create({
      data: { displayName: "Meta Business · Kaan Creative (System user)", createdById: user.id, tokenExpiresAt: null, lastSyncedAt: new Date() },
    });

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

    return NextResponse.json({ profileId: profile.id, pagesConnected: pages.length });
  } catch (error) {
    // Never log the token itself — only the error message, same as the OAuth callback's error handling.
    console.error("META SYSTEM USER CONNECT ERROR:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: error instanceof Error ? error.message : "Meta connection failed." }, { status: 500 });
  }
}
