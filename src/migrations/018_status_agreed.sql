-- Новый статус заказа «agreed» («Договорились»): между «assigned» (мастер назначен) и «en_route» (едет).
-- Клиент и мастер созвонились и подтвердили договорённость; вернуть заявку в поиск можно до выезда мастера.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_status_chk
  CHECK (status = ANY (ARRAY['open','assigned','agreed','en_route','working','done','cancelled','expired','spam']));
