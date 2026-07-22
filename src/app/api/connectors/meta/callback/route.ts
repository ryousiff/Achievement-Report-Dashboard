import { Platform } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { encryptToken } from "@/lib/token-encryption";
import { exchangeMetaCode, fetchMetaPages, parseMetaState } from "@/lib/meta";
import { getSessionUser } from "@/lib/session";

function redirectToWorkspace(request: NextRequest, result: "connected" | "error") {
  const url = new URL("/", request.nextUrl.origin);
  url.searchParams.set("meta", result);
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const error = request.nextUrl.searchParams.get("error");
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  if (error || !state || !code) return redirectToWorkspace(request, "error");

  try {
    const sessionUser = await getSessionUser(request);
    const connection = parseMetaState(state);
    if (!sessionUser || sessionUser.id !== connection.userId) return redirectToWorkspace(request, "error");
    const client = await db.client.findUnique({ where: { id: connection.clientId }, select: { id: true } });
    if (!client) return redirectToWorkspace(request, "error");

    const authorization = await exchangeMetaCode(code);
    const pages = await fetchMetaPages(authorization.token);
    for (const page of pages) {
      const account = page.instagram_business_account;
      const platform = account ? Platform.INSTAGRAM : Platform.FACEBOOK;
      const externalAccountId = account?.id ?? page.id;
      const displayName = account?.username ? `@${account.username}` : page.name;
      await db.socialConnection.upsert({
        where: { clientId_platform_externalAccountId: { clientId: client.id, platform, externalAccountId } },
        create: { clientId: client.id, platform, externalAccountId, displayName, encryptedToken: encryptToken(page.access_token), tokenExpiresAt: authorization.expiresAt, lastSyncedAt: new Date() },
        update: { displayName, encryptedToken: encryptToken(page.access_token), tokenExpiresAt: authorization.expiresAt, lastSyncedAt: new Date() },
      });
    }
    return redirectToWorkspace(request, "connected");
  } catch {
    return redirectToWorkspace(request, "error");
  }
}
