import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import { parseSponsoredAdCreateInput } from "@/lib/sponsored-ads";
import { serializeSponsoredAd, sponsoredAdPostSelect } from "@/lib/sponsored-ads-serializer";
import { isValidBudgetMonth, isValidBudgetYear } from "@/lib/ad-budget";

/** Optional `year`/`month` query params scope the list to a single budget month (the Sponsored Ads
 * month view); omitting both returns every ad for the client, as before. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await requireFeature(request, "manage_sponsored_ads"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const yearParam = request.nextUrl.searchParams.get("year");
  const monthParam = request.nextUrl.searchParams.get("month");
  const year = yearParam !== null ? Number(yearParam) : undefined;
  const month = monthParam !== null ? Number(monthParam) : undefined;
  if ((yearParam !== null && !isValidBudgetYear(year)) || (monthParam !== null && !isValidBudgetMonth(month))) {
    return NextResponse.json({ error: "Invalid year/month filter." }, { status: 400 });
  }
  const ads = await db.sponsoredAd.findMany({
    where: { clientId, ...(year !== undefined ? { budgetYear: year } : {}), ...(month !== undefined ? { budgetMonth: month } : {}) },
    orderBy: { startDate: "desc" },
    include: { socialPost: { select: sponsoredAdPostSelect } },
  });
  return NextResponse.json({ ads: ads.map(serializeSponsoredAd) });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await requireFeature(request, "manage_sponsored_ads"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });

  const result = parseSponsoredAdCreateInput(await request.json());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const data = result.data;

  let postUrl = data.postUrl;
  if (data.socialPostId) {
    const post = await db.socialPost.findFirst({
      where: { id: data.socialPostId, connection: { clientId } },
      select: { id: true, permalink: true },
    });
    if (!post) return NextResponse.json({ error: "Selected post does not belong to this client." }, { status: 400 });
    postUrl = postUrl ?? post.permalink;
  }

  const ad = await db.sponsoredAd.create({
    data: { clientId, ...data, postUrl },
    include: { socialPost: { select: sponsoredAdPostSelect } },
  });
  return NextResponse.json({ ad: serializeSponsoredAd(ad) }, { status: 201 });
}
