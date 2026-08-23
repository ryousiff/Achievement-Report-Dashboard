# Performance Audit

Scope: make the existing system faster, lower DB query count, lower Meta API usage, lower
network traffic, and safer under load — **without** changing report formulas/values, UI design,
Stories, or Ads scope. Every change below preserves exact output values; where that mattered, a
regression test was added alongside the change (see "Tests added").

Priority key: **P0** = large performance/reliability problem, **P1** = worthwhile optimization,
**P2** = minor/considered-but-deferred.

---

## P0 — Per-day DB queries in follower movement resolvers

**Before:** `dailyFollowerMovementFromDatabase()` and `dailyFollowerMovement()`
(`src/lib/report-data.ts`) looped one calendar day at a time and issued
`socialInsightSnapshot.findFirst`/`findMany` **inside the loop** — 2 queries per day
(`followers_gained` + `followers_lost`). A 31-day report period meant ~62 sequential round-trips
just for this one chart, on top of everything else `buildStandardReportBlocks()` does.

**Problem:** Every report view/refresh/export for a 31-day (or longer, via
`periodAccountFollowersFromDatabase`'s per-chunk calls) period paid for dozens of sequential
DB round trips that could be answered by two.

**Change:** Added `fetchStoredDailyFollowerMovement()`, which bulk-fetches every stored
`followers_gained`/`followers_lost` DAY snapshot for the whole period in exactly **2** queries
(filtered by a `periodStart` range instead of one exact match per day), then groups results by
calendar day (`YYYY-MM-DD`) in memory. Both functions now consult these in-memory maps inside the
loop instead of hitting the DB; `dailyFollowerMovement()` (the live variant) still falls back to
Meta **per missing day only**, exactly as before — no behavior change, just no DB round-trip for
days that are already stored (the common case for a report someone has already opened before).

**Expected/measured improvement:** For a 31-day period with full snapshot coverage: 62 DB queries
→ 2 DB queries (~97% reduction) for this resolver. `dailyFollowerMovementFromDatabase` used by
refresh/export benefits every time; `dailyFollowerMovement` (report creation path) benefits
whenever the period was already synced.

**Risk:** Low. The bulk query re-derives the exact same rows the per-day queries would have found
(same unique key components, `(connectionId, metric, periodType, periodStart, periodEnd)`), just
fetched in fewer round-trips. Values are identical by construction — verified by tests.

**Tests added** (`src/lib/report-data.test.ts`):
- `dailyFollowerMovement` "performance: uses a single pair of bulk queries... and never calls Meta"
- `dailyFollowerMovementFromDatabase` "performance: reads a 31-day period using exactly two bulk
  queries instead of two queries per day"
- `dailyFollowerMovementFromDatabase` "only counts a day as present when both gained and lost
  snapshots exist for it" — proves the bulk rewrite preserves the original day-matching semantics.

---

## P0 — Sequential independent reads in `buildStandardReportBlocks()`

**Before:** `reportPosts()`, the account-level `reach`/`followers`/`views` resolvers, the daily
follower-movement resolver, and a raw `reachDailySnapshots` query were all `await`-ed one after
another even though none of them consumes another's result.

**Problem:** Report build latency was the *sum* of five independent operations' latencies instead
of the *max* of them. For the Meta-backed resolvers (report creation) this could add seconds; even
for the DB-only resolvers (refresh/export) it added unnecessary round-trip latency.

**Change:** These six independent reads (`reportPosts`, `reach`, `followers`, `views`,
`dailyFollowerMovement`, `reachDailySnapshots`) now run inside a single `Promise.all([...])`. Every
computation that depends on their results (totals, KPIs, top-posts) still happens afterward,
synchronously, in the same order as before. Nothing that depends on another async result was
parallelized — e.g. the post-metric-snapshot resolution inside `reportPosts()` still runs after
`socialPost.findMany()` resolves, since it depends on that result.

**Expected/measured improvement:** Report build wall-clock time is now bounded by the *slowest*
of these five reads instead of their *sum* — for the Meta-backed creation path (where each
resolver can be a real network call), this is potentially a multi-second reduction on a period
that isn't fully covered by stored snapshots yet.

**Risk:** Low. All six reads were already independent (verified by reading their signatures: each
only takes `clientId, periodStart, periodEnd`); none mutates shared state the others depend on.
Existing `buildStandardReportBlocks` tests (19 cases covering reach/views/followers/KPIs) all pass
unchanged, confirming output values are identical.

---

## P0 — `upsertPost()` blocked on thumbnail caching

**Before (`src/lib/meta-sync.ts`):** Every post write awaited `persistMediaThumbnail()` — a remote
image download plus a MinIO upload — **before** writing the post's metrics/caption/etc. to the
database. Every incremental sync, historical backfill page, and recent-insight refresh cycle paid
this latency for every single post, serially.

**Problem:** This directly slowed down the metric-critical path (post/metric persistence) for a
purely cosmetic, already-backgroundable concern. It's also why the historical backfill logs show
~20s per chunk of 5 posts even after Meta responses return quickly — most of that was image
downloads/uploads blocking the loop.

**Change:** `upsertPost()` now writes post/metric data first, then kicks off
`persistMediaThumbnail()` **without awaiting it** (fire-and-forget `.then()`/`.catch()`), only
writing `thumbnailStorageKey` once/if it resolves. It's also now skipped entirely when the post
already has a `thumbnailStorageKey` (see next item). Failures are still logged; they were already
silent before (thumbnail persistence was always best-effort, never surfaced to the sync caller).

**Requirements preserved:**
- Post metrics are saved without waiting on image I/O.
- `thumbnailStorageKey` is never written to on the main upsert path (create or update) — so an
  existing cached key is never at risk of being cleared, exactly as before.
- The existing `THUMBNAIL_BACKFILL` background job is unchanged and remains the catch-up path for
  any post that ends up still missing a thumbnail (failed persist, or the process exiting before
  the fire-and-forget promise settles).
- No second thumbnail system was introduced — same `mediaThumbnailKey`/`persistMediaThumbnail`
  from `src/lib/media-storage.ts`.
- No change to Meta request concurrency/throttling — thumbnail fetching hits Instagram's raw CDN
  URL via plain `fetch()`, entirely separate from the Graph API request queue in this same file.

**Expected/measured improvement:** Per-post sync latency drops by the image-download+MinIO-upload
time (order of hundreds of ms to a few seconds per post, per the historical backfill logs) — this
was previously fully serial with post/metric persistence.

**Risk:** Low-medium. A brief window exists where a post is visible with no
`thumbnailStorageUrl` yet (falls back to Meta's short-lived signed URL in the UI, exactly the
existing fallback for any not-yet-cached post) until the background persist completes, typically
sub-second later. Mitigated by the existing `THUMBNAIL_BACKFILL` job as a permanent safety net.

**Tests added** (`src/lib/meta-sync.test.ts`):
- "does not block sync on thumbnail persistence (fire-and-forget), and only writes
  thumbnailStorageKey once it resolves" — proves `runIncrementalSync` completes before a
  deliberately-unresolved thumbnail promise settles, and that the key is written once it does.

---

## P1 — Redundant thumbnail re-download/re-upload on every re-sync

**Before:** `upsertPost()` called `persistMediaThumbnail()` on *every* sync of a post, even one
that already had a `thumbnailStorageKey` — meaning `runRecentInsightRefresh` (which reprocesses
every post published in the last `RECENT_POST_REFRESH_DAYS`, by default 60 days, on a rolling
basis) re-downloaded and re-uploaded the *same, unchanged* image for the same post over and over.

**Problem:** Directly wastes "unnecessary network traffic" (goal #3) and MinIO write load for
zero benefit — a post's display image never changes after publish.

**Change:** The fire-and-forget thumbnail persist (see above) is now skipped entirely when
`record.thumbnailStorageKey` is already set. `THUMBNAIL_BACKFILL` remains responsible for posts
that have never been cached.

**Expected/measured improvement:** Eliminates one Instagram CDN download + one MinIO upload per
already-cached post on every subsequent sync cycle — for an account with hundreds of posts synced
daily via `runRecentInsightRefresh`, this removes the large majority of thumbnail I/O that was
previously happening on a schedule for no reason.

**Risk:** Low. If a previously-cached image ever became invalid (it doesn't, in practice — Meta
does not change a post's media after publish), `THUMBNAIL_BACKFILL` only processes posts with a
**null** `thumbnailStorageKey`, so a stale (but present) key would not self-heal automatically —
this matches its already-documented scope ("catches old posts synced before [caching] existed"),
not a regression introduced here.

**Tests added** (`src/lib/meta-sync.test.ts`):
- "never re-downloads/re-uploads a thumbnail that is already cached for a post."

---

## P1 — `SocialPostMetricSnapshot` resolver: confirmed already bulk (no change needed)

**Audited:** `resolveReportPostMetrics()` (`src/lib/post-metric-snapshots.ts`), added in the
historical-metric-drift fix, already fetches every finalized post's snapshot in a single
`findMany({ where: { postId: { in: [...] } } })` call, not one query per post.

**Change:** None needed — added an explicit regression test to lock this in and catch any future
regression: `resolveReportPostMetrics` "performance: resolves any number of finalized posts with a
single bulk findMany call, not one query per post" (25 posts → exactly 1 `findMany` call).

---

## P1 — Trimmed `select`s on hot post-list queries

**Before:**
- `reportPosts()` (`src/lib/report-data.ts`) — used by every report build/refresh/export —
  fetched every `SocialPost` column with no `select`, including `mediaMetadata` (can hold
  owner/collaborator objects for collaborative posts), `connectionId`, and sync bookkeeping
  fields never read by `ReportPost`.
- `GET /api/clients/:id/posts` (the report builder's live media-picker, `take: 100`) did the same,
  then spread the *entire* raw row (`{...post, ...}`) into the JSON response — shipping
  `mediaMetadata`, `metricAvailability`/`metricAvailabilityState`, `connectionId`,
  `thumbnailStorageKey` (superseded by the derived `thumbnailStorageUrl`), and sync timestamps to
  the browser on every picker open, none of which the `MediaPost` UI type uses.
- The `follower_count` snapshot query in the same route also had no `select`.

**Change:** Added explicit `select` clauses matching exactly what each caller consumes (`ReportPost`
/ `MediaPost` shape respectively), and replaced the `{...post}` spread in the posts route with an
explicit destructure that drops `thumbnailStorageKey`/`mediaSource` (already converted to
`thumbnailStorageUrl`/`isCollaborative`) instead of forwarding them raw.

**Expected/measured improvement:** Smaller Postgres row payloads and smaller JSON responses,
scaling with post count (up to 100 posts per picker open, and up to hundreds for a multi-month
report). No functional change — every field the callers actually read is still selected.

**Risk:** Very low. Selects were derived directly from the exact fields each function's own
mapping code reads.

---

## P1 — Duplicate `/api/clients` fetch during sync/backfill status polling

**Before (`src/app/page.tsx`, `ConnectedAccounts`):** `pollSyncStatus()` and
`pollBackfillStatus()` each did `fetch("/api/clients")` directly to read the latest state, **and
then** called `onRefresh()` (the parent's `refreshClients`, which does its own `fetch("/api/clients")`)
in the same tick — two identical requests per poll iteration, repeated every 3–5s for up to 60
iterations (up to 5 minutes) whenever an employee triggers a sync or historical backfill. This is
exactly what the pasted dev logs showed: `/api/clients` and `/api/meta-accounts` firing every
couple of seconds.

**Change:** `refreshClients()` now returns the fetched client list (previously `Promise<void>`).
Both polling functions call `onRefresh()` once (`Promise.all([onRefresh(), refreshProfiles()])`,
as before) and reuse its return value instead of issuing a second, separate fetch beforehand.

**Expected/measured improvement:** Halves the `/api/clients` request volume during active
sync/backfill polling (2 requests/tick → 1 request/tick), with identical UI behavior/timing.

**Risk:** Low. `refreshClients` already fetched and returned exactly this data internally; only
its return type changed (from discarding the result to returning it). Verified with `npm run
typecheck` across every caller of `onRefresh`/`refreshClients`.

---

## P2 — Considered, not changed

- **Report creation's Meta fallback (`buildStandardReportBlocksPreferStoredPeriodSnapshots`)**:
  audited and confirmed already correct — it only calls Meta for a period chunk when the
  authoritative stored snapshot (`SocialInsightSnapshot` TOTAL_VALUE) is missing; refresh/export/
  slides always use the DB-only builder (`skipMetaApi: true` by default) and never call Meta.
  Opening or exporting an already-covered historical report performs zero Meta calls today — no
  code change needed, requirement already satisfied.
- **`SyncJob` claiming/scheduling**: audited `hasActiveJob`/`enqueueJob` (duplicate prevention
  already in place before every enqueue), `recoverStaleJobs` (reclaims stale `RUNNING` jobs before
  every claim), and the atomic `updateMany`-based claim (safe under multiple workers, though only
  one is required). No duplicate-queuing, unnecessary polling, or full-table-scan risk found — the
  claim query (`status = QUEUED AND runAfter <= now`, `ORDER BY createdAt`) is covered by the
  existing `@@index([status, runAfter])`; a queue table's `QUEUED` subset is small at any moment,
  so sorting that filtered subset by `createdAt` without a dedicated `[status, createdAt]` index is
  not worth the extra write-side index maintenance. No change made.
- **`db.report.findMany` (list) and other already-`select`-scoped queries**: left as-is; each
  either already used `select`/`take`, or every included field (e.g. `blocks` for a report list
  that renders block previews) is genuinely consumed by its caller.
- **`runRecentInsightRefresh`'s `socialPost.findMany`**: nearly every column is genuinely used
  (including `mediaMetadata`, re-sent back to Meta-shaped input); only `thumbnailStorageKey`/
  `metricAvailability`/`syncedAt` are unused, a marginal saving on an already-bounded
  (`historicalBackfillPostsPerRun`-capped) query. Not worth the added maintenance surface for the
  size of the win.
- **MinIO bucket exposure**: audited `media-storage.ts` — no bucket policy is ever set to public;
  the bucket stays private, and `/api/media/[...key]` already requires an authenticated session
  (`view_reports`) before streaming. Already compliant, no change.
- **Thumbnail proxy caching**: `/api/media/[...key]` already sets
  `Cache-Control: private, max-age=86400, immutable`. Adding `ETag`/conditional-request support was
  considered but skipped — `immutable` already tells browsers never to revalidate within the cache
  window, and the underlying object at a given key never changes in practice (a post's image is
  fixed after publish; see the P1 item above), so an `ETag` round-trip would only add complexity
  without a measurable benefit.

---

## Instrumentation added (goal: measure before/after)

Most of the operations goal #10 asks to measure were **already** instrumented:
- `SyncJob`/`SyncRun` rows already record `durationMs` and post counts for every incremental sync,
  historical backfill chunk, recent-insight refresh, and `THUMBNAIL_BACKFILL` chunk
  (`src/lib/sync-queue.ts`), logged as structured JSON (`sync.job.succeeded`/`sync.job.failed`).

Added:
- `report.refresh.completed` (`src/lib/report-refresh.ts`): logs `reportId`, `clientId`, block
  count, coverage status, and `durationMs` for every `refreshReportData()` call — the shared path
  used by report refresh, export, and Slides export, and also invoked once during report creation.

No new query-counting middleware was added; the regression tests added above assert exact DB call
counts (`toHaveBeenCalledTimes(...)`) for the specific hot paths that were optimized, which is a
more precise and durable check than a generic global counter.

---

## Verification

- `npm test` — all existing tests plus new regression tests pass (identical report/KPI/media
  values before and after every change above).
- `npm run typecheck` — clean.
- `npm run build` — succeeds.
