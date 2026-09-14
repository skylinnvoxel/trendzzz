-- trendingtoday.skylinn.in — D1 schema (Phase 1)

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

-- One row per topic (a single keyword) a user has chosen to follow.
-- The cron fetches this same keyword across every open category
-- (YouTube, GitHub, News) automatically — no per-source setup needed.
CREATE TABLE IF NOT EXISTS user_topics (
  user_id TEXT NOT NULL REFERENCES users(id),
  keyword TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, keyword)
);

-- One row per fetched item. id is a sha-256 of the URL so re-fetching the
-- same link across cron runs is a no-op (INSERT OR IGNORE).
-- source_type: 'youtube' | 'github' | 'rss' | 'twitter' | 'reddit' | 'bilibili' | 'xhs'
-- source_key: the topic keyword this item was fetched for.
CREATE TABLE IF NOT EXISTS feed_items (
  id TEXT PRIMARY KEY,
  source_type TEXT NOT NULL,
  source_key TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  summary TEXT,
  published_at INTEGER,
  fetched_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_items_lookup ON feed_items(source_type, source_key, published_at DESC);
