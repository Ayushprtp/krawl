-- FlareCrawl schema

CREATE TABLE IF NOT EXISTS api_keys (
  id           BIGSERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  key_prefix   TEXT NOT NULL,              -- fc_live_xxxx (shown in UI)
  key_hash     TEXT NOT NULL UNIQUE,       -- sha256 of the full key
  concurrency  INT  NOT NULL DEFAULT 3,    -- max concurrent sessions for this key
  enabled      BOOLEAN NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS sessions (
  id            UUID PRIMARY KEY,
  api_key_id    BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
  container_idx INT NOT NULL,
  steel_id      TEXT,
  status        TEXT NOT NULL DEFAULT 'live',   -- live | released | error
  task          TEXT,
  current_url   TEXT,
  page_title    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_key_status_idx ON sessions(api_key_id, status);

CREATE TABLE IF NOT EXISTS usage_events (
  id         BIGSERIAL PRIMARY KEY,
  api_key_id BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
  session_id UUID,
  kind       TEXT NOT NULL,           -- session_create | agent_step | agent_done | error
  meta       JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_key_time_idx ON usage_events(api_key_id, created_at);
