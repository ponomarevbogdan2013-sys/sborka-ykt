-- Категории «Двери» и «Сантехника» + комиссия платформы по категории.
-- Комиссия фиксируется в заказе при выборе мастера (routes_client.js → choose), уже начисленное не меняется.

ALTER TABLE service_categories
  ADD COLUMN IF NOT EXISTS commission_pct numeric(4,1) NOT NULL DEFAULT 30;

INSERT INTO service_categories (code, title, sort, commission_pct) VALUES
  ('furniture', 'Сборка мебели',     1, 30),
  ('doors',     'Установка дверей',  2, 20),
  ('plumbing',  'Сантехника',        3, 20)
ON CONFLICT (code) DO UPDATE
  SET title = EXCLUDED.title, sort = EXCLUDED.sort, commission_pct = EXCLUDED.commission_pct;

-- Мастера без отмеченных направлений — в «Сборку мебели» (иначе с включённым фильтром их лента опустеет).
INSERT INTO master_categories (master_id, category)
SELECT m.id, 'furniture' FROM masters m
 WHERE NOT EXISTS (SELECT 1 FROM master_categories mc WHERE mc.master_id = m.id);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_category_fk;
ALTER TABLE orders
  ADD CONSTRAINT orders_category_fk FOREIGN KEY (category) REFERENCES service_categories(code);
CREATE INDEX IF NOT EXISTS orders_category_status_idx ON orders (category, status);
