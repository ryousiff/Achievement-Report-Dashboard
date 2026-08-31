# Kaan Achievement Reports — Project Overview

## Brief
Kaan Achievement Reports is an Arabic-first, RTL social-media reporting dashboard built for Kaan Agency. It gives employees a single place to manage clients, connect social accounts, build editable monthly achievement reports, and export approved reports as PDFs or Google Slides decks.

## What it does
- **Client management:** Create and manage multiple agency clients in a shared workspace.
- **Account connections:** Link each client to their Instagram Business (and future Meta/Facebook, TikTok, LinkedIn, YouTube, X) accounts via OAuth.
- **Data sync:** Pull post-level and account-level metrics from Meta on demand or on a schedule.
- **Report builder:** Generate a monthly report draft automatically from synced data, then let employees edit text, KPIs, charts, media carousels, recommendations, and closing pages.
- **Review & approval:** Reports start as drafts; employees review and approve before any client-facing export.
- **Export:** Approved reports can be exported as PDF (browser print) or Google Slides presentations.

## Key features built
- Arabic-first UI with English-language switch and full RTL layout.
- Multi-client workspace with role-based feature access.
- Instagram-first Meta connector with OAuth, token encryption, and account discovery.
- Standard monthly report template (10 sections) plus a completely blank template.
- Editable report blocks: cover text, KPI grids, follower-growth chart, top-post media sections, recommendations, and closing text.
- Report readiness checks and coverage warnings before approval.
- Automated drafts via a background worker and scheduled sync jobs.
- Historical metric snapshots so approved reports stay reproducible even after live metrics change.
- Post thumbnail backfill pipeline with rate-limit handling.
- Google Slides export integration (requires OAuth setup).
- Sponsored ads section and monthly ad-budget tracking.

## Tech used
| Layer | Technology |
|-------|------------|
| Framework | Next.js 15 (App Router), React 19 |
| Language | TypeScript 5.8 |
| Styling | Plain CSS with CSS variables for the Kaan brand palette |
| Database | PostgreSQL via Prisma ORM |
| Object storage | MinIO |
| Auth | Custom session cookie + bcrypt password hashing |
| Background jobs | In-house worker queue over PostgreSQL |
| External APIs | Meta Graph API, Google Slides/Drive API |
| Testing | Vitest |
| DevOps | Docker Compose for local PostgreSQL + MinIO |

## Architecture highlights
- **Next.js app** serves the UI and protected API routes.
- **PostgreSQL** stores users, clients, platform connections, social posts, insight snapshots, report drafts/versions/exports, sync jobs, and settings.
- **MinIO** stores private uploads and generated assets; access is through signed, expiring URLs.
- **Background worker** drains `SyncJob` rows for data sync, report drafting, thumbnail backfill, and scheduled jobs; it never runs inside a browser request.
- **Connectors** live under `src/lib/connectors/` and implement a shared `SocialConnector` interface; only Meta is fully implemented; TikTok/LinkedIn/YouTube/X are stubs.

## Important details
- **Security-first defaults:**
  - OAuth tokens are encrypted at rest and never logged or returned to the client.
  - Session cookies are HTTP-only, same-site, and expire after 12 hours.
  - Every API route validates the session and enforces feature-based authorization.
  - MinIO buckets stay private; no public asset URLs.
- **Report immutability:** Once a report is approved, a `ReportVersion` snapshot is created. Future refreshes cannot mutate approved reports, and historical snapshots protect finalized post metrics from drift.
- **Coverage & readiness:** A report cannot be approved until required sections are filled, the connected account has synced recently, and metric coverage is complete (or the employee explicitly overrides).
- **Localization:** All user-facing strings are stored in Arabic/English dictionaries; the UI is always RTL.
- **Development workflow:**
  - `npm run dev` starts the Next.js app and the background worker.
  - `npm run typecheck` and `npm run build` verify types and build.
  - `npm test` runs the Vitest suite.
  - `docker compose up -d` starts PostgreSQL and MinIO locally.
- **Before going live:** Provide the official Kaan logo assets and font licenses; register a Meta app and complete any App Review steps; set up a Google Cloud OAuth app for Slides export; configure production secrets, backups, and HTTPS.
