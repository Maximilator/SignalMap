# SignalMap Pro

Production-oriented upgrade of the uploaded SignalMap project.

## What was upgraded

- Fixed Redis wildcard invalidation by replacing `DEL bbox:*` with versioned bbox cache keys.
- Fixed spatial distance correctness by using `location::geography` and meter-based `ST_DWithin`.
- Fixed confirmation race condition with `SELECT ... FOR UPDATE` plus `INSERT ... ON CONFLICT DO NOTHING RETURNING` inside a transaction.
- Moved database setup into a real migration: `db/migrations/001_init.sql`.
- Added signed anonymous session tokens instead of trusting arbitrary `X-SM-Token` values.
- Added Socket.IO authentication using the same signed session token.
- Added dynamic H3 resolution by viewport zoom to reduce room explosion.
- Fixed stats aggregation so totals are not accidentally derived from one grouped category row.
- Improved cron decay with batched reads and no per-expired-signal N+1 lookup.
- Added `signal_events` audit trail table.
- Added flag endpoint and reporter auto-ban support.
- Added Docker Compose for PostGIS and Redis.
- Added frontend session/socket/api helpers compatible with the upgraded backend.

## Structure

```text
apps/api                 Fastify + Socket.IO API
apps/web                 Next.js frontend helpers and original frontend reference source
db/migrations/001_init.sql
schema.sql               Copy of the production migration for convenience
docs/UPGRADE_NOTES.md
```

## Quick start

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local

docker compose up -d
npm install
npm run migrate
npm run dev:api
```

In another terminal:

```bash
npm run dev:web
```

The uploaded frontend source is preserved at:

```text
apps/web/src/sources.reference.ts
```

The upgraded frontend API/session/socket helpers are in:

```text
apps/web/src/lib/session.ts
apps/web/src/lib/api.ts
apps/web/src/lib/socket.ts
```

## Important production notes

Before deploying, replace these secrets:

```env
SESSION_SECRET=replace-with-64-random-chars
FINGERPRINT_SALT=replace-with-64-random-chars
```

Set `CORS_ORIGIN` to exact domains, not `*`.

For high-volume deployment, the next upgrades should be:

1. Vector tiles / MVT instead of full GeoJSON.
2. BullMQ or Temporal for signal expiry instead of cron scanning.
3. Proper object moderation pipeline for uploaded images.
4. Observability: OpenTelemetry, Prometheus, Grafana.
5. Abuse detection model over `signal_events`.
