import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("Нет DATABASE_URL в окружении (.env). Останавливаюсь.");
  process.exit(1);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 6,
  idleTimeoutMillis: 30_000,
});

pool.on("error", (err) => {
  console.error("Ошибка пула PostgreSQL:", err.message);
});

export const q = (text, params) => pool.query(text, params);
