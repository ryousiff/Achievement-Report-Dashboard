const FOLLOWER_COUNT_PERIOD_LIMIT = /follower_count.*only supports querying data for the last 30 days excluding the current day/i;

export function isUnsupportedFollowerCountPeriodError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return FOLLOWER_COUNT_PERIOD_LIMIT.test(message);
}

export function isEmployeeVisibleSyncError(message: string | null | undefined): boolean {
  return Boolean(message) && !isUnsupportedFollowerCountPeriodError(message);
}
