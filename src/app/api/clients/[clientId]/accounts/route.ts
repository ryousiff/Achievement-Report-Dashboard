import { Platform } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { decryptToken } from "@/lib/token-encryption";

export async function PUT(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  const user = await requireFeature(request, "assign_accounts");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const { accountIds } = await request.json() as { accountIds?: unknown };
  if (!Array.isArray(accountIds) || accountIds.some((id) => typeof id !== "string")) return NextResponse.json({ error: "accountIds must be an array of account IDs." }, { status: 400 });
  if (new Set(accountIds).size !== accountIds.length) return NextResponse.json({ error: "An account can only be selected once." }, { status: 400 });

  const [client, accounts] = await Promise.all([
    db.client.findUnique({ where: { id: clientId }, select: { id: true, logoUrl: true } }),
    db.metaAccount.findMany({ where: { id: { in: accountIds }, profile: { createdById: user.id } } }),
  ]);
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });
  if (accounts.length !== accountIds.length) return NextResponse.json({ error: "One or more accounts are unavailable." }, { status: 400 });
  if (accounts.filter((account) => account.platform === Platform.INSTAGRAM).length > 1 || accounts.filter((account) => account.platform === Platform.FACEBOOK).length > 1) return NextResponse.json({ error: "Select at most one account per platform." }, { status: 400 });

  const assignedElsewhere = await db.socialConnection.findMany({ where: { sourceAccountId: { in: accountIds }, clientId: { not: clientId } }, select: { displayName: true } });
  if (assignedElsewhere.length) return NextResponse.json({ error: "One or more selected accounts are already assigned to another client." }, { status: 409 });

  await db.$transaction([
    db.socialConnection.deleteMany({ where: { clientId, sourceAccountId: { not: null } } }),
    ...accounts.map((account) => db.socialConnection.upsert({
      where: { clientId_platform_externalAccountId: { clientId, platform: account.platform, externalAccountId: account.externalAccountId } },
      create: { clientId, sourceAccountId: account.id, platform: account.platform, externalAccountId: account.externalAccountId, displayName: account.displayName, encryptedToken: account.encryptedToken, tokenExpiresAt: account.tokenExpiresAt, lastSyncedAt: account.lastSyncedAt },
      update: { sourceAccountId: account.id, displayName: account.displayName, encryptedToken: account.encryptedToken, tokenExpiresAt: account.tokenExpiresAt, lastSyncedAt: account.lastSyncedAt },
    })),
  ]);
  const instagram = accounts.find((account) => account.platform === Platform.INSTAGRAM);
  if (instagram && !client.logoUrl) {
    try {
      const url = new URL(`https://graph.facebook.com/v23.0/${instagram.externalAccountId}`);
      url.searchParams.set("fields", "profile_picture_url");
      url.searchParams.set("access_token", decryptToken(instagram.encryptedToken));
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json() as { profile_picture_url?: unknown };
      if (response.ok && typeof data.profile_picture_url === "string" && data.profile_picture_url.startsWith("https://")) await db.client.update({ where: { id: clientId }, data: { logoUrl: data.profile_picture_url } });
    } catch {}
  }
  return NextResponse.json({ ok: true });
}
