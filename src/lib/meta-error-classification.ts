const FOLLOWER_COUNT_PERIOD_LIMIT = /follower_count.*only supports querying data for the last 30 days excluding the current day/i;
const META_APPLICATION_RATE_LIMIT = /application request limit reached/i;
const INTERNAL_IMPLEMENTATION_ERROR = /cannot read properties of .*reading ['"][^'"]+['"]|\btypeerror\b/i;
const TRANSIENT_FETCH_ERROR = /^fetch failed$/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function isUnsupportedFollowerCountPeriodError(error: unknown): boolean {
  return FOLLOWER_COUNT_PERIOD_LIMIT.test(errorMessage(error));
}

export function isMetaApplicationRateLimitError(error: unknown): boolean {
  return META_APPLICATION_RATE_LIMIT.test(errorMessage(error));
}

export function isInternalSyncImplementationError(error: unknown): boolean {
  return INTERNAL_IMPLEMENTATION_ERROR.test(errorMessage(error));
}

/**
 * Employee-facing data-health cards must never dump raw provider/runtime errors.
 * Rate limits and transient fetch failures are handled automatically by the worker;
 * implementation errors stay in SyncRun/logs for developers. Actionable connection
 * errors that are not in one of these internal/transient classes may still be shown.
 */
export function isEmployeeVisibleSyncError(message: string | null | undefined): boolean {
  if (!message) return false;
  return !isUnsupportedFollowerCountPeriodError(message)
    && !isMetaApplicationRateLimitError(message)
    && !isInternalSyncImplementationError(message)
    && !TRANSIENT_FETCH_ERROR.test(message.trim());
}
