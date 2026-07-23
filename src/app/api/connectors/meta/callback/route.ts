import { Platform } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/token-encryption";
import { exchangeMetaCode, fetchMetaPages, parseMetaState } from "@/lib/meta";
import { getSessionUser } from "@/lib/session";

function redirectToWorkspace(result: "connected" | "error") {
  const dashboardUrl = process.env.NEXTAUTH_URL || "https://slideshow-bluish-coveting.ngrok-free.dev";
  const url = new URL("/", dashboardUrl);
  url.searchParams.set("meta", result);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get("error");
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  if (error || !state || !code) return redirectToWorkspace("error");

  try {
    const sessionUser = await getSessionUser(request);
    const connection = parseMetaState(state);
    if (!sessionUser || sessionUser.id !== connection.userId) return redirectToWorkspace("error");

    const authorization = await exchangeMetaCode(code);
    const pages = await fetchMetaPages(authorization.token);
    const profile = await db.metaProfile.create({ data: { displayName: `Meta · ${sessionUser.name ?? sessionUser.email}`, createdById: sessionUser.id, tokenExpiresAt: authorization.expiresAt, lastSyncedAt: new Date() } });

    for (const page of pages) {
      const shared = { profileId: profile.id, encryptedToken: encryptToken(page.access_token), tokenExpiresAt: authorization.expiresAt, lastSyncedAt: new Date() };
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
    return redirectToWorkspace("connected");
  } catch (error) {
    console.error("META CALLBACK ERROR:", error instanceof Error ? { message: error.message, stack: error.stack } : error);
    return redirectToWorkspace("error");
  }
}
