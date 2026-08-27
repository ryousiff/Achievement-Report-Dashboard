# Kaan Achievement Reports

An Arabic-first, RTL social-media reporting dashboard for Kaan Agency. It helps employees manage multiple clients, connect their social accounts, build editable monthly reports, and export approved reports as PDFs or Google Slides.

## Current foundation

- Employee-friendly Arabic dashboard with English-language switch control
- Instagram-first reporting workflow and multi-client account model
- Standard monthly report and completely blank report templates
- Editable report blocks: text, KPIs, charts, media, notes, and recommendations
- On-demand or scheduled auto-generated **drafts**; employees must review before approval/export
- Meta, Google Slides, MinIO, PostgreSQL, webhooks, and background job architecture documented for implementation

The current UI is a functional product prototype. Live OAuth, persistence, exports, and workers require the credentials and services described below.

## Quick start

### Requirements

- Node.js 20 or newer
- npm 10 or newer
- Docker Desktop (for PostgreSQL and MinIO)

### Configuration

1. Copy `.env.example` to `.env`.
2. Generate long random values for `NEXTAUTH_SECRET` and `AUTOMATION_WEBHOOK_SECRET`.
3. Fill in Meta, Google, PostgreSQL, and MinIO values when those services are configured.
4. Never commit `.env`; it is excluded by `.gitignore`.

`.env` is where local or server-specific secrets live. It keeps database passwords, Meta/Google OAuth secrets, storage credentials, and session secrets out of source control. `.env.example` is a safe, committed checklist of variable names only.

### Run the dashboard

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

### Database client

After changing `prisma/schema.prisma`, regenerate the type-safe database client:

```bash
npm run db:generate
```

Start the local containers with `docker compose up -d`, then create and apply a reviewed Prisma migration before using live client data. The internal service routes require `INTERNAL_API_KEY` in the request header; browser sessions must use the planned authenticated server routes rather than this service credential.

### Verify before deployment

```bash
npm run typecheck
npm run build
```

## Kaan visual identity

The dashboard currently applies the Kaan palette from the supplied agency reference: orange `#FF5001`, purple `#3C0B5E`, and dark text `#1A1A1A`.

Before embedding final identity assets, provide an SVG or transparent PNG export of the official Illustrator logo. The supplied Zarid and TS Zunburk font files are not bundled in the web application until their licenses explicitly permit web embedding (`@font-face`) on the agency server. Once that is confirmed, place the approved webfont files in the project’s font assets and register only the licensed weights.

## Production architecture

- **Next.js application:** web UI, protected APIs, report editor, and export endpoints.
- **PostgreSQL:** users, clients, platform connections, analytics snapshots, report drafts, schedules, exports, and audit history.
- **MinIO:** private uploads and generated PDF assets. Use signed, expiring URLs instead of public buckets.
- **Background worker:** data sync, scheduled draft creation, PDF rendering, and Google Slides export. These jobs must not run inside a browser request.
- **Reverse proxy:** HTTPS termination, request size limits, headers, and rate limiting on the agency server.

## Employee sign-in

The initial email/password flow uses a one-time secure bootstrap endpoint to create the first employee account and then issues a 12-hour, HTTP-only, same-site session cookie. Set `INITIAL_ADMIN_SETUP_TOKEN` to a long random secret and use it only to call `POST /api/auth/bootstrap` before the first account exists. Do not expose this value in a browser or commit it to Git.

Available endpoints are `POST /api/auth/login`, `POST /api/auth/logout`, and `GET /api/auth/me`. Workspace client/report routes accept the employee session cookie; `INTERNAL_API_KEY` remains restricted to trusted agency workers and integrations. Google Workspace login remains pending the agency Google OAuth credentials.

## Meta connection workflow

1. An employee opens a client workspace and selects **Connect Meta**.
2. Meta OAuth authenticates with the agency account; the dashboard never receives a Meta password.
3. The employee chooses the correct Facebook Page and Instagram Business account from the agency Business Portfolio.
4. The dashboard encrypts the returned refresh/access credential server-side and attaches selected assets to exactly one client.
5. A background job fetches allowed metrics and selected media. Store a dated snapshot with each report so approved reports remain reproducible.

Instagram is the default platform for new reports. Facebook and future connectors can be explicitly enabled per client.

## Automatic reports

The product supports two safe paths:

- **On demand:** employee selects client/date range and chooses Auto-generate.
- **Schedule:** a monthly schedule creates a draft for active clients.

Both paths create a `needs review` draft only. An employee must review/edit and approve before a PDF, Slides export, or any eventual client delivery.

## Google Slides export

Use an agency-owned Google Workspace account and OAuth consent flow. Give the application only the Google Slides/Drive scopes required to create and manage presentations it owns. Keep the credentials in `.env` or a production secret manager.

## Future automation

Publish signed webhook events for: analytics sync completed/failed, report draft created, report approved, and export completed. This permits safe later integration with n8n, Make, Zapier, or a private agency workflow without exposing Meta/Google credentials.

## Security checklist

- Enforce HTTPS in production.
- Use hashed passwords, secure HTTP-only session cookies, CSRF protection, and login rate limiting.
- Encrypt OAuth tokens at rest; never log token values.
- Enforce client-level authorization on every API query.
- Keep MinIO buckets private and use short-lived signed download URLs.
- Back up PostgreSQL and MinIO regularly and test restore procedures.
- Configure Meta and Google OAuth redirect URLs to the exact production domain.

## Before going live

1. Provide Kaan logo files, colors, typography, and approved report screenshots.
2. Register a Meta application, request required permissions, and complete any App Review requirements.
3. Create the Google Cloud OAuth application for the agency Workspace account.
4. Configure PostgreSQL, MinIO, backups, and production environment secrets.
5. Implement database migrations, session/auth flows, background workers, and provider APIs before turning on real client accounts.


Terminal 1: npm run dev
Terminal 2: npx ngrok http 3000

docker compose logs -f worker
npx tsx scripts/period-account-snapshots.ts
docker compose exec -T postgres psql -U kaan -d kaan_reports -c '
SELECT
  COUNT(*) FILTER (WHERE "thumbnailStorageKey" IS NOT NULL) AS stored,
  COUNT(*) FILTER (WHERE "thumbnailStorageKey" IS NULL) AS remaining,
  COUNT(*) AS total
FROM "SocialPost";
'


to raise the priority of a job:
docker compose exec -T postgres psql -U kaan -d kaan_reports -c "
UPDATE \"SyncJob\"
SET priority = 100,
    \"runAfter\" = NOW()
WHERE \"connectionId\" = 'cmt9sczk30003sjub01ahsw4s'
  AND type = 'HISTORICAL_COLLABORATIVE_BACKFILL'
  AND status = 'QUEUED';
"

### for the cooldown

docker compose exec -T postgres psql -U kaan -d kaan_reports -c "
SELECT
  \"moduleId\",
  key,
  value
FROM \"Setting\"
WHERE \"moduleId\" = 'meta_cooldown';
"

