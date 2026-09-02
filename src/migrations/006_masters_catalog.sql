-- Мастера, категории услуг, портфолио, документы на верификацию.

CREATE TABLE IF NOT EXISTS service_categories (
  code   text PRIMARY KEY,
  title  text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  sort   integer NOT NULL DEFAULT 100
);
INSERT INTO service_categories (code, title, sort) VALUES ('furniture', 'Сборка мебели', 1)
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS masters (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at          timestamptz NOT NULL DEFAULT now(),
  phone               text NOT NULL UNIQUE,           -- логин (нормализованный)
  password_hash       text NOT NULL,
  name                text NOT NULL,
  photo_url           text,
  about               text,
  experience_years    integer,
  zones               text[] NOT NULL DEFAULT '{}',   -- районы выезда
  has_tools           boolean NOT NULL DEFAULT false,
  has_car             boolean NOT NULL DEFAULT false,
  self_employed       text NOT NULL DEFAULT 'none' CHECK (self_employed IN ('none','self_employed','ie')),
  status              text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended')),
  verified            boolean NOT NULL DEFAULT false,
  verified_at         timestamptz,
  verified_by         bigint,
  rating_avg          numeric(3,2) NOT NULL DEFAULT 0,
  rating_count        integer      NOT NULL DEFAULT 0,
  orders_done         integer      NOT NULL DEFAULT 0,
  response_median_min integer,
  tg_chat_id          text,
  last_seen_at        timestamptz
);
CREATE INDEX IF NOT EXISTS masters_status_idx ON masters (status);
CREATE INDEX IF NOT EXISTS masters_zones_idx  ON masters USING gin (zones);

CREATE TABLE IF NOT EXISTS master_categories (
  master_id bigint NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  category  text   NOT NULL REFERENCES service_categories(code),
  PRIMARY KEY (master_id, category)
);

CREATE TABLE IF NOT EXISTS portfolio_items (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  master_id  bigint NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  photo_url  text NOT NULL,
  caption    text,
  sort       integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS portfolio_master_idx ON portfolio_items (master_id, sort);

CREATE TABLE IF NOT EXISTS master_documents (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  master_id   bigint NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  kind        text NOT NULL,                 -- passport | self_employed_cert | other
  file_url    text NOT NULL,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  reviewed_by bigint,
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS master_docs_master_idx ON master_documents (master_id);

ALTER TABLE orders
  ADD CONSTRAINT orders_assigned_master_fk FOREIGN KEY (assigned_master_id) REFERENCES masters(id);
