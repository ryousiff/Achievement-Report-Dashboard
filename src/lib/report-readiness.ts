/** Employee-facing "قبل الاعتماد" (before approval) readiness/coverage messaging. Kept as pure,
 * testable helpers so the report builder UI never has to decide on its own how to phrase a
 * coverage warning or a failed status check — see src/app/page.tsx's ReportBuilder for the caller. */

/** Shown whenever re-checking coverage/readiness fails for any reason (network error, non-2xx
 * response, etc.). Deliberately a single fixed, friendly string: raw technical errors (e.g. the
 * "fetch failed" a failed network request throws) must never reach the employee — see
 * mapCoverageCheckFailure() below, which is the only place allowed to turn an error into UI text. */
export const COVERAGE_CHECK_ERROR_MESSAGE =
  "تعذّر التحقق من حالة البيانات. حاول تحديث الحالة مرة أخرى.";

/** Shown when there is nothing left to warn about. */
export const COVERAGE_READY_MESSAGE = "البيانات جاهزة للاعتماد.";

export type CoverageLike = { status: string; warnings: string[] } | null | undefined;

/** Maps any thrown error from a coverage/readiness status check to the one fixed, friendly message
 * — never the error's own (possibly raw/technical) message. Callers are expected to still log the
 * original `error` server-side/console for debugging; this function intentionally discards it. */
export function mapCoverageCheckFailure(_error: unknown): string {
  return COVERAGE_CHECK_ERROR_MESSAGE;
}

/** The list of coverage-related warnings to show before approval: the backend's own (already
 * Arabic, already friendly) coverage warnings when coverage isn't COMPLETE, plus — appended, never
 * substituted — a note if the most recent attempt to re-check that status itself failed. A failed
 * check is not the same as regressed coverage, so previously-known warnings are always preserved. */
export function summarizeCoverageIssues(
  coverage: CoverageLike,
  checkError: string | null,
): string[] {
  return [
    ...(coverage && coverage.status !== "COMPLETE" ? coverage.warnings.slice(0, 3) : []),
    ...(checkError ? [checkError] : []),
  ];
}

/** True only when coverage is confirmed COMPLETE and the most recent status check succeeded. */
export function isCoverageReady(coverage: CoverageLike, checkError: string | null): boolean {
  return coverage?.status === "COMPLETE" && !checkError;
}
