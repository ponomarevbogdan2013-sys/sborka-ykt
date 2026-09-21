-- Партнёрская премия — 5% от цены мастера (решение владельца 2026-09-21); раньше по умолчанию было 8%.
-- Уже начисленные суммы не трогаем: partner_commission_rub фиксируется в заказе в момент выбора мастера.
ALTER TABLE partners ALTER COLUMN commission_pct SET DEFAULT 5.0;
UPDATE partners SET commission_pct = 5.0 WHERE commission_pct = 8.0;
