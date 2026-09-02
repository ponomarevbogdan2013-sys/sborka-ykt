-- Отклики мастеров на заказ + журнал статусов (трекер сделки).

CREATE TABLE IF NOT EXISTS offers (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  order_id     bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  master_id    bigint NOT NULL REFERENCES masters(id) ON DELETE CASCADE,
  price_rub    integer NOT NULL,
  can_start_at timestamptz,
  note         text,
  status       text NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','withdrawn','accepted','rejected','expired')),
  UNIQUE (order_id, master_id)
);
CREATE INDEX IF NOT EXISTS offers_order_idx         ON offers (order_id);
CREATE INDEX IF NOT EXISTS offers_master_status_idx ON offers (master_id, status);

ALTER TABLE orders
  ADD CONSTRAINT orders_chosen_offer_fk FOREIGN KEY (chosen_offer_id) REFERENCES offers(id);

CREATE TABLE IF NOT EXISTS deal_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  actor_type  text NOT NULL CHECK (actor_type IN ('client','master','admin','system')),
  actor_id    bigint,
  from_status text,
  to_status   text,
  note        text
);
CREATE INDEX IF NOT EXISTS deal_events_order_idx ON deal_events (order_id, at);
