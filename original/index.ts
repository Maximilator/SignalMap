import Fastify from 'fastify';
import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { Pool } from 'pg';
import * as h3 from 'h3-js';
import crypto from 'crypto';
import cron from 'node-cron';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// ════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════

const config = {
  port: parseInt(process.env.PORT || '3001'),
  dbUrl: process.env.DATABASE_URL!,
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  jwtSecret: process.env.JWT_SECRET || 'change-me-in-production',
  fingerprintSalt: process.env.FINGERPRINT_SALT || 'salt-change-me',
  s3Bucket: process.env.S3_BUCKET || '',
  s3Region: process.env.S3_REGION || 'eu-west-1',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  maxSignalsPerBbox: parseInt(process.env.MAX_SIGNALS_PER_BBOX || '500'),
  h3Resolution: 5,
  signalCreateLimit: parseInt(process.env.SIGNAL_CREATION_RATE_LIMIT || '5'),
  nodeEnv: process.env.NODE_ENV || 'development',
};

// ════════════════════════════════════════════
// TYPES
// ════════════════════════════════════════════

type SignalCategory =
  | 'police_patrol' | 'foot_patrol' | 'bicycle_patrol'
  | 'road_check' | 'incident' | 'protest'
  | 'public_action' | 'temp_restriction'
  | 'emergency' | 'unusual_activity';

type TrustState = 'ghost' | 'low' | 'medium' | 'high' | 'verified';

interface Signal {
  id: string;
  category: SignalCategory;
  lat: number;
  lng: number;
  description?: string;
  image_url?: string;
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

interface SignalFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    id: string;
    category: SignalCategory;
    trust: number;
    freshness: number;
    color: string;
    confirmation_count: number;
    age_minutes: number;
    trust_state: TrustState;
    description?: string;
  };
}

// ════════════════════════════════════════════
// CATEGORY CONFIG
// ════════════════════════════════════════════

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
  unusual_activity: '#94a3b8',
};

const CATEGORY_TTL_MINUTES: Record<SignalCategory, number> = {
  police_patrol: 45, foot_patrol: 40, bicycle_patrol: 40,
  road_check: 60, incident: 30, protest: 180,
  public_action: 60, temp_restriction: 240,
  emergency: 120, unusual_activity: 20,
};

const DECAY_RATES: Record<SignalCategory, number> = {
  police_patrol: 0.020, foot_patrol: 0.022, bicycle_patrol: 0.022,
  road_check: 0.015, incident: 0.035, protest: 0.008,
  public_action: 0.018, temp_restriction: 0.006,
  emergency: 0.010, unusual_activity: 0.040,
};

const SIGNAL_CATEGORIES = Object.keys(CATEGORY_TTL_MINUTES) as SignalCategory[];

// ════════════════════════════════════════════
// TRUST SYSTEM
// ════════════════════════════════════════════

function computeTrustScore(
  confirmCount: number,
  category: SignalCategory,
  createdAt: Date,
  reporterScore: number = 50,
  nearbyCount: number = 0
): { score: number; freshness: number; state: TrustState } {
  const ageMinutes = (Date.now() - createdAt.getTime()) / 60000;
  const lambda = DECAY_RATES[category] ?? 0.02;
  const freshness = Math.exp(-lambda * ageMinutes);

  const base = Math.min(confirmCount * 8, 60) + 8;
  const reporterWeight = Math.min(1.0, 0.5 + reporterScore / 200);
  const densityBonus = 1.0 + Math.min(0.3, nearbyCount * 0.05);

  const score = Math.min(100, Math.round(base * freshness * reporterWeight * densityBonus));

  let state: TrustState = 'ghost';
  if (score > 10) state = 'low';
  if (score > 25) state = 'medium';
  if (score > 55) state = 'high';
  if (score > 80) state = 'verified';

  return { score, freshness: Math.max(0, freshness), state };
}

// ════════════════════════════════════════════
// DATABASE
// ════════════════════════════════════════════

const db = new Pool({ connectionString: config.dbUrl, max: 20 });

async function initDB() {
  await db.query(`
    CREATE EXTENSION IF NOT EXISTS postgis;
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TYPE IF NOT EXISTS signal_category AS ENUM (
      'police_patrol','foot_patrol','bicycle_patrol','road_check',
      'incident','protest','public_action','temp_restriction',
      'emergency','unusual_activity'
    );

    CREATE TABLE IF NOT EXISTS signals (
      id              UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
      category        signal_category NOT NULL,
      location        GEOMETRY(Point, 4326) NOT NULL,
      description     TEXT,
      image_url       TEXT,
      reporter_token  TEXT            NOT NULL,
      trust_score     SMALLINT        NOT NULL DEFAULT 8,
      confirmation_count INT          NOT NULL DEFAULT 0,
      freshness       DECIMAL(6,5)    NOT NULL DEFAULT 1.0,
      trust_state     TEXT            NOT NULL DEFAULT 'ghost',
      is_active       BOOLEAN         NOT NULL DEFAULT TRUE,
      created_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
      expires_at      TIMESTAMPTZ     NOT NULL,
      updated_at      TIMESTAMPTZ     NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_signals_location ON signals USING GIST(location);
    CREATE INDEX IF NOT EXISTS idx_signals_active ON signals(created_at DESC) WHERE is_active = TRUE;
    CREATE INDEX IF NOT EXISTS idx_signals_expires ON signals(expires_at) WHERE is_active = TRUE;

    CREATE TABLE IF NOT EXISTS confirmations (
      id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
      signal_id    UUID        NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
      user_token   TEXT        NOT NULL,
      confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(signal_id, user_token)
    );

    CREATE INDEX IF NOT EXISTS idx_confirmations_signal ON confirmations(signal_id);

    CREATE TABLE IF NOT EXISTS reporter_scores (
      token              TEXT        PRIMARY KEY,
      total_signals      INT         NOT NULL DEFAULT 0,
      confirmed_signals  INT         NOT NULL DEFAULT 0,
      score              SMALLINT    NOT NULL DEFAULT 50,
      flagged_count      INT         NOT NULL DEFAULT 0,
      last_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS signals_archive (
      LIKE signals INCLUDING ALL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

// ════════════════════════════════════════════
// REPOSITORIES
// ════════════════════════════════════════════

async function getSignalsInBbox(
  swLat: number, swLng: number, neLat: number, neLng: number,
  categories?: SignalCategory[]
): Promise<Signal[]> {
  const catFilter = categories && categories.length < SIGNAL_CATEGORIES.length
    ? `AND category = ANY($5::text[])`
    : '';

  const params: unknown[] = [swLng, swLat, neLng, neLat];
  if (catFilter) params.push(categories);

  const { rows } = await db.query(`
    SELECT
      id, category,
      ST_Y(location) AS lat, ST_X(location) AS lng,
      description, image_url, reporter_token,
      trust_score, confirmation_count, freshness, trust_state,
      is_active, created_at, expires_at, updated_at
    FROM signals
    WHERE is_active = TRUE
      AND location && ST_MakeEnvelope($1, $2, $3, $4, 4326)
      ${catFilter}
    ORDER BY trust_score DESC
    LIMIT ${config.maxSignalsPerBbox}
  `, params);

  return rows;
}

async function createSignalDB(data: {
  category: SignalCategory;
  lat: number;
  lng: number;
  description?: string;
  imageUrl?: string;
  reporterToken: string;
}): Promise<Signal> {
  const ttlMin = CATEGORY_TTL_MINUTES[data.category];
  const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);

  const { rows } = await db.query(`
    INSERT INTO signals (category, location, description, image_url, reporter_token, expires_at)
    VALUES ($1, ST_SetSRID(ST_MakePoint($3, $2), 4326), $4, $5, $6, $7)
    RETURNING
      id, category,
      ST_Y(location) AS lat, ST_X(location) AS lng,
      description, image_url, reporter_token,
      trust_score, confirmation_count, freshness, trust_state,
      is_active, created_at, expires_at, updated_at
  `, [data.category, data.lat, data.lng, data.description || null, data.imageUrl || null, data.reporterToken, expiresAt]);

  // Update reporter score
  await db.query(`
    INSERT INTO reporter_scores (token, total_signals)
    VALUES ($1, 1)
    ON CONFLICT (token) DO UPDATE
    SET total_signals = reporter_scores.total_signals + 1, last_seen = NOW()
  `, [data.reporterToken]);

  return rows[0];
}

async function addConfirmation(signalId: string, userToken: string): Promise<Signal | null> {
  // Check user hasn't already confirmed
  const existing = await db.query(
    'SELECT id FROM confirmations WHERE signal_id = $1 AND user_token = $2',
    [signalId, userToken]
  );
  if (existing.rows.length > 0) return null; // Already confirmed

  // Get signal
  const { rows: sigRows } = await db.query(
    'SELECT * FROM signals WHERE id = $1 AND is_active = TRUE',
    [signalId]
  );
  if (!sigRows.length) return null;

  const sig = sigRows[0];

  // Check not confirming own signal
  if (sig.reporter_token === userToken) return null;

  // Add confirmation
  await db.query(
    'INSERT INTO confirmations (signal_id, user_token) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [signalId, userToken]
  );

  // Get nearby signal count for density bonus
  const { rows: nearbyRows } = await db.query(`
    SELECT COUNT(*) AS cnt FROM signals
    WHERE is_active = TRUE AND id != $1
      AND ST_DWithin(location, (SELECT location FROM signals WHERE id = $1), 0.005)
  `, [signalId]);
  const nearbyCount = parseInt(nearbyRows[0]?.cnt || '0');

  // Get reporter score
  const { rows: repRows } = await db.query(
    'SELECT score FROM reporter_scores WHERE token = $1',
    [sig.reporter_token]
  );
  const reporterScore = repRows[0]?.score || 50;

  // Recalculate trust
  const newConfirmCount = sig.confirmation_count + 1;
  const { score, freshness, state } = computeTrustScore(
    newConfirmCount, sig.category, sig.created_at, reporterScore, nearbyCount
  );

  // Update signal
  const { rows: updated } = await db.query(`
    UPDATE signals SET
      confirmation_count = $2,
      trust_score = $3,
      freshness = $4,
      trust_state = $5,
      updated_at = NOW()
    WHERE id = $1
    RETURNING *,
      ST_Y(location) AS lat, ST_X(location) AS lng
  `, [signalId, newConfirmCount, score, freshness, state]);

  // Update reporter confirmed count
  await db.query(`
    INSERT INTO reporter_scores (token, confirmed_signals)
    VALUES ($1, 1)
    ON CONFLICT (token) DO UPDATE
    SET confirmed_signals = reporter_scores.confirmed_signals + 1, last_seen = NOW()
  `, [sig.reporter_token]);

  return updated[0] || null;
}

async function getReporterScore(token: string): Promise<number> {
  const { rows } = await db.query('SELECT score FROM reporter_scores WHERE token = $1', [token]);
  return rows[0]?.score ?? 50;
}

// ════════════════════════════════════════════
// SIGNAL → GEOJSON FEATURE
// ════════════════════════════════════════════

function toFeature(sig: Signal): SignalFeature {
  const ageMinutes = (Date.now() - new Date(sig.created_at).getTime()) / 60000;
  return {
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [sig.lng, sig.lat] },
    properties: {
      id: sig.id,
      category: sig.category,
      trust: sig.trust_score,
      freshness: sig.freshness,
      color: CATEGORY_COLORS[sig.category],
      confirmation_count: sig.confirmation_count,
      age_minutes: Math.round(ageMinutes),
      trust_state: sig.trust_state,
      description: sig.description,
    },
  };
}

// ════════════════════════════════════════════
// ANTI-SPAM
// ════════════════════════════════════════════

async function checkDuplicate(category: SignalCategory, lat: number, lng: number): Promise<boolean> {
  const { rows } = await db.query(`
    SELECT id FROM signals
    WHERE is_active = TRUE
      AND category = $1
      AND ST_DWithin(
        location,
        ST_SetSRID(ST_MakePoint($3, $2), 4326),
        0.001  -- ~100m in degrees
      )
      AND created_at > NOW() - INTERVAL '10 minutes'
    LIMIT 1
  `, [category, lat, lng]);
  return rows.length > 0;
}

// ════════════════════════════════════════════
// FINGERPRINT HASHING
// ════════════════════════════════════════════

function hashToken(rawToken: string): string {
  return crypto
    .createHmac('sha256', config.fingerprintSalt)
    .update(rawToken)
    .digest('hex')
    .slice(0, 32);
}

// ════════════════════════════════════════════
// VALIDATION SCHEMAS
// ════════════════════════════════════════════

const createSignalSchema = z.object({
  category: z.enum(SIGNAL_CATEGORIES as [SignalCategory, ...SignalCategory[]]),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  description: z.string().max(280).optional(),
  image_url: z.string().url().optional(),
});

const bboxSchema = z.object({
  sw_lat: z.coerce.number().min(-90).max(90),
  sw_lng: z.coerce.number().min(-180).max(180),
  ne_lat: z.coerce.number().min(-90).max(90),
  ne_lng: z.coerce.number().min(-180).max(180),
  categories: z.string().optional(),
});

// ════════════════════════════════════════════
// FASTIFY APP
// ════════════════════════════════════════════

const app = Fastify({
  logger: config.nodeEnv !== 'test',
  trustProxy: true,
});

// CORS
await app.register(cors, {
  origin: config.corsOrigin === '*' ? true : config.corsOrigin,
  methods: ['GET', 'POST', 'DELETE'],
});

// Rate limiting (global)
await app.register(rateLimit, {
  max: 60,
  timeWindow: '1 minute',
  redis: createClient({ url: config.redisUrl }),
  keyGenerator: (req) => req.headers['x-forwarded-for'] as string || req.ip,
});

// Multipart (for image uploads)
await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });

// ════════════════════════════════════════════
// MIDDLEWARE: FINGERPRINT
// ════════════════════════════════════════════

app.addHook('preHandler', async (req: any) => {
  const rawToken = (req.headers['x-sm-token'] as string) || req.ip;
  req.userToken = hashToken(rawToken);
});

// ════════════════════════════════════════════
// ROUTES
// ════════════════════════════════════════════

// Health
app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

// Get signals in bounding box
app.get('/api/signals', {
  config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
}, async (req: any, reply) => {
  const query = bboxSchema.parse(req.query);
  const cacheKey = `bbox:${query.sw_lat.toFixed(3)},${query.sw_lng.toFixed(3)},${query.ne_lat.toFixed(3)},${query.ne_lng.toFixed(3)}`;

  // Try cache
  const cached = await redis.get(cacheKey);
  if (cached) {
    return reply.header('X-Cache', 'HIT').send(JSON.parse(cached));
  }

  const categories = query.categories
    ? (query.categories.split(',') as SignalCategory[])
    : undefined;

  const signals = await getSignalsInBbox(
    query.sw_lat, query.sw_lng, query.ne_lat, query.ne_lng, categories
  );

  const featureCollection = {
    type: 'FeatureCollection',
    features: signals.map(toFeature),
  };

  // Cache for 5 seconds
  await redis.setEx(cacheKey, 5, JSON.stringify(featureCollection));

  return featureCollection;
});

// Get single signal
app.get('/api/signals/:id', async (req: any, reply) => {
  const { rows } = await db.query(`
    SELECT *, ST_Y(location) AS lat, ST_X(location) AS lng
    FROM signals WHERE id = $1
  `, [req.params.id]);

  if (!rows.length) return reply.status(404).send({ error: 'Signal not found' });
  return toFeature(rows[0]);
});

// Create signal
app.post('/api/signals', {
  config: { rateLimit: { max: 5, timeWindow: '10 minutes' } },
}, async (req: any, reply) => {
  const body = createSignalSchema.parse(req.body);

  // Duplicate check
  const isDuplicate = await checkDuplicate(body.category, body.lat, body.lng);
  if (isDuplicate) {
    return reply.status(409).send({ error: 'Similar signal already exists nearby' });
  }

  const sig = await createSignalDB({
    category: body.category,
    lat: body.lat,
    lng: body.lng,
    description: body.description,
    imageUrl: body.image_url,
    reporterToken: req.userToken,
  });

  // Broadcast via Socket.IO to H3 cells
  const cell = h3.latLngToCell(body.lat, body.lng, config.h3Resolution);
  const neighborCells = h3.gridDisk(cell, 1);
  neighborCells.forEach(c => io.to(c).emit('signal:created', { feature: toFeature(sig) }));

  // Invalidate nearby bbox caches
  await redis.del(`bbox:*`);

  return reply.status(201).send(toFeature(sig));
});

// Confirm signal
app.post('/api/signals/:id/confirm', {
  config: { rateLimit: { max: 30, timeWindow: '10 minutes' } },
}, async (req: any, reply) => {
  const updated = await addConfirmation(req.params.id, req.userToken);

  if (!updated) {
    return reply.status(400).send({ error: 'Already confirmed or signal not found' });
  }

  // Broadcast update
  const cell = h3.latLngToCell(updated.lat, updated.lng, config.h3Resolution);
  const neighborCells = h3.gridDisk(cell, 1);
  neighborCells.forEach(c => io.to(c).emit('signal:updated', {
    id: updated.id,
    trust_score: updated.trust_score,
    confirmation_count: updated.confirmation_count,
    freshness: updated.freshness,
    trust_state: updated.trust_state,
  }));

  return { ok: true, trust_score: updated.trust_score };
});

// Pre-signed S3 upload URL
app.post('/api/upload/presign', {
  config: { rateLimit: { max: 10, timeWindow: '10 minutes' } },
}, async (req: any, reply) => {
  if (!config.s3Bucket) return reply.status(503).send({ error: 'Image uploads not configured' });

  const s3 = new S3Client({ region: config.s3Region });
  const key = `signals/${req.userToken}/${Date.now()}.jpg`;
  const url = await getSignedUrl(s3, new PutObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
    ContentType: 'image/jpeg',
    ContentLength: 5 * 1024 * 1024,
  }), { expiresIn: 300 });

  return { url, key, public_url: `https://${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com/${key}` };
});

// Stats endpoint
app.get('/api/stats', {
  config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
}, async () => {
  const { rows } = await db.query(`
    SELECT
      COUNT(*) FILTER (WHERE is_active) AS active_signals,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS last_hour,
      COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_day,
      category,
      COUNT(*) AS count
    FROM signals
    WHERE created_at > NOW() - INTERVAL '24 hours'
    GROUP BY category
    ORDER BY count DESC
  `);

  const cached = await redis.get('stats:active_users');
  return {
    active_signals: rows[0]?.active_signals || 0,
    last_hour: rows[0]?.last_hour || 0,
    last_day: rows[0]?.last_day || 0,
    by_category: rows.map(r => ({ category: r.category, count: parseInt(r.count) })),
    active_users: parseInt(cached || '0'),
  };
});

// ════════════════════════════════════════════
// REDIS
// ════════════════════════════════════════════

const redis = createClient({ url: config.redisUrl });
const redisSub = redis.duplicate();

await redis.connect();
await redisSub.connect();

// ════════════════════════════════════════════
// SOCKET.IO GATEWAY
// ════════════════════════════════════════════

const io = new Server(app.server, {
  cors: { origin: config.corsOrigin === '*' ? true : config.corsOrigin },
  transports: ['websocket', 'polling'],
});

// Redis adapter for multi-process
io.adapter(createAdapter(redis, redisSub));

// Track viewport rooms per socket
const viewportRooms = new Map<string, string[]>();
let connectedCount = 0;

function getViewportCells(swLat: number, swLng: number, neLat: number, neLng: number): string[] {
  try {
    // Sample points within bbox to find covering H3 cells
    const cells = new Set<string>();
    const latStep = (neLat - swLat) / 3;
    const lngStep = (neLng - swLng) / 3;

    for (let i = 0; i <= 3; i++) {
      for (let j = 0; j <= 3; j++) {
        const lat = swLat + i * latStep;
        const lng = swLng + j * lngStep;
        cells.add(h3.latLngToCell(lat, lng, config.h3Resolution));
      }
    }

    return [...cells];
  } catch {
    return [];
  }
}

io.on('connection', (socket) => {
  connectedCount++;
  redis.set('stats:active_users', connectedCount, { EX: 300 });

  socket.on('viewport:update', async ({ sw, ne, zoom }) => {
    try {
      const newCells = getViewportCells(sw.lat, sw.lng, ne.lat, ne.lng);
      const oldCells = viewportRooms.get(socket.id) || [];

      // Leave old rooms
      for (const cell of oldCells) {
        if (!newCells.includes(cell)) socket.leave(cell);
      }

      // Join new rooms
      for (const cell of newCells) {
        if (!oldCells.includes(cell)) socket.join(cell);
      }

      viewportRooms.set(socket.id, newCells);

      // Send current signals in viewport
      const signals = await getSignalsInBbox(sw.lat, sw.lng, ne.lat, ne.lng);
      socket.emit('signals:init', {
        type: 'FeatureCollection',
        features: signals.map(toFeature),
      });
    } catch (err) {
      socket.emit('error', { message: 'Failed to update viewport' });
    }
  });

  socket.on('disconnect', () => {
    connectedCount = Math.max(0, connectedCount - 1);
    viewportRooms.delete(socket.id);
    redis.set('stats:active_users', connectedCount, { EX: 300 });
  });

  socket.on('ping', () => socket.emit('pong', { time: Date.now() }));
});

// ════════════════════════════════════════════
// DECAY CRON (runs every 60 seconds)
// ════════════════════════════════════════════

cron.schedule('* * * * *', async () => {
  try {
    // Get all active signals that need trust recalculation
    const { rows: activeSignals } = await db.query(`
      SELECT id, category, confirmation_count, created_at, reporter_token,
             ST_Y(location) AS lat, ST_X(location) AS lng
      FROM signals
      WHERE is_active = TRUE
    `);

    const updates: { id: string; score: number; freshness: number; state: TrustState; lat: number; lng: number }[] = [];
    const expiredIds: string[] = [];

    for (const sig of activeSignals) {
      const { score, freshness, state } = computeTrustScore(
        sig.confirmation_count, sig.category, sig.created_at
      );

      if (freshness < 0.02) {
        expiredIds.push(sig.id);
      } else {
        updates.push({ id: sig.id, score, freshness, state, lat: sig.lat, lng: sig.lng });
      }
    }

    // Batch update trust scores
    if (updates.length > 0) {
      await db.query(`
        UPDATE signals SET
          trust_score = u.score,
          freshness = u.freshness,
          trust_state = u.state,
          updated_at = NOW()
        FROM (
          SELECT UNNEST($1::uuid[]) AS id,
                 UNNEST($2::int[]) AS score,
                 UNNEST($3::float[]) AS freshness,
                 UNNEST($4::text[]) AS state
        ) AS u
        WHERE signals.id = u.id
      `, [
        updates.map(u => u.id),
        updates.map(u => u.score),
        updates.map(u => u.freshness),
        updates.map(u => u.state),
      ]);

      // Broadcast trust updates
      for (const u of updates) {
        const cell = h3.latLngToCell(u.lat, u.lng, config.h3Resolution);
        io.to(cell).emit('signal:updated', {
          id: u.id, trust_score: u.score, freshness: u.freshness, trust_state: u.state,
        });
      }
    }

    // Mark expired
    if (expiredIds.length > 0) {
      await db.query(
        'UPDATE signals SET is_active = FALSE, updated_at = NOW() WHERE id = ANY($1::uuid[])',
        [expiredIds]
      );

      // Broadcast expirations (get cells first)
      for (const id of expiredIds) {
        const { rows } = await db.query(`
          SELECT ST_Y(location) AS lat, ST_X(location) AS lng FROM signals WHERE id = $1
        `, [id]);
        if (rows[0]) {
          const cell = h3.latLngToCell(rows[0].lat, rows[0].lng, config.h3Resolution);
          io.to(cell).emit('signal:expired', { id });
        }
      }
    }

    // Archive old inactive signals (> 7 days)
    await db.query(`
      INSERT INTO signals_archive SELECT *, NOW() FROM signals
      WHERE is_active = FALSE AND created_at < NOW() - INTERVAL '7 days'
      ON CONFLICT DO NOTHING
    `);
    await db.query(
      'DELETE FROM signals WHERE is_active = FALSE AND created_at < NOW() - INTERVAL \'7 days\''
    );

  } catch (err) {
    console.error('Decay cron error:', err);
  }
});

// ════════════════════════════════════════════
// REPORTER SCORE UPDATE (runs every 5 mins)
// ════════════════════════════════════════════

cron.schedule('*/5 * * * *', async () => {
  try {
    await db.query(`
      UPDATE reporter_scores SET
        score = LEAST(100, GREATEST(0,
          CASE
            WHEN total_signals = 0 THEN 50
            ELSE (50 + (confirmed_signals::float / total_signals * 50))::int
          END - flagged_count * 10
        ))
    `);
  } catch (err) {
    console.error('Score update error:', err);
  }
});

// ════════════════════════════════════════════
// START
// ════════════════════════════════════════════

async function start() {
  try {
    await initDB();
    await app.listen({ port: config.port, host: '0.0.0.0' });
    console.log(`🟢 SignalMap server running on port ${config.port}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

start();

export { app, io };
