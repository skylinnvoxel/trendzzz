-- Migration 002: topics-based model
-- Run this AFTER schema.sql if you already deployed Phase 1's original
-- per-source-type preferences. Safe to run once; re-running is a no-op
-- thanks to IF NOT EXISTS / OR IGNORE.

CREATE TABLE IF NOT EXISTS user_topics (
  user_id TEXT NOT NULL REFERENCES users(id),
  keyword TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, keyword)
);

-- Carry over any keywords you already typed in under the old model.
INSERT OR IGNORE INTO user_topics (user_id, keyword, created_at)
SELECT user_id, keyword, MIN(created_at) FROM user_preferences GROUP BY user_id, keyword;

-- GitHub switched from "trending by language" to "search by keyword" —
-- relabel any rows already fetched under the old category name.
UPDATE feed_items SET source_type = 'github' WHERE source_type = 'github_trending';

DROP TABLE IF EXISTS user_preferences;
