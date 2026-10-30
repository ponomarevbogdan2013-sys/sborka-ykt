-- Комиссия платформы за мебель 30% → 20% (решение владельца 2026-10-30). Теперь все категории по 20%.
-- Уже выбранные заказы не пересчитываются: комиссия зафиксирована в orders.commission_rub при выборе мастера.
UPDATE service_categories SET commission_pct = 20 WHERE code = 'furniture';
