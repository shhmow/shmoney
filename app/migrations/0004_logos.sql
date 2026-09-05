-- Institution branding (from Plaid /institutions/get_by_id optional metadata)
-- and per-transaction merchant logos (Plaid transactions logo_url / website).
ALTER TABLE items ADD COLUMN logo TEXT;            -- base64 PNG, ~152x152
ALTER TABLE items ADD COLUMN primary_color TEXT;   -- hex, e.g. '#016fd0'
ALTER TABLE items ADD COLUMN url TEXT;             -- institution homepage
ALTER TABLE transactions ADD COLUMN logo_url TEXT;
ALTER TABLE transactions ADD COLUMN website TEXT;
