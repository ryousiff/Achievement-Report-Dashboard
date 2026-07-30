import { ReportStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { activeClientsCount, completedReportsThisMonthCount, connectedAccounts, connectedInstagramAccountsCount, recentReports, reportsNeedingReviewCount, reachSeries } from "@/lib/dashboard";

export async function GET(request: NextRequest) {
  const user = await requireFeature(request, "view_dashboard");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const searchParams = request.nextUrl.searchParams;
  const days = Number(searchParams.get("days") ?? 30);
  const clientId = searchParams.get("clientId");

  const [activeClients, needsReview, completedThisMonth, instagramAccounts, reach, recent, accounts] = await Promise.all([
    activeClientsCount(),
    reportsNeedingReviewCount(),
    completedReportsThisMonthCount(),
    connectedInstagramAccountsCount(),
    reachSeries(Number.isFinite(days) ? days : 30),
    recentReports(5),
    connectedAccounts(),
  ]);

  return NextResponse.json({
    stats: {
      activeClients,
      needsReview,
      completedThisMonth,
      instagramAccounts,
    },
    reach,
    recent: recent.map((report) => ({
      id: report.id,
      title: report.title,
      clientName: report.client.name,
      status: report.status,
      updatedAt: report.updatedAt,
    })),
    accounts: accounts.map((account) => ({
      id: account.id,
      platform: account.platform,
      displayName: account.displayName,
      clientName: account.client.name,
      lastSuccessfulSyncAt: account.lastSuccessfulSyncAt,
    })),
  });
}
