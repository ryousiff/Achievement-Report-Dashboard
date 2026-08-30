const FOLLOWER_COUNT_PERIOD_LIMIT = /follower_count.*only supports querying data for the last 30 days excluding the current day/i;

export function isUnsupportedFollowerCountPeriodError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return FOLLOWER_COUNT_PERIOD_LIMIT.test(message);
}

export function isEmployeeVisibleSyncError(message: string | null | undefined): boolean {
  return Boolean(message) && !isUnsupportedFollowerCountPeriodError(message);
}

export type SyncErrorPresentation = { label: string; state: "warn" | "error" };

/** Maps a raw sync error message to an employee-friendly Arabic label and severity.
 * Technical details stay in logs and SyncRun history; this output is the only text employees should see. */
export function mapEmployeeSyncErrorPresentation(
  message: string | null | undefined,
  options: { terminal?: boolean } = {},
): SyncErrorPresentation | null {
  if (!message) return null;
  if (isUnsupportedFollowerCountPeriodError(message)) return null;
  if (/rate limit|application request limit reached/i.test(message)) {
    return { label: "تم إيقاف المزامنة مؤقتاً، وستُستأنف تلقائياً.", state: "warn" };
  }
  if (options.terminal) {
    return { label: "فشلت المزامنة.", state: "error" };
  }
  return { label: "تعذّر إكمال إحدى عمليات المزامنة، وسيحاول النظام استكمالها تلقائياً.", state: "warn" };
}
