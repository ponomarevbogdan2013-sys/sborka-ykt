-- Реферальная ссылка/QR мастера для клиентов (?m=<код>): отдельно от партнёрской ?ref=,
-- которая жёстко привязана внешним ключом к partners и считает комиссию. Тут просто счётчик
-- переходов по ссылке конкретного мастера, без денег и без влияния на orders/clients.

ALTER TABLE masters ADD COLUMN IF NOT EXISTS ref_code text;
UPDATE masters SET ref_code = 'm' || id::text WHERE ref_code IS NULL;
ALTER TABLE masters ALTER COLUMN ref_code SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS masters_ref_code_uidx ON masters (ref_code);

CREATE TABLE IF NOT EXISTS master_clicks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  master_id    bigint NOT NULL REFERENCES masters(id),
  at           timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  user_agent   text,
  landing_path text
);
CREATE INDEX IF NOT EXISTS master_clicks_master_at_idx ON master_clicks (master_id, at);
