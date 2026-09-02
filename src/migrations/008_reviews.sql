-- Двусторонние отзывы (клиент <-> мастер) по конкретной сделке.

CREATE TABLE IF NOT EXISTS reviews (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_at  timestamptz NOT NULL DEFAULT now(),
  order_id    bigint NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  author_type text NOT NULL CHECK (author_type IN ('client','master')),
  author_id   bigint NOT NULL,
  target_type text NOT NULL CHECK (target_type IN ('client','master')),
  target_id   bigint NOT NULL,
  rating      integer NOT NULL CHECK (rating BETWEEN 1 AND 5),
  text        text,
  visible     boolean NOT NULL DEFAULT false,   -- публикуется, когда обе стороны оставили или через 7 дней
  UNIQUE (order_id, author_type)
);
CREATE INDEX IF NOT EXISTS reviews_target_idx ON reviews (target_type, target_id, visible);

-- Пересчёт рейтинга цели при появлении/снятии видимого отзыва.
CREATE OR REPLACE FUNCTION recalc_rating() RETURNS trigger AS $$
DECLARE
  t_type text;
  t_id   bigint;
BEGIN
  t_type := COALESCE(NEW.target_type, OLD.target_type);
  t_id   := COALESCE(NEW.target_id,   OLD.target_id);

  IF t_type = 'master' THEN
    UPDATE masters SET
      rating_avg   = COALESCE((SELECT round(avg(rating)::numeric, 2) FROM reviews
                               WHERE target_type='master' AND target_id=t_id AND visible), 0),
      rating_count = (SELECT count(*) FROM reviews
                      WHERE target_type='master' AND target_id=t_id AND visible)
    WHERE id = t_id;
  ELSIF t_type = 'client' THEN
    UPDATE clients SET
      rating_avg   = COALESCE((SELECT round(avg(rating)::numeric, 2) FROM reviews
                               WHERE target_type='client' AND target_id=t_id AND visible), 0),
      rating_count = (SELECT count(*) FROM reviews
                      WHERE target_type='client' AND target_id=t_id AND visible)
    WHERE id = t_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS reviews_recalc ON reviews;
CREATE TRIGGER reviews_recalc
  AFTER INSERT OR UPDATE OR DELETE ON reviews
  FOR EACH ROW EXECUTE FUNCTION recalc_rating();
