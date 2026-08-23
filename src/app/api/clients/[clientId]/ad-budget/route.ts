import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireFeature } from "@/lib/access";
import {
  DEFAULT_AD_BUDGET_CURRENCY,
  calculateAdBudgetSummary,
  isValidBudgetMonth,
  isValidBudgetYear,
  parseClientAdBudgetInput,
} from "@/lib/ad-budget";

function parseYearMonth(request: NextRequest) {
  const year = Number(request.nextUrl.searchParams.get("year"));
  const month = Number(request.nextUrl.searchParams.get("month"));
  if (!isValidBudgetYear(year) || !isValidBudgetMonth(month)) return null;
  return { year, month };
}

async function loadAdSpends(clientId: string, year: number, month: number) {
  const ads = await db.sponsoredAd.findMany({ where: { clientId, budgetYear: year, budgetMonth: month }, select: { actualSpend: true } });
  return ads.map((ad) => Number(ad.actualSpend.toString()));
}

/** Everything shown for a single client/month: the (possibly not-yet-set) planned budget plus the
 * fully-calculated summary (totalActualSpend, remainingBudget, budgetUsedPercentage, adsCount) —
 * always derived fresh from the SponsoredAd rows assigned to that month, never stored. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await requireFeature(request, "manage_sponsored_ads"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const yearMonth = parseYearMonth(request);
  if (!yearMonth) return NextResponse.json({ error: "Provide a valid year and month." }, { status: 400 });
  const { year, month } = yearMonth;

  const [budget, adSpends] = await Promise.all([
    db.clientAdBudget.findUnique({ where: { clientId_year_month: { clientId, year, month } } }),
    loadAdSpends(clientId, year, month),
  ]);
  const plannedBudget = budget ? Number(budget.plannedBudget.toString()) : 0;
  const currency = budget?.currency ?? DEFAULT_AD_BUDGET_CURRENCY;
  const summary = calculateAdBudgetSummary(year, month, plannedBudget, currency, adSpends);
  return NextResponse.json({
    budget: budget ? { year, month, plannedBudget, currency } : null,
    summary,
  });
}

/** Create or update the client's planned budget for one calendar month. The summary figures are
 * never accepted as input — only plannedBudget/currency are stored; everything else is recalculated
 * from the current SponsoredAd rows on every read. */
export async function PUT(request: NextRequest, { params }: { params: Promise<{ clientId: string }> }) {
  if (!(await requireFeature(request, "manage_sponsored_ads"))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { clientId } = await params;
  const client = await db.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) return NextResponse.json({ error: "Client not found." }, { status: 404 });

  const result = parseClientAdBudgetInput(await request.json());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const { year, month, plannedBudget, currency } = result.data;

  const budget = await db.clientAdBudget.upsert({
    where: { clientId_year_month: { clientId, year, month } },
    create: { clientId, year, month, plannedBudget, currency },
    update: { plannedBudget, currency },
  });

  const adSpends = await loadAdSpends(clientId, year, month);
  const summary = calculateAdBudgetSummary(year, month, Number(budget.plannedBudget.toString()), budget.currency, adSpends);
  return NextResponse.json({
    budget: { year, month, plannedBudget: Number(budget.plannedBudget.toString()), currency: budget.currency },
    summary,
  });
}
