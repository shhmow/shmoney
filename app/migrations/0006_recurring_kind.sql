-- Recurring streams can be bills (money out) or income (paychecks, money in).
ALTER TABLE recurring ADD COLUMN kind TEXT NOT NULL DEFAULT 'expense';
