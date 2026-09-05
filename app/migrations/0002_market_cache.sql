-- Server-side cache for external market lookups (Yahoo chart / quoteSummary).
-- payload is JSON; fetched_at is ISO-8601 UTC. Rows are refreshed in place on
-- expiry (24h TTL enforced in code, stale rows served if a refetch fails).
CREATE TABLE market_cache (
  key TEXT PRIMARY KEY,
  fetched_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
