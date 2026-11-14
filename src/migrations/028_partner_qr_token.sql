-- Точный счётчик сканирований QR. В QR зашит адрес с кодом (partners.qr_token), которого нет в
-- печатном тексте листовки и нигде публично: заход с верным кодом = сканирование (partner_clicks.via_qr).
-- Заход по чистому домену/ссылке (ручной набор, боты по логам сертификатов) кода не несёт.
-- Значения кодов генерируются здесь случайно и живут только в БД — в git их нет.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS qr_token text;
UPDATE partners
   SET qr_token = substr(md5(random()::text || clock_timestamp()::text || code), 1, 10)
 WHERE qr_token IS NULL;
ALTER TABLE partner_clicks ADD COLUMN IF NOT EXISTS via_qr boolean NOT NULL DEFAULT false;
