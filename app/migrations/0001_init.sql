-- shmoney initial schema. Conventions:
--  * transactions.amount follows Plaid: POSITIVE = money out, NEGATIVE = money in.
--  * dates are TEXT 'YYYY-MM-DD'; months are TEXT 'YYYY-MM'; timestamps TEXT ISO-8601 UTC.
--  * ids from Plaid keep Plaid's ids; local rows use AUTOINCREMENT.

CREATE TABLE items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plaid_item_id TEXT NOT NULL UNIQUE,
  access_token TEXT NOT NULL,
  institution_id TEXT,
  institution_name TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | login_required | error
  sync_cursor TEXT,                       -- /transactions/sync cursor
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE accounts (
  id TEXT PRIMARY KEY,                    -- Plaid account_id
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  official_name TEXT,
  mask TEXT,
  type TEXT NOT NULL,                     -- depository | credit | investment | loan
  subtype TEXT,                           -- checking, credit card, roth, brokerage, ira...
  currency TEXT NOT NULL DEFAULT 'USD',
  current_balance REAL,
  available_balance REAL,
  credit_limit REAL,
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE balance_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  balance REAL NOT NULL,
  UNIQUE(account_id, date)
);
CREATE INDEX idx_snapshots_date ON balance_snapshots(date);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'expense' CHECK (kind IN ('expense','income','transfer')),
  color TEXT,                             -- one of the palette tokens, e.g. 'c1'
  hidden INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY,                    -- Plaid transaction_id
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  name TEXT NOT NULL,
  merchant_name TEXT,
  amount REAL NOT NULL,                   -- Plaid sign convention (positive = outflow)
  pending INTEGER NOT NULL DEFAULT 0,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  plaid_category TEXT,                    -- Plaid's personal_finance_category primary
  payment_channel TEXT,
  is_transfer INTEGER NOT NULL DEFAULT 0, -- excluded from spending math
  excluded INTEGER NOT NULL DEFAULT 0,    -- user-excluded from totals
  notes TEXT,
  updated_at TEXT
);
CREATE INDEX idx_txn_date ON transactions(date);
CREATE INDEX idx_txn_account ON transactions(account_id, date);
CREATE INDEX idx_txn_category ON transactions(category_id, date);

CREATE TABLE rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  match_field TEXT NOT NULL DEFAULT 'merchant' CHECK (match_field IN ('merchant','name')),
  match_value TEXT NOT NULL,              -- case-insensitive substring
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  priority INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE budgets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  month TEXT NOT NULL,                    -- 'YYYY-MM'
  amount REAL NOT NULL,
  UNIQUE(category_id, month)
);

CREATE TABLE budget_settings (
  category_id INTEGER PRIMARY KEY REFERENCES categories(id) ON DELETE CASCADE,
  rollover INTEGER NOT NULL DEFAULT 0,
  preset_type TEXT CHECK (preset_type IN ('fixed','last_month_budget','avg_3mo_spend','recurring_total')),
  preset_value REAL
);

CREATE TABLE securities (
  id TEXT PRIMARY KEY,                    -- Plaid security_id
  ticker TEXT,
  name TEXT,
  type TEXT,
  close_price REAL,
  close_price_as_of TEXT
);

CREATE TABLE holdings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT NOT NULL REFERENCES securities(id),
  quantity REAL NOT NULL,
  cost_basis REAL,
  value REAL,
  as_of TEXT,
  UNIQUE(account_id, security_id)
);

CREATE TABLE investment_transactions (
  id TEXT PRIMARY KEY,                    -- Plaid investment_transaction_id
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  security_id TEXT REFERENCES securities(id),
  date TEXT NOT NULL,
  name TEXT,
  amount REAL,
  quantity REAL,
  type TEXT,                              -- buy | sell | dividend | cash | fee | transfer
  subtype TEXT
);
CREATE INDEX idx_invtxn_date ON investment_transactions(date);

CREATE TABLE recurring (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  cadence TEXT NOT NULL DEFAULT 'monthly',
  avg_amount REAL NOT NULL,
  last_date TEXT,
  next_date TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(merchant)
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Seed categories (colors are palette token names, never hex, never emoji)
INSERT INTO categories (name, kind, color, sort) VALUES
  ('Income',            'income',   'c1', 0),
  ('Housing',           'expense',  'c2', 1),
  ('Groceries',         'expense',  'c3', 2),
  ('Dining out',        'expense',  'c2', 3),
  ('Transport',         'expense',  'c4', 4),
  ('Subscriptions',     'expense',  'c1', 5),
  ('Shopping',          'expense',  'c4', 6),
  ('Entertainment',     'expense',  'c3', 7),
  ('Bills & utilities', 'expense',  'c2', 8),
  ('Travel',            'expense',  'c4', 9),
  ('Health',            'expense',  'c3', 10),
  ('Investing',         'transfer', 'c1', 11),
  ('Transfers',         'transfer', 'c1', 12),
  ('Other',             'expense',  'c4', 13);

INSERT INTO settings (key, value) VALUES
  ('expected_monthly_income', '0'),
  ('roth_contribution_limit', '7000'),
  ('roth_contributed_ytd', '0'),
  ('inherited_ira_year_of_death', ''),
  ('inherited_ira_starting_balance', '');
