-- Initial Cloudflare D1 schema for ODDSHOT.
-- Schema only: existing SQLite data and image BLOBs must be copied separately.
-- Retains the current table/column names, IDs, and evaluation version association.

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL,
  nickname_key TEXT NOT NULL UNIQUE,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id),
  title TEXT NOT NULL,
  image_bytes BLOB,
  mime_type TEXT NOT NULL,
  sample_key TEXT,
  created_at TEXT NOT NULL,
  sync_status TEXT NOT NULL CHECK (sync_status IN ('pending', 'synced', 'failed')),
  sync_updated_at TEXT,
  request_id TEXT,
  request_fingerprint TEXT,
  title_suggestions_json TEXT
);

CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL UNIQUE REFERENCES photos(id),
  evaluation_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  criteria_version TEXT NOT NULL DEFAULT 'demo-v1'
);

CREATE TABLE IF NOT EXISTS scoring_criteria (
  id TEXT NOT NULL,
  version TEXT PRIMARY KEY,
  criteria_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS photos_user_created ON photos(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS photos_request_id ON photos(request_id) WHERE request_id IS NOT NULL;
