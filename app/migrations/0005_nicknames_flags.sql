-- User-owned account metadata and per-transaction flags.
ALTER TABLE accounts ADD COLUMN nickname TEXT;          -- display override
ALTER TABLE accounts ADD COLUMN manual_limit REAL;      -- credit limit when Plaid has none
ALTER TABLE transactions ADD COLUMN flagged INTEGER NOT NULL DEFAULT 0;  -- user flagged for follow-up / dispute
