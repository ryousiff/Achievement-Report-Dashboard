# Project Commands

- `npm run dev` starts the local dashboard.
- `npm run typecheck` validates TypeScript.
- `npm run build` creates the production build.
- `npm run test` runs the Vitest suite.
- `docker compose up -d` starts local PostgreSQL and MinIO after production passwords are replaced.

# Multi-Platform Connector Setup

Connectors live in `src/lib/connectors/`. The shared `SocialConnector` interface in `src/lib/connectors/types.ts` defines authorization, account discovery, callback persistence, and sync.

## Supported providers

- **Meta** (`meta`) — Facebook Pages + Instagram Business. Configure `META_APP_ID`, `META_APP_SECRET`, `META_REDIRECT_URI`, and `META_TOKEN_ENCRYPTION_KEY`. OAuth: `/api/connectors/meta`, callback: `/api/connectors/meta/callback`.
- **TikTok** (`tiktok`) — stub connector. Configure `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI`. OAuth: `/api/connectors/tiktok`, callback: `/api/connectors/tiktok/callback`.
- **LinkedIn** (`linkedin`) — stub connector. Configure `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`. OAuth: `/api/connectors/linkedin`, callback: `/api/connectors/linkedin/callback`.
- **YouTube** (`youtube`) — stub connector. Configure `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REDIRECT_URI`. OAuth: `/api/connectors/youtube`, callback: `/api/connectors/youtube/callback`.
- **X** (`x`) — stub connector. Configure `X_CLIENT_ID`, `X_CLIENT_SECRET`, `X_REDIRECT_URI`. OAuth: `/api/connectors/x`, callback: `/api/connectors/x/callback`.

A provider only exposes a working **Connect** flow when it is both `isConfigured()` (credentials present) and `isImplemented === true`. Stubs return a clear `not_implemented` error and are safe to leave configured.

## Adding a new connector

1. Implement the `SocialConnector` interface in `src/lib/connectors/<provider>.ts`.
2. Register it in `src/lib/connectors/registry.ts`.
3. If it supports sync, the worker will pick it up automatically via `getConnectorForPlatform()`.
4. Add the required environment keys to `.env.example` and `src/lib/env.ts`.
