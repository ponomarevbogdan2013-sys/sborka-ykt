-- Сброс пароля мастеру: владелец генерирует в админке одноразовую ссылку /m?reset=<token>,
-- мастер по ней задаёт новый пароль. Отдельная колонка от invite_token — нужна для уже активных мастеров.
ALTER TABLE masters ADD COLUMN IF NOT EXISTS reset_token text UNIQUE;
