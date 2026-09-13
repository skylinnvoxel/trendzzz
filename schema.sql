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

-- One row per topic/source a user has chosen to follow.
-- source_type: 'youtube' | 'github_trending' | 'reddit' | 'rss' | 'twitter' | 'bilibili' | 'xhs'
-- keyword meaning depends on source_type:
--   youtube        -> search query, e.g. "ai agents"
--   github_trending-> language, e.g. "python" (use "" for all languages)
--   reddit         -> subreddit name, e.g. "programming"
--   rss            -> full feed URL
--   twitter/bilibili/xhs -> topic/handle string used by the Agent-Reach runner (Phase 2)
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  source_type TEXT NOT NULL,
  keyword TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_type, keyword)
);

-- One row per fetched item. id is a sha-256 of the URL so re-fetching the
-- same link across cron runs is a no-op (INSERT OR IGNORE).
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
