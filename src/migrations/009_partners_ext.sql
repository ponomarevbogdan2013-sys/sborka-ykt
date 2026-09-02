-- Партнёры: кабинет (логин, баланс, tier), лог переходов, выплаты.

ALTER TABLE partners
  ADD COLUMN IF NOT EXISTS phone            text,
  ADD COLUMN IF NOT EXISTS password_hash    text,
  ADD COLUMN IF NOT EXISTS contact_name     text,
  ADD COLUMN IF NOT EXISTS payout_details   jsonb,
  ADD COLUMN IF NOT EXISTS balance_rub      integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_earned_rub integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tier             text NOT NULL DEFAULT 'base'
                                            CHECK (tier IN ('base','silver','gold')),
  ADD COLUMN IF NOT EXISTS created_by       bigint;

CREATE UNIQUE INDEX IF NOT EXISTS partners_phone_uidx ON partners (phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS partner_clicks (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_code text NOT NULL REFERENCES partners(code),
  at           timestamptz NOT NULL DEFAULT now(),
  ip           inet,
  user_agent   text,
  landing_path text
);
CREATE INDEX IF NOT EXISTS partner_clicks_code_at_idx ON partner_clicks (partner_code, at);

CREATE TABLE IF NOT EXISTS partner_payouts (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  partner_code text NOT NULL REFERENCES partners(code),
  amount_rub   integer NOT NULL,
  status       text NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested','paid','rejected')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  paid_at      timestamptz,
  note         text
);
CREATE INDEX IF NOT EXISTS partner_payouts_code_idx ON partner_payouts (partner_code, requested_at);
