import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { Pool, PoolClient } from 'pg';
import { z, ZodError } from 'zod';
import * as h3 from 'h3-js';
import crypto from 'crypto';
import cron from 'node-cron';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  SESSION_SECRET: z.string().min(24).default('dev-session-secret-change-me-immediately'),
  FINGERPRINT_SALT: z.string().min(24).default('dev-fingerprint-salt-change-me-now'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  MAX_SIGNALS_PER_BBOX: z.coerce.number().int().min(1).max(2000).default(500),
  S3_BUCKET: z.string().optional().default(''),
  S3_REGION: z.string().default('eu-west-1')
});

const config = envSchema.parse(process.env);

const SIGNAL_CATEGORIES = [
  'police_patrol', 'foot_patrol', 'bicycle_patrol', 'road_check',
  'incident', 'protest', 'public_action', 'temp_restriction',
  'emergency', 'unusual_activity'
] as const;

type SignalCategory = typeof SIGNAL_CATEGORIES[number];
type TrustState = 'ghost' | 'low' | 'medium' | 'high' | 'verified';

interface SignalRow {
  id: string;
  category: SignalCategory;
  lat: number;
  lng: number;
  description?: string | null;
  image_url?: string | null;
  reporter_token: string;
  trust_score: number;
  confirmation_count: number;
  freshness: number;
  trust_state: TrustState;
  is_active: boolean;
  created_at: Date;
  expires_at: Date;
  updated_at: Date;
}

const CATEGORY_COLORS: Record<SignalCategory, string> = {
  police_patrol: '#3d8bff',
  foot_patrol: '#a066ff',
  bicycle_patrol: '#00c97a',
  road_check: '#ffb300',
  incident: '#ff3355',
  protest: '#ff6b6b',
  public_action: '#ff7733',
  temp_restriction: '#00b8d4',
  emergency: '#ff0033',
  unusual_activity: '#94a3b8'
};

const CATEGORY_TTL_MINUTES: Record<SignalCategory, number> = {
  police_patrol: 45, foot_patrol: 40, bicycle_patrol: 40,
  road_check: 60, incident: 30, protest: 180,
  public_action: 60, temp_restriction: 240,
  emergency: 120, unusual_activity: 20
};

const DECAY_RATES: Record<SignalCategory, number> = {
  police_patrol: 0.020, foot_patrol: 0.022, bicycle_patrol: 0.022,
  road_check: 0.015, incident: 0.035, protest: 0.008,
  public_action: 0.018, temp_restriction: 0.006,
  emergency: 0.010, unusual_activity: 0.040
};

const db = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

const redis = createClient({ url: config.REDIS_URL });
const redisSub = redis.duplicate();

function computeTrustScore(
  confirmCount: number,
  category: SignalCategory,
  createdAt: Date,
  reporterScore = 50,
  nearbyCount = 0
): { score: number; freshness: number; state: TrustState } {
  const ageMinutes = Math.max(0, (Date.now() - new Date(createdAt).getTime()) / 60_000);
  const freshness = Math.exp(-(DECAY_RATES[category] ?? 0.02) * ageMinutes);
  const base = Math.min(confirmCount * 8, 60) + 8;
  const reporterWeight = Math.min(1, 0.5 + reporterScore / 200);
  const densityBonus = 1 + Math.min(0.3, nearbyCount * 0.05);
  const score = Math.min(100, Math.max(0, Math.round(base * freshness * reporterWeight * densityBonus)));

  let state: TrustState = 'ghost';
  if (score > 10) state = 'low';
  if (score > 25) state = 'medium';
  if (score > 55) state = 'high';
  if (score > 80) state = 'verified';
  return { score, freshness: Math.max(0, Math.min(1, freshness)), state };
}

function hmac(input: string, secret = config.SESSION_SECRET): string {
  return crypto.createHmac('sha256', secret).update(input).digest('base64url');
}

function issueSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iat: Math.floor(Date.now() / 1000),
    nonce: crypto.randomBytes(18).toString('base64url')
  })).toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

function verifySessionToken(token?: string): string | null {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = hmac(payload);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  return crypto.createHmac('sha256', config.FINGERPRINT_SALT).update(token).digest('hex').slice(0, 40);
}

const createSignalSchema = z.object({
  category: z.enum(SIGNAL_CATEGORIES),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  description: z.string().trim().max(280).optional(),
  image_url: z.string().url().optional()
});

const bboxSchema = z.object({
  sw_lat: z.coerce.number().min(-90).max(90),
  sw_lng: z.coerce.number().min(-180).max(180),
  ne_lat: z.coerce.number().min(-90).max(90),
  ne_lng: z.coerce.number().min(-180).max(180),
  categories: z.string().optional()
}).refine(v => v.sw_lat <= v.ne_lat, 'sw_lat must be <= ne_lat');

const idSchema = z.object({ id: z.string().uuid() });
const flagSchema = z.object({ reason: z.string().trim().max(140).optional() });

declare module 'fastify' {
  interface FastifyRequest {
    userToken: string;
  }
}

function parseCategories(raw?: string): SignalCategory[] | undefined {
  if (!raw) return undefined;
  const wanted = raw.split(',').map(s => s.trim()).filter(Boolean);
  const valid = wanted.filter((c): c is SignalCategory => (SIGNAL_CATEGORIES as readonly string[]).includes(c));
  return valid.length ? [...new Set(valid)] : undefined;
}

async function getCacheVersion(): Promise<string> {
  return (await redis.get('bbox:version')) ?? '1';
}

async function bumpCacheVersion(): Promise<void> {
  await redis.incr('bbox:version');
}

function toFeature(sig: SignalRow) {
  const ageMinutes = Math.max(0, (Date.now() - new Date(sig.created_at).getTime()) / 60_000);
  return {
    type: 'Feature' as const,
    geometry: { type: 'Point' as const, coordinates: [Number(sig.lng), Number(sig.lat)] as [number, number] },
    properties: {
      id: sig.id,
      category: sig.category,
      trust: Number(sig.trust_score),
      freshness: Number(sig.freshness),
      color: CATEGORY_COLORS[sig.category],
      confirmation_count: Number(sig.confirmation_count),
      age_minutes: Math.round(ageMinutes),
      trust_state: sig.trust_state,
      description: sig.description ?? undefined
    }
  };
}

async function getSignalsInBbox(swLat: number, swLng: number, neLat: number, neLng: number, categories?: SignalCategory[]) {
  const params: unknown[] = [swLng, swLat, neLng, neLat, config.MAX_SIGNALS_PER_BBOX];
  let catSql = '';
  if (categories?.length && categories.length < SIGNAL_CATEGORIES.length) {
    params.push(categories);
    catSql = 'AND category = ANY($6::signal_category[])';
  }

  const { rows } = await db.query<SignalRow>(`
    SELECT id, category, ST_Y(location) AS lat, ST_X(location) AS lng,
           description, image_url, reporter_token, trust_score,
           confirmation_count, freshness, trust_state, is_active,
           created_at, expires_at, updated_at
    FROM signals
    WHERE is_active = TRUE
      AND location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      ${catSql}
    ORDER BY trust_score DESC, created_at DESC
    LIMIT $5
  `, params);
  return rows;
}

async function checkDuplicate(category: SignalCategory, lat: number, lng: number): Promise<boolean> {
  const { rows } = await db.query(`
    SELECT id
    FROM signals
    WHERE is_active = TRUE
      AND category = $1
      AND ST_DWithin(
        location::geography,
        ST_SetSRID(ST_MakePoint($3, $2), 4326)::geography,
        100
      )
      AND created_at > NOW() - INTERVAL '10 minutes'
    LIMIT 1
  `, [category, lat, lng]);
  return rows.length > 0;
}

async function createSignalDB(data: {
  category: SignalCategory; lat: number; lng: number; description?: string; imageUrl?: string; reporterToken: string;
}): Promise<SignalRow> {
  const ttlMin = CATEGORY_TTL_MINUTES[data.category];
  const { rows } = await db.query<SignalRow>(`
    WITH inserted AS (
      INSERT INTO signals (category, location, description, image_url, reporter_token, expires_at)
      VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $6, NOW() + ($7 || ' minutes')::interval)
      RETURNING *
    ), reporter AS (
      INSERT INTO reporter_scores (token, total_signals)
      VALUES ($6, 1)
      ON CONFLICT (token) DO UPDATE
      SET total_signals = reporter_scores.total_signals + 1, last_seen = NOW()
      RETURNING token
    )
    SELECT inserted.id, inserted.category, ST_Y(inserted.location) AS lat, ST_X(inserted.location) AS lng,
           inserted.description, inserted.image_url, inserted.reporter_token, inserted.trust_score,
           inserted.confirmation_count, inserted.freshness, inserted.trust_state, inserted.is_active,
           inserted.created_at, inserted.expires_at, inserted.updated_at
    FROM inserted
  `, [data.category, data.lat, data.lng, data.description ?? null, data.imageUrl ?? null, data.reporterToken, ttlMin]);
  return rows[0];
}

async function addConfirmation(signalId: string, userToken: string): Promise<SignalRow | null> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const { rows: sigRows } = await client.query<SignalRow>(`
      SELECT id, category, ST_Y(location) AS lat, ST_X(location) AS lng, description, image_url,
             reporter_token, trust_score, confirmation_count, freshness, trust_state,
             is_active, created_at, expires_at, updated_at
      FROM signals
      WHERE id = $1 AND is_active = TRUE
      FOR UPDATE
    `, [signalId]);
    const sig = sigRows[0];
    if (!sig || sig.reporter_token === userToken) {
      await client.query('ROLLBACK');
      return null;
    }

    const inserted = await client.query(
      'INSERT INTO confirmations (signal_id, user_token) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id',
      [signalId, userToken]
    );
    if (inserted.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const [{ rows: nearbyRows }, { rows: reporterRows }] = await Promise.all([
      client.query(`
        SELECT COUNT(*)::int AS cnt
        FROM signals
        WHERE is_active = TRUE
          AND id <> $1
          AND ST_DWithin(location::geography, (SELECT location FROM signals WHERE id = $1)::geography, 500)
      `, [signalId]),
      client.query('SELECT score FROM reporter_scores WHERE token = $1', [sig.reporter_token])
    ]);

    const newConfirmCount = sig.confirmation_count + 1;
    const { score, freshness, state } = computeTrustScore(
      newConfirmCount,
      sig.category,
      sig.created_at,
      reporterRows[0]?.score ?? 50,
      nearbyRows[0]?.cnt ?? 0
    );

    const { rows: updated } = await client.query<SignalRow>(`
      UPDATE signals
      SET confirmation_count = $2,
          trust_score = $3,
          freshness = $4,
          trust_state = $5,
          updated_at = NOW()
      WHERE id = $1
      RETURNING id, category, ST_Y(location) AS lat, ST_X(location) AS lng,
                description, image_url, reporter_token, trust_score,
                confirmation_count, freshness, trust_state, is_active,
                created_at, expires_at, updated_at
    `, [signalId, newConfirmCount, score, freshness, state]);

    await client.query(`
      INSERT INTO reporter_scores (token, confirmed_signals)
      VALUES ($1, 1)
      ON CONFLICT (token) DO UPDATE
      SET confirmed_signals = reporter_scores.confirmed_signals + 1, last_seen = NOW()
    `, [sig.reporter_token]);

    await client.query('COMMIT');
    return updated[0] ?? null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function flagSignal(signalId: string, userToken: string, reason?: string): Promise<boolean> {
  const { rows } = await db.query(`
    WITH inserted AS (
      INSERT INTO signal_flags (signal_id, user_token, reason)
      SELECT id, $2, $3 FROM signals WHERE id = $1 AND is_active = TRUE
      ON CONFLICT DO NOTHING
      RETURNING signal_id
    ), bump AS (
      UPDATE reporter_scores rs
      SET flagged_count = flagged_count + 1, last_seen = NOW()
      WHERE token = (SELECT reporter_token FROM signals WHERE id = $1)
        AND EXISTS (SELECT 1 FROM inserted)
      RETURNING rs.token
    )
    SELECT COUNT(*)::int AS count FROM inserted
  `, [signalId, userToken, reason ?? null]);
  return rows[0]?.count === 1;
}

function h3ResolutionForZoom(zoom?: number): number {
  if (!zoom || zoom < 8) return 3;
  if (zoom < 12) return 5;
  if (zoom < 15) return 7;
  return 8;
}

function getViewportCells(swLat: number, swLng: number, neLat: number, neLng: number, zoom?: number): string[] {
  const res = h3ResolutionForZoom(zoom);
  const cells = new Set<string>();
  const latSteps = Math.max(2, Math.min(8, Math.ceil(Math.abs(neLat - swLat) * 4)));
  const lngSteps = Math.max(2, Math.min(8, Math.ceil(Math.abs(neLng - swLng) * 4)));
  for (let i = 0; i <= latSteps; i++) {
    for (let j = 0; j <= lngSteps; j++) {
      const lat = swLat + ((neLat - swLat) * i) / latSteps;
      const lng = swLng + ((neLng - swLng) * j) / lngSteps;
      cells.add(h3.latLngToCell(lat, lng, res));
    }
  }
  return [...cells];
}

function emitToNearbyCells(io: Server, lat: number, lng: number, event: string, payload: unknown, zoomRes = 7) {
  const cell = h3.latLngToCell(lat, lng, zoomRes);
  for (const c of h3.gridDisk(cell, 1)) io.to(c).emit(event, payload);
}

async function runDecayCycle(io: Server) {
  const { rows: activeSignals } = await db.query<Pick<SignalRow, 'id' | 'category' | 'confirmation_count' | 'created_at' | 'lat' | 'lng'> & { reporter_score: number }>(`
    SELECT s.id, s.category, s.confirmation_count, s.created_at,
           ST_Y(s.location) AS lat, ST_X(s.location) AS lng,
           COALESCE(rs.score, 50) AS reporter_score
    FROM signals s
    LEFT JOIN reporter_scores rs ON rs.token = s.reporter_token
    WHERE s.is_active = TRUE
      AND (s.updated_at < NOW() - INTERVAL '45 seconds' OR s.expires_at <= NOW())
    LIMIT 10000
  `);

  const updates = [] as Array<{ id: string; score: number; freshness: number; state: TrustState; lat: number; lng: number }>;
  const expired = [] as Array<{ id: string; lat: number; lng: number }>;

  for (const sig of activeSignals) {
    const { score, freshness, state } = computeTrustScore(sig.confirmation_count, sig.category, sig.created_at, sig.reporter_score);
    const ttlExpired = Date.now() > new Date(sig.created_at).getTime() + CATEGORY_TTL_MINUTES[sig.category] * 60_000;
    if (freshness < 0.02 || ttlExpired) expired.push({ id: sig.id, lat: Number(sig.lat), lng: Number(sig.lng) });
    else updates.push({ id: sig.id, score, freshness, state, lat: Number(sig.lat), lng: Number(sig.lng) });
  }

  if (updates.length) {
    await db.query(`
      UPDATE signals s
      SET trust_score = u.score,
          freshness = u.freshness,
          trust_state = u.state::trust_state,
          updated_at = NOW()
      FROM (
        SELECT UNNEST($1::uuid[]) AS id,
               UNNEST($2::int[]) AS score,
               UNNEST($3::numeric[]) AS freshness,
               UNNEST($4::text[]) AS state
      ) u
      WHERE s.id = u.id
    `, [updates.map(u => u.id), updates.map(u => u.score), updates.map(u => u.freshness), updates.map(u => u.state)]);

    for (const u of updates) {
      emitToNearbyCells(io, u.lat, u.lng, 'signal:updated', {
        id: u.id,
        trust_score: u.score,
        freshness: u.freshness,
        trust_state: u.state
      });
    }
  }

  if (expired.length) {
    await db.query('UPDATE signals SET is_active = FALSE, updated_at = NOW() WHERE id = ANY($1::uuid[])', [expired.map(e => e.id)]);
    for (const e of expired) emitToNearbyCells(io, e.lat, e.lng, 'signal:expired', { id: e.id });
    await bumpCacheVersion();
  }

  await db.query(`
    INSERT INTO signals_archive
    SELECT s.*, s.trust_score AS final_trust_score, s.confirmation_count AS final_confirm_count, NOW() AS archived_at
    FROM signals s
    WHERE s.is_active = FALSE AND s.created_at < NOW() - INTERVAL '7 days'
    ON CONFLICT (id) DO NOTHING
  `);
  await db.query("DELETE FROM signals WHERE is_active = FALSE AND created_at < NOW() - INTERVAL '7 days'");
}

async function updateReporterScores() {
  await db.query(`
    UPDATE reporter_scores
    SET score = LEAST(100, GREATEST(0,
      CASE WHEN total_signals = 0 THEN 50
           ELSE (50 + (confirmed_signals::float / GREATEST(total_signals, 1) * 50))::int
      END - flagged_count * 10
    )),
    is_banned = flagged_count >= 10,
    last_seen = NOW()
  `);
}

async function buildApp() {
  await redis.connect();
  await redisSub.connect();
  await redis.setNX('bbox:version', '1');

  const app = Fastify({
    logger: config.NODE_ENV !== 'test',
    trustProxy: config.NODE_ENV === 'production' ? ['127.0.0.1', '::1'] : true,
    bodyLimit: 1_000_000
  });

  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({ error: 'Validation failed', details: error.flatten() });
    }
    app.log.error(error);
    return reply.status(500).send({ error: 'Internal server error' });
  });

  const origins = config.CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: config.CORS_ORIGIN === '*' ? true : origins,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    credentials: true
  });

  await app.register(rateLimit, {
    max: 80,
    timeWindow: '1 minute',
    redis,
    keyGenerator: req => req.userToken || req.ip
  });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

  app.addHook('preHandler', async (req, reply) => {
    const publicRoutes = req.url === '/health' || req.url === '/api/session';
    if (publicRoutes) {
      req.userToken = 'public';
      return;
    }
    const token = req.headers['x-sm-token'];
    const verified = verifySessionToken(Array.isArray(token) ? token[0] : token);
    if (!verified) return reply.status(401).send({ error: 'Missing or invalid session token' });
    req.userToken = verified;
  });

  const io = new Server(app.server, {
    cors: { origin: config.CORS_ORIGIN === '*' ? true : origins, credentials: true },
    transports: ['websocket', 'polling'],
    maxHttpBufferSize: 1e6
  });
  io.adapter(createAdapter(redis, redisSub));

  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));
  app.post('/api/session', async () => ({ token: issueSessionToken() }));

  app.get('/api/signals', { config: { rateLimit: { max: 160, timeWindow: '1 minute' } } }, async (req, reply) => {
    const query = bboxSchema.parse(req.query);
    const categories = parseCategories(query.categories);
    const version = await getCacheVersion();
    const catKey = categories?.length ? categories.sort().join('.') : 'all';
    const cacheKey = `bbox:v${version}:${query.sw_lat.toFixed(3)},${query.sw_lng.toFixed(3)},${query.ne_lat.toFixed(3)},${query.ne_lng.toFixed(3)}:${catKey}`;
    const cached = await redis.get(cacheKey);
    if (cached) return reply.header('X-Cache', 'HIT').send(JSON.parse(cached));

    const signals = await getSignalsInBbox(query.sw_lat, query.sw_lng, query.ne_lat, query.ne_lng, categories);
    const featureCollection = { type: 'FeatureCollection', features: signals.map(toFeature) };
    await redis.setEx(cacheKey, 5, JSON.stringify(featureCollection));
    return reply.header('X-Cache', 'MISS').send(featureCollection);
  });

  app.get('/api/signals/:id', async (req, reply) => {
    const { id } = idSchema.parse(req.params);
    const { rows } = await db.query<SignalRow>(`
      SELECT id, category, ST_Y(location) AS lat, ST_X(location) AS lng,
             description, image_url, reporter_token, trust_score,
             confirmation_count, freshness, trust_state, is_active,
             created_at, expires_at, updated_at
      FROM signals WHERE id = $1
    `, [id]);
    if (!rows.length) return reply.status(404).send({ error: 'Signal not found' });
    return toFeature(rows[0]);
  });

  app.post('/api/signals', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const body = createSignalSchema.parse(req.body);
    if (await checkDuplicate(body.category, body.lat, body.lng)) {
      return reply.status(409).send({ error: 'Similar signal already exists nearby' });
    }
    const sig = await createSignalDB({
      category: body.category,
      lat: body.lat,
      lng: body.lng,
      description: body.description,
      imageUrl: body.image_url,
      reporterToken: req.userToken
    });
    const feature = toFeature(sig);
    emitToNearbyCells(io, body.lat, body.lng, 'signal:created', { feature });
    await bumpCacheVersion();
    return reply.status(201).send(feature);
  });

  app.post('/api/signals/:id/confirm', { config: { rateLimit: { max: 30, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { id } = idSchema.parse(req.params);
    const updated = await addConfirmation(id, req.userToken);
    if (!updated) return reply.status(400).send({ error: 'Already confirmed, own signal, or signal not found' });
    emitToNearbyCells(io, updated.lat, updated.lng, 'signal:updated', {
      id: updated.id,
      trust_score: updated.trust_score,
      confirmation_count: updated.confirmation_count,
      freshness: updated.freshness,
      trust_state: updated.trust_state
    });
    await bumpCacheVersion();
    return { ok: true, trust_score: updated.trust_score };
  });

  app.post('/api/signals/:id/flag', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const { id } = idSchema.parse(req.params);
    const { reason } = flagSchema.parse(req.body ?? {});
    const ok = await flagSignal(id, req.userToken, reason);
    if (!ok) return reply.status(400).send({ error: 'Already flagged or signal not found' });
    await bumpCacheVersion();
    return { ok: true };
  });

  app.post('/api/upload/presign', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (_req, reply) => {
    if (!config.S3_BUCKET) return reply.status(503).send({ error: 'Image uploads not configured' });
    const s3 = new S3Client({ region: config.S3_REGION });
    const key = `signals/${crypto.randomUUID()}.jpg`;
    const url = await getSignedUrl(s3, new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      ContentType: 'image/jpeg'
    }), { expiresIn: 300 });
    return { url, key, public_url: `https://${config.S3_BUCKET}.s3.${config.S3_REGION}.amazonaws.com/${key}` };
  });

  app.get('/api/stats', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async () => {
    const [{ rows: totals }, { rows: byCategory }, activeUsers] = await Promise.all([
      db.query(`
        SELECT COUNT(*) FILTER (WHERE is_active)::int AS active_signals,
               COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS last_hour,
               COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_day
        FROM signals
      `),
      db.query(`
        SELECT category, COUNT(*)::int AS count
        FROM signals
        WHERE created_at > NOW() - INTERVAL '24 hours'
        GROUP BY category
        ORDER BY count DESC
      `),
      redis.get('stats:active_users')
    ]);
    return {
      active_signals: totals[0]?.active_signals ?? 0,
      last_hour: totals[0]?.last_hour ?? 0,
      last_day: totals[0]?.last_day ?? 0,
      by_category: byCategory,
      active_users: Number(activeUsers ?? 0)
    };
  });

  const viewportRooms = new Map<string, string[]>();
  let connectedCount = 0;

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.headers['x-sm-token'];
    const verified = verifySessionToken(Array.isArray(token) ? token[0] : token);
    if (!verified) return next(new Error('invalid session token'));
    socket.data.userToken = verified;
    next();
  });

  io.on('connection', socket => {
    connectedCount++;
    redis.set('stats:active_users', connectedCount, { EX: 300 }).catch(() => undefined);

    socket.on('viewport:update', async payload => {
      try {
        const parsed = z.object({
          sw: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
          ne: z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }),
          zoom: z.number().min(0).max(24).optional(),
          categories: z.array(z.enum(SIGNAL_CATEGORIES)).optional()
        }).parse(payload);

        const newCells = getViewportCells(parsed.sw.lat, parsed.sw.lng, parsed.ne.lat, parsed.ne.lng, parsed.zoom);
        const oldCells = viewportRooms.get(socket.id) ?? [];
        for (const c of oldCells) if (!newCells.includes(c)) await socket.leave(c);
        for (const c of newCells) if (!oldCells.includes(c)) await socket.join(c);
        viewportRooms.set(socket.id, newCells);

        const signals = await getSignalsInBbox(parsed.sw.lat, parsed.sw.lng, parsed.ne.lat, parsed.ne.lng, parsed.categories);
        socket.emit('signals:init', { type: 'FeatureCollection', features: signals.map(toFeature) });
      } catch {
        socket.emit('error', { message: 'Failed to update viewport' });
      }
    });

    socket.on('disconnect', () => {
      connectedCount = Math.max(0, connectedCount - 1);
      viewportRooms.delete(socket.id);
      redis.set('stats:active_users', connectedCount, { EX: 300 }).catch(() => undefined);
    });
  });

  cron.schedule('* * * * *', async () => {
    try { await runDecayCycle(io); } catch (err) { app.log.error({ err }, 'decay cron failed'); }
  });

  cron.schedule('*/5 * * * *', async () => {
    try { await updateReporterScores(); } catch (err) { app.log.error({ err }, 'reporter score cron failed'); }
  });

  return { app, io };
}

async function main() {
  const { app } = await buildApp();
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  app.log.info(`SignalMap API running on port ${config.PORT}`);
}

if (process.env.NODE_ENV !== 'test') {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

export { buildApp, db, redis };
