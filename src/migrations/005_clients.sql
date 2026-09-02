-- Клиенты: токен-идентификация. Один токен = все заявки клиента (склейка по телефону).

CREATE TABLE IF NOT EXISTS clients (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  phone        text NOT NULL UNIQUE,          -- нормализованный (только цифры, 7XXXXXXXXXX)
  name         text,
  token        text NOT NULL UNIQUE,          -- доступ к /z/<token>
  ref          text REFERENCES partners(code),
  rating_avg   numeric(3,2) NOT NULL DEFAULT 0,
  rating_count integer      NOT NULL DEFAULT 0,
  blocked      boolean      NOT NULL DEFAULT false,
  last_seen_at timestamptz
);

ALTER TABLE orders
  ADD CONSTRAINT orders_client_fk FOREIGN KEY (client_id) REFERENCES clients(id);
