-- Статус отклика «declined» — мастера выбрали, но с ним не договорились (клиент вернул заявку в поиск).
-- Нужен отдельным значением: при возврате заявки все отклики 'rejected' (отклонены выбором) возвращаются
-- в 'active', а отклик мастера, с которым не договорились, восстанавливаться не должен.
ALTER TABLE offers DROP CONSTRAINT IF EXISTS offers_status_check;
ALTER TABLE offers ADD CONSTRAINT offers_status_check
  CHECK (status = ANY (ARRAY['active','withdrawn','accepted','rejected','expired','declined']));
