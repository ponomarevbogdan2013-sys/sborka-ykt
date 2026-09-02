-- Этап 1: заявки + партнёрская атрибуция.
-- Личные кабинеты, отклики, отзывы — Этап 2, отдельными миграциями.

CREATE TABLE IF NOT EXISTS partners (
  code            text PRIMARY KEY,                 -- ?ref=<code>
  title           text NOT NULL,
  commission_pct  numeric(4,1) NOT NULL DEFAULT 8.0,
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  name            text NOT NULL,
  phone           text NOT NULL,
  address         text,
  preferred_date  date,
  preferred_time  text,
  budget_rub      integer,
  comment         text,
  items           jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id,nm,qty,unit,sum}]
  addons          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{id,nm,price,mult}]
  calc_low        integer,                              -- вилка, посчитанная сервером
  calc_high       integer,
  ref             text REFERENCES partners(code),       -- источник (партнёр)
  source          text,                                 -- utm / канал, если будет
  user_agent      text,
  ip              inet,
  status          text NOT NULL DEFAULT 'new',          -- new | in_progress | done | spam
  notified_at     timestamptz                           -- когда ушло уведомление владельцу
);

CREATE INDEX IF NOT EXISTS leads_created_at_idx ON leads (created_at DESC);
CREATE INDEX IF NOT EXISTS leads_status_idx     ON leads (status);
CREATE INDEX IF NOT EXISTS leads_ref_idx        ON leads (ref);

-- Стартовый партнёр из макета.
INSERT INTO partners (code, title, commission_pct)
VALUES ('uyut', 'Мебельный магазин «Уют»', 8.0)
ON CONFLICT (code) DO NOTHING;
