-- Этап 2: leads -> orders (заявка = заказ, к которому мастера делают отклики).

ALTER TABLE leads RENAME TO orders;
ALTER INDEX leads_pkey            RENAME TO orders_pkey;
ALTER INDEX leads_created_at_idx  RENAME TO orders_created_at_idx;
ALTER INDEX leads_status_idx      RENAME TO orders_status_idx;
ALTER INDEX leads_ref_idx         RENAME TO orders_ref_idx;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS client_id              bigint,
  ADD COLUMN IF NOT EXISTS category               text NOT NULL DEFAULT 'furniture',
  ADD COLUMN IF NOT EXISTS district               text,
  ADD COLUMN IF NOT EXISTS chosen_offer_id        bigint,
  ADD COLUMN IF NOT EXISTS assigned_master_id     bigint,
  ADD COLUMN IF NOT EXISTS agreed_price_rub       integer,
  ADD COLUMN IF NOT EXISTS commission_rub         integer,
  ADD COLUMN IF NOT EXISTS partner_commission_rub integer,
  ADD COLUMN IF NOT EXISTS contact_revealed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS expires_at             timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at           timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at           timestamptz,
  ADD COLUMN IF NOT EXISTS cancel_reason          text,
  ADD COLUMN IF NOT EXISTS notified_masters_at    timestamptz,
  ADD COLUMN IF NOT EXISTS client_notified_at     timestamptz;

-- статус: расширенный жизненный цикл. Старое 'new' -> 'open'.
ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'open';
UPDATE orders SET status = 'open' WHERE status = 'new';
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_chk;
ALTER TABLE orders ADD CONSTRAINT orders_status_chk CHECK (
  status IN ('open','assigned','en_route','working','done','cancelled','expired','spam')
);

CREATE INDEX IF NOT EXISTS orders_district_status_idx ON orders (district, status);
CREATE INDEX IF NOT EXISTS orders_client_idx          ON orders (client_id);
CREATE INDEX IF NOT EXISTS orders_assigned_master_idx ON orders (assigned_master_id);
