// Удаление демо-партнёра (ref=demo) и всех его демо-данных одной командой:
//   node tools/demo_clear.mjs        (--dry — показать, что удалится, и откатить)
// Удаляет: заказы ref=demo, созданные seed-скриптом (source='demo'), все переходы и выплаты партнёра,
// его сессии входа и сам аккаунт партнёра.
// Если по демо-ссылке успели прийти НАСТОЯЩИЕ заказы/клиенты (не от seed) — их не трогаем,
// печатаем список, и аккаунт партнёра остаётся (на него ссылаются эти записи).
import "dotenv/config";
import { pool } from "../src/db.js";

const CODE = "demo";

async function main() {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const p = (await c.query(`SELECT id FROM partners WHERE code = $1`, [CODE])).rows[0];

    const orders = await c.query(`DELETE FROM orders WHERE ref = $1 AND source = 'demo'`, [CODE]);
    const clicks = await c.query(`DELETE FROM partner_clicks WHERE partner_code = $1`, [CODE]);
    const pays = await c.query(`DELETE FROM partner_payouts WHERE partner_code = $1`, [CODE]);

    const realOrders = (await c.query(
      `SELECT id, created_at, name, status FROM orders WHERE ref = $1 ORDER BY id`, [CODE])).rows;
    const realClients = (await c.query(`SELECT count(*)::int AS n FROM clients WHERE ref = $1`, [CODE])).rows[0].n;

    let partner = "не найден";
    if (p) {
      if (realOrders.length || realClients) {
        partner = "ОСТАВЛЕН (есть настоящие заказы/клиенты по ссылке demo)";
      } else {
        await c.query(`DELETE FROM sessions WHERE user_type = 'partner' AND user_id = $1`, [p.id]);
        await c.query(`DELETE FROM partners WHERE code = $1`, [CODE]);
        partner = "удалён";
      }
    }
    const dry = process.argv.includes("--dry");
    await c.query(dry ? "ROLLBACK" : "COMMIT");
    if (dry) console.log("DRY — ничего не удалено, вот что было бы:");

    console.log(`Удалено: заказов ${orders.rowCount}, переходов ${clicks.rowCount}, выплат ${pays.rowCount}; партнёр: ${partner}`);
    if (realOrders.length || realClients) {
      console.log(`Внимание: по ссылке ref=${CODE} есть настоящие записи — не удалены (клиентов: ${realClients}):`);
      for (const o of realOrders) console.log(`  заказ #${o.id} ${o.created_at.toISOString()} ${o.name} [${o.status}]`);
    }
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
