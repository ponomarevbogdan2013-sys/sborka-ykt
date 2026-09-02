-- Web-push подписки (клиент / мастер / партнёр).

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at      timestamptz NOT NULL DEFAULT now(),
  subscriber_type text NOT NULL CHECK (subscriber_type IN ('client','master','partner')),
  subscriber_id   bigint NOT NULL,
  endpoint        text NOT NULL UNIQUE,
  p256dh          text NOT NULL,
  auth            text NOT NULL,
  user_agent      text,
  last_ok_at      timestamptz,
  fail_count      integer NOT NULL DEFAULT 0,
  disabled        boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS push_sub_owner_idx ON push_subscriptions (subscriber_type, subscriber_id) WHERE NOT disabled;
