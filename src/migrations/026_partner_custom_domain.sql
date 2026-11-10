-- Свой домен на точку продаж (вместо короткой /r/<code> ссылки под основным доменом).
-- nginx сам редиректит домен на https://мастера14.рф/?ref=<code> — тут только что показывать в кабинете/QR.
ALTER TABLE partners ADD COLUMN IF NOT EXISTS custom_domain text UNIQUE;
