-- Файлы мастеров: аватары, портфолио, документы. (Фото заказов остаются в orders.photos.)

CREATE TABLE IF NOT EXISTS media (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  owner_type text NOT NULL,          -- master | order | partner
  owner_id   bigint NOT NULL,
  kind       text NOT NULL,          -- avatar | portfolio | document
  url        text NOT NULL,
  mime       text,
  bytes      integer
);
CREATE INDEX IF NOT EXISTS media_owner_idx ON media (owner_type, owner_id, kind);
