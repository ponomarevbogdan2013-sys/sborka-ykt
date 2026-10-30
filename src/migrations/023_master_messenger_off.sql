-- Владелец может отключить мастеру сообщения в WhatsApp/MAX (кнопка во вкладке «Мастера» админки).
-- Пуши и лента заявок от этого не зависят.
ALTER TABLE masters ADD COLUMN IF NOT EXISTS messenger_off boolean NOT NULL DEFAULT false;
