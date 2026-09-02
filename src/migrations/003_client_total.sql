-- Сумма, показанная калькулятором на фронте (для контроля расхождений с расчётом бэкенда).
-- В расчёте заявки НЕ участвует — источник истины по цене серверный (src/pricing.js).
ALTER TABLE leads ADD COLUMN IF NOT EXISTS client_total integer;
