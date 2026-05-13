# Upgrade notes

## Critical fixes applied

### 1. Redis invalidation

Original code used:

```ts
await redis.del('bbox:*')
```

Redis `DEL` does not support glob patterns. The upgraded API uses a cache version key:

```ts
bbox:v${version}:...
```

Creating, confirming, flagging, or expiring a signal increments `bbox:version`.

### 2. Correct PostGIS distance

Original `ST_DWithin(location, point, 0.001)` used degrees, not meters. The upgrade uses:

```sql
ST_DWithin(location::geography, point::geography, 100)
```

### 3. Confirmation race condition

Original flow checked for a confirmation and inserted later. The upgrade locks the signal row and relies on `ON CONFLICT DO NOTHING RETURNING` in one transaction.

### 4. Schema drift

Runtime `initDB()` and `schema.sql` were diverging. The upgrade removes runtime schema creation and uses a migration file.

### 5. Weak identity

Original API accepted any user-supplied `X-SM-Token`. The upgrade introduces signed anonymous session tokens from `/api/session`.

### 6. H3 scaling

Original app used one fixed H3 resolution. The upgrade uses dynamic resolution based on zoom.

## Files intentionally preserved

The original all-in-one frontend source is preserved as `apps/web/src/sources.reference.ts`. It is useful as a component reference, but the production helpers in `apps/web/src/lib` should replace the original API/socket helpers.
