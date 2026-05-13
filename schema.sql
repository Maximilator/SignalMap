-- SignalMap Pro — PostgreSQL 16 + PostGIS 3.4 schema

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

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

CREATE TABLE IF NOT EXISTS signals (
  id                  UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  category            signal_category NOT NULL,
  location            GEOMETRY(Point, 4326) NOT NULL,
  description         TEXT            CHECK (description IS NULL OR char_length(description) <= 280),
  image_url           TEXT,
  reporter_token      TEXT            NOT NULL,
  trust_score         SMALLINT        NOT NULL DEFAULT 8 CHECK (trust_score >= 0 AND trust_score <= 100),
  confirmation_count  INTEGER         NOT NULL DEFAULT 0 CHECK (confirmation_count >= 0),
  freshness           NUMERIC(6,5)    NOT NULL DEFAULT 1.0 CHECK (freshness >= 0 AND freshness <= 1),
  trust_state         trust_state     NOT NULL DEFAULT 'ghost',
  is_active           BOOLEAN         NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW(),
  expires_at          TIMESTAMPTZ     NOT NULL,
  updated_at          TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_location ON signals USING GIST(location);
CREATE INDEX IF NOT EXISTS idx_signals_location_active ON signals USING GIST(location) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_signals_active_created ON signals(created_at DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_signals_expires_active ON signals(expires_at ASC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_signals_trust_active ON signals(trust_score DESC, created_at DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_signals_reporter_active ON signals(reporter_token, created_at DESC) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_signals_category_active ON signals(category, created_at DESC) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS confirmations (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id     UUID        NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  user_token    TEXT        NOT NULL,
  confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_confirmation UNIQUE(signal_id, user_token)
);

CREATE INDEX IF NOT EXISTS idx_confirmations_signal ON confirmations(signal_id);
CREATE INDEX IF NOT EXISTS idx_confirmations_user ON confirmations(user_token, confirmed_at DESC);

CREATE TABLE IF NOT EXISTS reporter_scores (
  token              TEXT        PRIMARY KEY,
  total_signals      INTEGER     NOT NULL DEFAULT 0 CHECK (total_signals >= 0),
  confirmed_signals  INTEGER     NOT NULL DEFAULT 0 CHECK (confirmed_signals >= 0),
  flagged_count      INTEGER     NOT NULL DEFAULT 0 CHECK (flagged_count >= 0),
  score              SMALLINT    NOT NULL DEFAULT 50 CHECK (score >= 0 AND score <= 100),
  is_banned          BOOLEAN     NOT NULL DEFAULT FALSE,
  last_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reporter_score ON reporter_scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_reporter_banned ON reporter_scores(is_banned) WHERE is_banned = TRUE;

CREATE TABLE IF NOT EXISTS signal_flags (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id   UUID        NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  user_token  TEXT        NOT NULL,
  reason      TEXT        CHECK (reason IS NULL OR char_length(reason) <= 140),
  flagged_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT unique_flag UNIQUE(signal_id, user_token)
);

CREATE INDEX IF NOT EXISTS idx_flags_signal ON signal_flags(signal_id);
CREATE INDEX IF NOT EXISTS idx_flags_user ON signal_flags(user_token, flagged_at DESC);

CREATE TABLE IF NOT EXISTS signals_archive (
  LIKE signals INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES,
  final_trust_score   SMALLINT,
  final_confirm_count INTEGER,
  archived_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS signal_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  signal_id   UUID        REFERENCES signals(id) ON DELETE SET NULL,
  event_type  TEXT        NOT NULL CHECK (event_type IN ('created', 'confirmed', 'flagged', 'expired', 'updated')),
  actor_token TEXT,
  payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_events_signal ON signal_events(signal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signal_events_type ON signal_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT        NOT NULL,
  action       TEXT        NOT NULL,
  count        INTEGER     NOT NULL DEFAULT 1,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (key, action)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);

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
  COUNT(*) FILTER (WHERE is_active)::int AS active_count,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 hour')::int AS last_hour,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS last_day,
  AVG(trust_score) FILTER (WHERE is_active) AS avg_trust,
  SUM(confirmation_count) FILTER (WHERE is_active)::int AS total_confirmations
FROM signals
GROUP BY category
ORDER BY active_count DESC;

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signals_updated_at ON signals;
CREATE TRIGGER signals_updated_at
  BEFORE UPDATE ON signals
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE OR REPLACE FUNCTION insert_signal_event_on_signal_insert()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO signal_events(signal_id, event_type, actor_token, payload)
  VALUES (NEW.id, 'created', NEW.reporter_token, jsonb_build_object('category', NEW.category));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signal_created_event ON signals;
CREATE TRIGGER signal_created_event
  AFTER INSERT ON signals
  FOR EACH ROW
  EXECUTE FUNCTION insert_signal_event_on_signal_insert();

CREATE OR REPLACE FUNCTION insert_signal_event_on_confirmation()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO signal_events(signal_id, event_type, actor_token)
  VALUES (NEW.signal_id, 'confirmed', NEW.user_token);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signal_confirmed_event ON confirmations;
CREATE TRIGGER signal_confirmed_event
  AFTER INSERT ON confirmations
  FOR EACH ROW
  EXECUTE FUNCTION insert_signal_event_on_confirmation();

CREATE OR REPLACE FUNCTION insert_signal_event_on_flag()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO signal_events(signal_id, event_type, actor_token, payload)
  VALUES (NEW.signal_id, 'flagged', NEW.user_token, jsonb_build_object('reason', NEW.reason));

  UPDATE reporter_scores
  SET is_banned = TRUE
  WHERE token = (SELECT reporter_token FROM signals WHERE id = NEW.signal_id)
    AND flagged_count >= 10;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS signal_flagged_event ON signal_flags;
CREATE TRIGGER signal_flagged_event
  AFTER INSERT ON signal_flags
  FOR EACH ROW
  EXECUTE FUNCTION insert_signal_event_on_flag();
