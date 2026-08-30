const FOLLOWER_COUNT_PERIOD_LIMIT = /follower_count.*only supports querying data for the last 30 days excluding the current day/i;
const APPLICATION_REQUEST_LIMIT = /application request limit reached/i;
const INTERNAL_UNDEFINED_MAP_ERROR = /cannot read properties of undefined \(reading ['\"]map['\"]\)/i;

export function isUnsupportedFollowerCountPeriodError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return FOLLOWER_COUNT_PERIOD_LIMIT.test(message);
}

export function isMetaApplicationRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return APPLICATION_REQUEST_LIMIT.test(message);
}

export function isInternalSyncImplementationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return INTERNAL_UNDEFINED_MAP_ERROR.test(message);
}

export function isEmployeeVisibleSyncError(message: string | null | undefined): boolean {
  if (!message) return false;
  return !(
    isUnsupportedFollowerCountPeriodError(message)
    || isMetaApplicationRateLimitError(message)
    || isInternalSyncImplementationError(message)
  );
}
