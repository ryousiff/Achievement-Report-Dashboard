/**
 * Computes how far back the one-time historical media/insight backfill should reach for a newly
 * connected (or newly re-backfilled) Instagram connection.
 *
 * Rule: the earlier of (a) `months` back from now, and (b) January 1 of the previous calendar year.
 * (b) guarantees a full, completed calendar year is always reachable for a "yearly" report even when
 * (a) alone wouldn't cover it (e.g. a fixed "now minus 15 months" window computed in August only reaches
 * back to May of the previous year, missing January-April of the completed year).
 */
export function calculateBackfillStart(now: Date = new Date(), months = 15): Date {
  const monthsAgo = new Date(now);
  monthsAgo.setUTCMonth(monthsAgo.getUTCMonth() - months);
  monthsAgo.setUTCHours(0, 0, 0, 0);

  const jan1PreviousYear = new Date(Date.UTC(now.getUTCFullYear() - 1, 0, 1));

  return monthsAgo < jan1PreviousYear ? monthsAgo : jan1PreviousYear;
}
