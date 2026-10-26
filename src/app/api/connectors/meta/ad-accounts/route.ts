import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { fetchBusinessAdAccounts } from "@/lib/meta";
import { getSystemUserToken } from "@/lib/ads-insights";

/** Lists the Business Portfolio's ad accounts using the persisted system-user token, so admins can
 * assign one ad account per client (Client.metaAdAccountId). Returns a clear error when the stored
 * token predates the encryptedSystemToken field (reconnect required) or lacks ads_read. */
export async function GET(request: NextRequest) {
  if (!(await requireFeature(request, "assign_accounts"))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const businessId = process.env.META_BUSINESS_ID;
  if (!businessId) return NextResponse.json({ error: "META_BUSINESS_ID is not configured." }, { status: 503 });
  const token = await getSystemUserToken();
  if (!token) {
    return NextResponse.json({ error: "أعيدي ربط ملف Meta System User أولاً حتى يُخزَّن الرمز ويصبح جلب حسابات الإعلانات ممكناً." }, { status: 409 });
  }
  try {
    const { adAccounts, warnings } = await fetchBusinessAdAccounts(token, businessId);
    return NextResponse.json({ adAccounts: adAccounts.map((account) => ({ id: account.id, name: account.name })), warnings });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "فشل جلب حسابات الإعلانات." }, { status: 502 });
  }
}
