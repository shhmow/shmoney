-- Business-expense tagging for the Taxes tab: a spending transaction can be
-- tied to the income category (Schedule C source) it was spent for.
ALTER TABLE transactions ADD COLUMN biz_category_id INTEGER REFERENCES categories(id);
