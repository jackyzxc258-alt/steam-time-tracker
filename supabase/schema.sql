-- ============================================================
-- Steam Game Time Tracker — Supabase Database Schema
-- Run this SQL in Supabase SQL Editor to create tables.
-- ============================================================

-- 1. Child / monitored account configuration
CREATE TABLE IF NOT EXISTS child_config (
  id                    INTEGER PRIMARY KEY DEFAULT 1,
  steam_id              BIGINT NOT NULL,
  steam_api_key         TEXT NOT NULL,
  steam_vanity_url      TEXT,                         -- optional custom URL slug
  daily_limit_minutes   INTEGER,                      -- optional daily alert threshold
  created_at            TIMESTAMPTZ DEFAULT now()
);

-- 2. Game dictionary (cached from Steam API)
CREATE TABLE IF NOT EXISTS games (
  appid       INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  icon_url    TEXT,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- 3. Play-time snapshots — raw data from Steam GetOwnedGames
--    Steam returns *cumulative* playtime_forever (minutes).
--    Daily play = (latest record today) - (earliest record today).
CREATE TABLE IF NOT EXISTS play_snapshots (
  id            BIGSERIAL PRIMARY KEY,
  appid         INTEGER NOT NULL REFERENCES games(appid),
  total_minutes INTEGER NOT NULL,                      -- cumulative minutes from Steam
  recorded_at   TIMESTAMPTZ DEFAULT now()
);

-- Index for fast daily lookups
CREATE INDEX IF NOT EXISTS idx_snapshots_appid_date
  ON play_snapshots (appid, recorded_at DESC);

-- 4. (Optional) Daily summary — materialized for fast frontend reads
CREATE TABLE IF NOT EXISTS daily_summary (
  id            BIGSERIAL PRIMARY KEY,
  date          DATE NOT NULL,
  appid         INTEGER NOT NULL REFERENCES games(appid),
  game_name     TEXT NOT NULL,
  minutes_today INTEGER NOT NULL,                       -- delta for this day
  snapshot_count INTEGER DEFAULT 0,
  UNIQUE (date, appid)
);

CREATE INDEX IF NOT EXISTS idx_daily_summary_date
  ON daily_summary (date DESC);

-- ─────────────────────────────────────────────
-- PostgreSQL function: compute today's daily summary
-- Called by the collector via supabase.rpc('compute_daily_summary')
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION compute_daily_summary()
RETURNS void AS $$
DECLARE
  today_date DATE := CURRENT_DATE;
BEGIN
  -- Delete today's existing rows so we rebuild cleanly
  DELETE FROM daily_summary WHERE date = today_date;

  INSERT INTO daily_summary (date, appid, game_name, minutes_today, snapshot_count)
  SELECT
    today_date,
    s.appid,
    COALESCE(g.name, 'Unknown'),
    MAX(s.total_minutes) - MIN(s.total_minutes),
    COUNT(*)::INT
  FROM play_snapshots s
  LEFT JOIN games g ON g.appid = s.appid
  WHERE s.recorded_at::DATE = today_date
  GROUP BY s.appid, g.name
  HAVING COUNT(*) >= 2;  -- require at least 2 snapshots for a reliable delta
END;
$$ LANGUAGE plpgsql;
