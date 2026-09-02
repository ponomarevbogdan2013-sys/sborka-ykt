-- Исходящие уведомления: лог + очередь (надёжность, видимость в админке).

CREATE TABLE IF NOT EXISTS notifications (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at     timestamptz NOT NULL DEFAULT now(),
  channel        text NOT NULL CHECK (channel IN ('push','telegram','sms','whatsapp')),
  recipient_type text NOT NULL,          -- client | master | partner | owner
  recipient_id   bigint,
  template       text NOT NULL,          -- код шаблона (order_new, offer_received, ...)
  payload        jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed')),
  sent_at        timestamptz,
  error          text
);
CREATE INDEX IF NOT EXISTS notifications_status_idx ON notifications (status, created_at);
