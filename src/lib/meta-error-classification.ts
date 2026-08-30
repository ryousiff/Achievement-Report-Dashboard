const FOLLOWER_COUNT_PERIOD_LIMIT = /follower_count.*only supports querying data for the last 30 days excluding the current day/i;

export function isUnsupportedFollowerCountPeriodError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return FOLLOWER_COUNT_PERIOD_LIMIT.test(message);
}

export function isEmployeeVisibleSyncError(message: string | null | undefined): boolean {
  return Boolean(message) && !isUnsupportedFollowerCountPeriodError(message);
}

/** Maps a raw sync error message to an employee-friendly Arabic string. Technical details stay in
 * logs and SyncRun history; this output is the only text employees should see. */
export function mapEmployeeSyncErrorLabel(message: string | null | undefined): string | null {
  if (!message) return null;
  if (isUnsupportedFollowerCountPeriodError(message)) return null;
  if (/rate limit|application request limit reached/i.test(message)) {
    return "تم إيقاف المزامنة مؤقتاً، وستُستأنف تلقائياً.";
  }
  return "تعذّر إكمال إحدى عمليات المزامنة، وسيحاول النظام استكمالها تلقائياً.";
}
