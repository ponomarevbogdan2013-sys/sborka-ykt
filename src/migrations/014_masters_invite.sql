-- Мастера только по приглашению: инвайт-токен, статус стартует 'invited', пароль позже.

ALTER TABLE masters ADD COLUMN IF NOT EXISTS invite_token text;
ALTER TABLE masters ADD COLUMN IF NOT EXISTS invited_by   bigint;

CREATE UNIQUE INDEX IF NOT EXISTS masters_invite_token_uidx
  ON masters (invite_token) WHERE invite_token IS NOT NULL;

-- при создании инвайта пароля ещё нет
ALTER TABLE masters ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE masters ALTER COLUMN status SET DEFAULT 'invited';
ALTER TABLE masters DROP CONSTRAINT IF EXISTS masters_status_check;
ALTER TABLE masters ADD CONSTRAINT masters_status_check
  CHECK (status IN ('invited','pending','active','suspended'));
