-- ════════════════════════════════════════════════
-- SignalMap — Complete Database Schema
-- PostgreSQL 16 + PostGIS 3.4
-- ════════════════════════════════════════════════

-- Extensions
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ════════════════════════════════════════════════
-- ENUMS
-- ════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE signal_category AS ENUM (
    'police_patrol', 'foot_patrol', 'bicycle_patrol',
    'road_check', 'incident', 'protest',
    'public_action', 'temp_restriction',
    'emergency', 'unusual_activity'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE trust_state AS ENUM ('ghost', 'low', 'medium', 'high', 'verified');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ════════════════════════════════════════════════
-- SIGNALS TABLE
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS signals (
  id                UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  category          signal_category NOT NULL,
  location          GEOMETRY(Point, 4326) NOT NULL,
  description       TEXT          CHECK (char_length(description) <= 280),
  image_url         TEXT,
  reporter_token    TEXT          NOT NULL,
  trust_score       SMALLINT      NOT NULL DEFAULT 8 CHECK (trust_score >= 0 AND trust_score <= 100),
  confirmation_count INTEGER      NOT NULL DEFAULT 0 CHECK (confirmation_count >= 0),
  freshness         DECIMAL(6,5)  NOT NULL DEFAULT 1.0,
  trust_state       TEXT          NOT NULL DEFAULT 'ghost',
  is_active         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ   NOT NULL,
  updated_at        TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- Primary spatial index
CREATE INDEX IF NOT EXISTS idx_signals_location
  ON signals USING GIST(location);

-- Partial index: only active signals (most queries filter by is_active)
CREATE INDEX IF NOT EXISTS idx_signals_active_created
  ON signals(created_at DESC)
  WHERE is_active = TRUE;

-- For decay job: find signals close to expiry
CREATE INDEX IF NOT EXISTS idx_signals_expires_active
  ON signals(expires_at ASC)
  WHERE is_active = TRUE;

-- For trust filtering
CREATE INDEX IF NOT EXISTS idx_signals_trust
  ON signals(trust_score DESC)
  WHERE is_active = TRUE;

-- Reporter token index (for spam checks)
CREATE INDEX IF NOT EXISTS idx_signals_reporter
  ON signals(reporter_token, created_at DESC)
  WHERE is_active = TRUE;

-- Composite spatial + active (used in most bbox queries)
CREATE INDEX IF NOT EXISTS idx_signals_location_active
  ON signals USING GIST(location)
  WHERE is_active = TRUE;

-- ════════════════════════════════════════════════
-- CONFIRMATIONS TABLE
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS confirmations (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id    UUID        NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  user_token   TEXT        NOT NULL,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_confirmation UNIQUE(signal_id, user_token)
);

CREATE INDEX IF NOT EXISTS idx_confirmations_signal
  ON confirmations(signal_id);

CREATE INDEX IF NOT EXISTS idx_confirmations_user
  ON confirmations(user_token, confirmed_at DESC);

-- ════════════════════════════════════════════════
-- REPORTER SCORES TABLE
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS reporter_scores (
  token              TEXT        PRIMARY KEY,
  total_signals      INTEGER     NOT NULL DEFAULT 0,
  confirmed_signals  INTEGER     NOT NULL DEFAULT 0,
  flagged_count      INTEGER     NOT NULL DEFAULT 0,
  score              SMALLINT    NOT NULL DEFAULT 50 CHECK (score >= 0 AND score <= 100),
  is_banned          BOOLEAN     NOT NULL DEFAULT FALSE,
  last_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reporter_score ON reporter_scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_reporter_banned ON reporter_scores(is_banned) WHERE is_banned = TRUE;

-- ════════════════════════════════════════════════
-- SIGNAL FLAGS (abuse reports)
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS signal_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id   UUID        NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  user_token  TEXT        NOT NULL,
  reason      TEXT        CHECK (char_length(reason) <= 140),
  flagged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_flag UNIQUE(signal_id, user_token)
);

CREATE INDEX IF NOT EXISTS idx_flags_signal ON signal_flags(signal_id);

-- ════════════════════════════════════════════════
-- ARCHIVE TABLE
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS signals_archive (
  LIKE signals INCLUDING ALL,
  final_trust_score   SMALLINT,
  final_confirm_count INTEGER,
  archived_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ════════════════════════════════════════════════
-- RATE LIMIT TRACKING (fallback without Redis)
-- ════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS rate_limits (
  key         TEXT        NOT NULL,
  action      TEXT        NOT NULL,
  count       INTEGER     NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, action)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

-- ════════════════════════════════════════════════
-- USEFUL VIEWS
-- ════════════════════════════════════════════════

CREATE OR REPLACE VIEW active_signals_view AS
SELECT
  s.id,
  s.category,
  ST_Y(s.location) AS lat,
  ST_X(s.location) AS lng,
  s.description,
  s.image_url,
  s.trust_score,
  s.confirmation_count,
  s.freshness,
  s.trust_state,
  s.created_at,
  s.expires_at,
  EXTRACT(EPOCH FROM (NOW() - s.created_at)) / 60 AS age_minutes,
  EXTRACT(EPOCH FROM (s.expires_at - NOW())) / 60 AS ttl_remaining_minutes,
  rs.score AS reporter_score
FROM signals s
LEFT JOIN reporter_scores rs ON rs.token = s.reporter_token
WHERE s.is_active = TRUE
ORDER BY s.trust_score DESC;

CREATE OR REPLACE VIEW signal_stats_view AS
SELECT
  category,
  COUNT(*) FILTER (WHERE is_active) AS active_count,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour') AS last_hour,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours') AS last_day,
  AVG(trust_score) FILTER (WHERE is_active) AS avg_trust,
  SUM(confirmation_count) FILTER (WHERE is_active) AS total_confirmations
FROM signals
GROUP BY category
ORDER BY active_count DESC;

-- ════════════════════════════════════════════════
-- KEY QUERIES (documented for reference)
-- ════════════════════════════════════════════════

-- Bbox query (main map load):
-- SELECT id, category, ST_Y(location) AS lat, ST_X(location) AS lng,
--   description, trust_score, confirmation_count, freshness, trust_state, created_at
-- FROM signals
-- WHERE is_active = TRUE
--   AND location && ST_MakeEnvelope($sw_lng, $sw_lat, $ne_lng, $ne_lat, 4326)
-- ORDER BY trust_score DESC
-- LIMIT 500;

-- Nearby signals for density bonus:
-- SELECT COUNT(*) FROM signals
-- WHERE is_active = TRUE AND id != $signal_id
--   AND ST_DWithin(location,
--     (SELECT location FROM signals WHERE id = $signal_id),
--     0.005);  -- ~500m

-- Duplicate check:
-- SELECT id FROM signals
-- WHERE is_active = TRUE AND category = $category
--   AND ST_DWithin(location, ST_SetSRID(ST_MakePoint($lng, $lat), 4326), 0.001)
--   AND created_at > NOW() - INTERVAL '10 minutes'
-- LIMIT 1;

-- Decay update (batch):
-- UPDATE signals SET trust_score = u.score, freshness = u.freshness, trust_state = u.state
-- FROM (SELECT UNNEST($ids) AS id, UNNEST($scores) AS score, ...) AS u
-- WHERE signals.id = u.id;

-- Archive cleanup:
-- INSERT INTO signals_archive
--   SELECT *, trust_score, confirmation_count, NOW()
--   FROM signals WHERE is_active = FALSE AND created_at < NOW() - INTERVAL '7 days'
--   ON CONFLICT DO NOTHING;
-- DELETE FROM signals WHERE is_active = FALSE AND created_at < NOW() - INTERVAL '7 days';

-- ════════════════════════════════════════════════
-- TRIGGERS
-- ════════════════════════════════════════════════

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER signals_updated_at
  BEFORE UPDATE ON signals
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- Auto-ban reporters with too many flags
CREATE OR REPLACE FUNCTION check_reporter_flags()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE reporter_scores
  SET is_banned = TRUE
  WHERE token = (SELECT reporter_token FROM signals WHERE id = NEW.signal_id)
    AND flagged_count >= 10;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flag_check_trigger
  AFTER INSERT ON signal_flags
  FOR EACH ROW
  EXECUTE FUNCTION check_reporter_flags();
