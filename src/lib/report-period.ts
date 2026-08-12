export type ReportPeriod = "monthly" | "quarterly" | "halfYearly" | "yearly";

export type CompletedPeriod = {
  periodStart: string;
  periodEnd: string;
  label: string;
};

const arabicMonths = [
  "يناير",
  "فبراير",
  "مارس",
  "إبريل",
  "مايو",
  "يونيو",
  "يوليو",
  "أغسطس",
  "سبتمبر",
  "أكتوبر",
  "نوفمبر",
  "ديسمبر",
];

function dateInputValue(date: Date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** Resolve the most recently completed calendar period of the given type.
 *  Monthly reports always use the previous completed calendar month, never a
 *  partial current month. */
export function completedPeriod(periodType: ReportPeriod, today = new Date()): CompletedPeriod {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  let end: Date;
  let start: Date;

  if (periodType === "monthly") {
    end = new Date(Date.UTC(year, month, 0));
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  } else if (periodType === "quarterly") {
    end = new Date(Date.UTC(year, Math.floor(month / 3) * 3, 0));
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 2, 1));
  } else if (periodType === "halfYearly") {
    end = month < 6 ? new Date(Date.UTC(year, 0, 0)) : new Date(Date.UTC(year, 6, 0));
    start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - 5, 1));
  } else {
    end = new Date(Date.UTC(year, 0, 0));
    start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  }

  const labels: Record<ReportPeriod, string> = {
    monthly: `شهر ${arabicMonths[end.getUTCMonth()]}`,
    quarterly: `الربع ${Math.floor(end.getUTCMonth() / 3) + 1} لعام ${end.getUTCFullYear()}`,
    halfYearly: `النصف ${end.getUTCMonth() < 6 ? "الأول" : "الثاني"} لعام ${end.getUTCFullYear()}`,
    yearly: `عام ${end.getUTCFullYear()}`,
  };

  return {
    periodStart: dateInputValue(start),
    periodEnd: dateInputValue(end),
    label: labels[periodType],
  };
}

export type PeriodChunk = { start: Date; end: Date };

/** Split an arbitrary date range into chunks that each fall within a single
 *  calendar month and therefore never exceed 31 days. Useful when aggregating
 *  additive account-level metrics across long ranges using Meta's ≤31-day API. */
export function splitRangeByMonth(periodStart: Date, periodEnd: Date): PeriodChunk[] {
  const start = new Date(Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth(), periodStart.getUTCDate()));
  const end = new Date(Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth(), periodEnd.getUTCDate()));
  const chunks: PeriodChunk[] = [];

  let current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (current <= end) {
    const monthEnd = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 0, 23, 59, 59, 999));
    const chunkEnd = monthEnd < end ? monthEnd : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate(), 23, 59, 59, 999));
    const chunkStart = current < start ? new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())) : current;
    chunks.push({ start: chunkStart, end: chunkEnd });
    current = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1));
  }

  return chunks;
}
