-- Durable owner-authorized Google Drive synchronization.
-- This migration adds storage without changing existing photos or evaluations.
CREATE TABLE IF NOT EXISTS app_settings (
  setting_key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS drive_sync_jobs (
  photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
  image_file_id TEXT,
  metadata_file_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'synced', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  lease_token TEXT,
  lease_until TEXT,
  requested_revision INTEGER NOT NULL DEFAULT 1,
  completed_revision INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS drive_sync_jobs_ready ON drive_sync_jobs(status, next_attempt_at, lease_until);
CREATE UNIQUE INDEX IF NOT EXISTS drive_sync_jobs_lease ON drive_sync_jobs(lease_token) WHERE lease_token IS NOT NULL;
