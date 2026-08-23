import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { parseSponsoredAdUpdateInput } from "@/lib/sponsored-ads";
import { serializeSponsoredAd, sponsoredAdPostSelect } from "@/lib/sponsored-ads-serializer";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ clientId: string; adId: string }> }) {
  if (!(await requireFeature(request, "manage_sponsored_ads"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId, adId } = await params;
  const existing = await db.sponsoredAd.findFirst({ where: { id: adId, clientId }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Sponsored ad not found." }, { status: 404 });

  const result = parseSponsoredAdUpdateInput(await request.json());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const data = result.data;

  if (data.socialPostId) {
    const post = await db.socialPost.findFirst({
      where: { id: data.socialPostId, connection: { clientId } },
      select: { id: true, permalink: true },
    });
    if (!post) return NextResponse.json({ error: "Selected post does not belong to this client." }, { status: 400 });
    if (data.postUrl === undefined) data.postUrl = post.permalink;
  }

  const ad = await db.sponsoredAd.update({
    where: { id: adId },
    data,
    include: { socialPost: { select: sponsoredAdPostSelect } },
  });
  return NextResponse.json({ ad: serializeSponsoredAd(ad) });
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ clientId: string; adId: string }> }) {
  if (!(await requireFeature(request, "manage_sponsored_ads"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId, adId } = await params;
  const existing = await db.sponsoredAd.findFirst({ where: { id: adId, clientId }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Sponsored ad not found." }, { status: 404 });
  await db.sponsoredAd.delete({ where: { id: adId } });
  return NextResponse.json({ ok: true });
}
