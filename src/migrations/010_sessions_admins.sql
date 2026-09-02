-- Вход мастера/партнёра/админа: серверные сессии + таблица админов.

CREATE TABLE IF NOT EXISTS admins (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at    timestamptz NOT NULL DEFAULT now(),
  phone         text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  name          text NOT NULL,
  role          text NOT NULL DEFAULT 'staff' CHECK (role IN ('owner','staff'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token        text PRIMARY KEY,               -- случайный, >= 32 симв.
  user_type    text NOT NULL CHECK (user_type IN ('master','partner','admin')),
  user_id      bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  last_seen_at timestamptz,
  user_agent   text,
  ip           inet
);
CREATE INDEX IF NOT EXISTS sessions_user_idx    ON sessions (user_type, user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
