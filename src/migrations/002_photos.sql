-- Фото мебели/коробки из формы заявки (до 3 шт). Храним относительные пути вида /uploads/<файл>.
ALTER TABLE leads ADD COLUMN IF NOT EXISTS photos jsonb NOT NULL DEFAULT '[]'::jsonb;
