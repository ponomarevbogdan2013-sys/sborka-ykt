// Простой раннер миграций: применяет по порядку все src/migrations/*.sql,
// которых ещё нет в таблице schema_migrations. Идемпотентно.
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import "dotenv/config";
import { pool } from "./db.js";

const dir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

async function run() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const done = new Set(
    (await pool.query("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
  );

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(join(dir, file), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      console.log("применена миграция:", file);
      applied++;
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("ошибка в миграции", file, "—", e.message);
      process.exit(1);
    } finally {
      client.release();
    }
  }
  console.log(applied ? `готово, применено: ${applied}` : "новых миграций нет");
  await pool.end();
}

run();
