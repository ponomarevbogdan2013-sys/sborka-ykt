-- Уведомления клиентам через WhatsApp (Baileys) и MAX (PyMax) с аккаунта номера.
-- channel='messenger' — строка в очереди, канал выбирает роутер; после отправки channel
-- переписывается на фактический (whatsapp | max | telegram — резерв владельцу).
-- status='skipped' — не отправляли по правилам (лимит на заявку, тест-режим, заявка закрыта).

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_channel_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_channel_check
  CHECK (channel IN ('push','telegram','sms','whatsapp','max','messenger'));

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_status_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_status_check
  CHECK (status IN ('queued','sent','failed','skipped'));

CREATE INDEX IF NOT EXISTS notifications_channel_status_idx ON notifications (channel, status, created_at);

-- Сессия WhatsApp (Baileys auth state): creds + ключи Signal. Секрет — в git не попадает.
CREATE TABLE IF NOT EXISTS wa_auth (
  id         text PRIMARY KEY,
  data       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Клиент сам написал нам в канал (опт-ин): туда шлём в первую очередь.
CREATE TABLE IF NOT EXISTS client_channels (
  client_id    bigint NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  channel      text   NOT NULL CHECK (channel IN ('whatsapp','max')),
  opted_in_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, channel)
);
