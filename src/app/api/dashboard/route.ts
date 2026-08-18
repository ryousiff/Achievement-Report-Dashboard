import { ReportStatus } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { requireFeature } from "@/lib/access";
import { activeClientsCount, completedReportsLastMonthCount, completedReportsThisMonthCount, connectedAccounts, connectedInstagramAccountsCount, mostRecentInstagramSyncAt, newClientsThisMonthCount, recentReports, reportsNeedingReviewCount } from "@/lib/dashboard";

export async function GET(request: NextRequest) {
  const user = await requireFeature(request, "view_dashboard");
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [activeClients, newClientsThisMonth, needsReview, completedThisMonth, completedLastMonth, instagramAccounts, lastInstagramSyncAt, recent, accounts] = await Promise.all([
    activeClientsCount(),
    newClientsThisMonthCount(),
    reportsNeedingReviewCount(),
    completedReportsThisMonthCount(),
    completedReportsLastMonthCount(),
    connectedInstagramAccountsCount(),
    mostRecentInstagramSyncAt(),
    recentReports(5),
    connectedAccounts(),
  ]);

  return NextResponse.json({
    stats: {
      activeClients,
      newClientsThisMonth,
      needsReview,
      completedThisMonth,
      completedLastMonth,
      instagramAccounts,
      lastInstagramSyncAt,
    },
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
