// Демо-кабинет партнёра для презентации магазинам (ref=demo).
// Запуск:   node tools/demo_seed.mjs        (--dry — вставить, сверить и откатить)
// Удаление: node tools/demo_clear.mjs
//
// Всё пишется ПРЯМОЙ вставкой в БД, мимо API: так не создаются строки в notifications,
// и мастерам/клиентам ничего не уходит (WhatsApp/MAX/web-push берут только из очереди notifications).
// Статусы только done / working / agreed: open попал бы в ленту мастеров (/api/master/feed).
// Мастера не привязываются (assigned_master_id = NULL), клиенты не создаются (client_id = NULL).
// В имени клиента «(тест)» — дашборд /admin такие заявки не считает.
//
// Телефон и пароль партнёра генерируются на запуске и печатаются только в консоль (в git их нет).
import "dotenv/config";
import { randomInt } from "node:crypto";
import { pool } from "../src/db.js";
import { hashPassword } from "../src/auth.js";
import { calcEstimate } from "../src/pricing.js";

const CODE = "demo";
const TITLE = "Демо-магазин";
const PCT = 5;                 // комиссия партнёра, %
const PLATFORM_PCT = 30;       // комиссия платформы — как COMMISSION_PCT в routes_client.js
const N_DONE = 167, N_WORKING = 5, N_AGREED = 4;
const TARGET_EARNED = 50_000;  // Σ partner_commission_rub по done = ровно столько
const MIN_P = 1500, MAX_P = 22_000;
const DAYS = 90;
const DAY = 86_400_000;

// --- детерминированный ГСЧ (чтобы подбор сумм был воспроизводим) ---
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let R = rng(1);
const ri = (a, b) => a + Math.floor(R() * (b - a + 1));
const pick = (arr) => arr[Math.floor(R() * arr.length)];
const chance = (p) => R() < p;
const r100 = (n) => Math.round(n / 100) * 100;

// --- состав заказа по категориям (id — из src/pricing.js) ---
// кухни 12–22 тыс, шкафы/кровати 2–5 тыс, столы/стулья 1,5–3 тыс, плюс комплекты из нескольких позиций
const CATS = [
  { w: 0.15, gen: () => {                                   // кухня
      const proj = chance(0.35);
      const items = proj ? { kitchen_proj: ri(4, 6) } : { kitchen_mod: ri(6, 9) };
      const addons = [];
      if (chance(0.5)) addons.push({ id: "sink" });
      if (chance(0.4)) addons.push({ id: "cutout", qty: ri(1, 2) });
      return { items, addons };
    } },
  { w: 0.22, gen: () => {                                   // комплект: 2–3 позиции
      const pool_ = ["kupe", "shkaf", "bed", "sofa", "corner", "table", "shkaf"];
      const items = {};
      for (let i = 0, n = ri(2, 3); i < n; i++) { const id = pick(pool_); items[id] = (items[id] || 0) + 1; }
      if (chance(0.3)) items.chairs = ri(2, 4);
      const addons = [];
      if (chance(0.3)) addons.push({ id: "trash" });
      if (chance(0.2)) addons.push({ id: "demo" });
      if (chance(0.2)) addons.push({ id: "hang" });
      return { items, addons };
    } },
  { w: 0.38, gen: () => pick([                              // шкаф / кровать / диван: 2–5 тыс
      { items: { kupe: 1 }, addons: [] },
      { items: { kupe: 1 }, addons: [{ id: "trash" }] },
      { items: { shkaf: 1 }, addons: [] },
      { items: { shkaf: 1 }, addons: [{ id: "hang" }] },
      { items: { bed: 1 }, addons: [] },
      { items: { bed: 1 }, addons: [{ id: "trash" }] },
      { items: { bed: 1 }, addons: [{ id: "demo" }] },
      { items: { sofa: 1 }, addons: [] },
      { items: { corner: 1 }, addons: [] },
      { items: { shkaf: 1 }, addons: [{ id: "demo" }] },
    ]) },
  { w: 0.25, gen: () => pick([                              // стол / стулья: 1,5–3 тыс
      { items: { table: 1 }, addons: [] },
      { items: { table: 1, chairs: 2 }, addons: [] },
      { items: { table: 1, chairs: 3 }, addons: [] },
      { items: { chairs: 4 }, addons: [] },
      { items: { chairs: 3 }, addons: [] },
      { items: { table: 1 }, addons: [{ id: "hang" }] },
    ]) },
];

function genOrder() {
  for (;;) {
    let x = R(), cat = CATS[CATS.length - 1];
    for (const c of CATS) { if (x < c.w) { cat = c; break; } x -= c.w; }
    const { items, addons } = cat.gen();
    const est = calcEstimate(items, addons);
    if (est.low < MIN_P || est.low > MAX_P) continue;
    // мастер договаривается в пределах вилки калькулятора (бывает чуть ниже нижней границы)
    const lo = Math.max(MIN_P, r100(est.low * 0.9));
    const hi = Math.min(MAX_P, est.high);
    return { est, lo, hi, price: Math.min(hi, r100(est.low + R() * (est.high - est.low))) };
  }
}

// Набор done-заказов с Σ цен ровно TARGET_EARNED*100/PCT (цены кратны 100 → 5% целые).
function buildDone(seed) {
  R = rng(seed);
  const list = Array.from({ length: N_DONE }, genOrder);
  const target = (TARGET_EARNED * 100) / PCT;
  let diff = target - list.reduce((s, o) => s + o.price, 0);
  for (let guard = 0; diff !== 0 && guard < 200_000; guard++) {
    const o = list[Math.floor(R() * list.length)];
    if (diff > 0 && o.price + 100 <= o.hi) { o.price += 100; diff -= 100; }
    else if (diff < 0 && o.price - 100 >= o.lo) { o.price -= 100; diff += 100; }
  }
  return diff === 0 ? list : null;
}

const FIRST = ["Анна", "Мария", "Елена", "Ольга", "Наталья", "Татьяна", "Светлана", "Ирина", "Айта",
  "Сардана", "Туйаара", "Алексей", "Дмитрий", "Сергей", "Андрей", "Николай", "Иван", "Михаил",
  "Айсен", "Ньургун", "Владимир", "Егор", "Кюннэй", "Людмила", "Виктория", "Павел"];
const STREETS = ["пр. Ленина", "ул. Петра Алексеева", "ул. Кирова", "ул. Орджоникидзе", "ул. Лермонтова",
  "ул. Курашова", "ул. Ойунского", "пр. Михаила Николаева", "ул. Пояркова", "ул. Каландаришвили",
  "ул. Дзержинского", "ул. Короленко", "202 мкр.", "ул. Автодорожная", "ул. Чернышевского"];
const phoneFake = () => "7000" + String(randomInt(0, 10_000_000)).padStart(7, "0");
// время суток — днём по Якутску (UTC+9): 09:00–21:00 = 00:00–12:00 UTC
const dayTime = (d) => { const t = new Date(d); t.setUTCHours(ri(0, 11), ri(0, 59), ri(0, 59), 0); return t; };

async function main() {
  // подбор сумм
  let done = null, seed = 1;
  for (; seed < 500 && !done; seed++) done = buildDone(seed);
  if (!done) throw new Error("не удалось подобрать суммы — поправьте веса категорий");
  R = rng(seed + 1000);

  const now = Date.now();
  const rows = [];
  // done: равномерно по 90…3 дням назад
  done.forEach((o, i) => {
    const day = now - DAYS * DAY + ((i + R()) * (DAYS - 3) * DAY) / N_DONE;
    const created = dayTime(day);
    const done_at = new Date(Math.min(now - DAY, created.getTime() + ri(1, 3) * DAY + ri(1, 8) * 3600_000));
    rows.push({ o, status: "done", created, completed: done_at });
  });
  // активные: последние 3 дня
  for (let i = 0; i < N_WORKING + N_AGREED; i++) {
    const created = new Date(now - R() * 3 * DAY);
    if (created > now - 3600_000) created.setTime(now - ri(2, 6) * 3600_000);
    rows.push({ o: genOrder(), status: i < N_WORKING ? "working" : "agreed", created, completed: null });
  }
  rows.sort((a, b) => a.created - b.created);

  const phone = "7999" + String(randomInt(0, 10_000_000)).padStart(7, "0");
  const ABC = "abcdefghjkmnpqrstuvwxyz23456789";
  const password = Array.from({ length: 10 }, () => ABC[randomInt(0, ABC.length)]).join("");
  const nClicks = 1000 + randomInt(-15, 16);

  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const ex = await c.query(
      `SELECT (SELECT count(*) FROM partners WHERE code = $1 OR phone = $2)::int AS p,
              (SELECT count(*) FROM orders WHERE ref = $1)::int AS o`, [CODE, phone]);
    if (ex.rows[0].p || ex.rows[0].o)
      throw new Error(`демо-данные уже есть (партнёр/заказы ref=${CODE}). Сначала: node tools/demo_clear.mjs`);

    await c.query(
      `INSERT INTO partners (code, title, phone, password_hash, tier, active, commission_pct, contact_name)
       VALUES ($1,$2,$3,$4,'base',true,$5,'демо')`,
      [CODE, TITLE, phone, await hashPassword(password), PCT]);

    for (const r of rows) {
      const { est, price } = r.o;
      const isDone = r.status === "done";
      const created = r.created;
      const pref = new Date(created.getTime() + ri(0, 2) * DAY);
      await c.query(
        `INSERT INTO orders
           (created_at, name, phone, address, preferred_date, preferred_time, budget_rub,
            items, addons, calc_low, calc_high, ref, source, user_agent, status, category,
            agreed_price_rub, commission_rub, partner_commission_rub,
            contact_revealed_at, completed_at, notified_masters_at, client_notified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'demo','demo-seed',$13,'furniture',
                 $14,$15,$16,$17,$18,$1,$1)`,
        [
          created, `${pick(FIRST)} (тест)`, phoneFake(),
          `${pick(STREETS)}, д. ${ri(1, 60)}, кв. ${ri(1, 120)}`,
          pref.toISOString().slice(0, 10), pick(["утро", "день", "вечер", "10:00", "14:00", "18:00"]),
          chance(0.4) ? r100(price * (0.9 + R() * 0.3)) : null,
          JSON.stringify(est.itemsResolved), JSON.stringify(est.addonsResolved), est.low, est.high,
          CODE, r.status,
          price, Math.round((price * PLATFORM_PCT) / 100),
          isDone ? Math.round((price * PCT) / 100) : null,
          new Date(created.getTime() + ri(1, 6) * 3600_000), r.completed,
        ]);
    }

    // переходы по ссылке: равномерно по 90 дням
    for (let i = 0; i < nClicks; i++) {
      const at = new Date(now - DAYS * DAY + ((i + R()) * DAYS * DAY) / nClicks);
      await c.query(
        `INSERT INTO partner_clicks (partner_code, at, user_agent, landing_path) VALUES ($1,$2,'demo-seed',$3)`,
        [CODE, at > now ? new Date(now) : at, `/?ref=${CODE}`]);
    }

    // сверка до COMMIT: заработано ровно TARGET_EARNED
    const s = (await c.query(
      `SELECT count(*) FILTER (WHERE status='done')::int AS done,
              count(*) FILTER (WHERE status='working')::int AS working,
              count(*) FILTER (WHERE status='agreed')::int AS agreed,
              count(*) FILTER (WHERE status='open')::int AS open,
              COALESCE(sum(partner_commission_rub) FILTER (WHERE status='done'),0)::int AS earned,
              count(*) FILTER (WHERE status<>'done' AND partner_commission_rub IS NOT NULL)::int AS bad_pc,
              round(avg(agreed_price_rub))::int AS avg_check,
              min(agreed_price_rub)::int AS min_p, max(agreed_price_rub)::int AS max_p,
              count(*) FILTER (WHERE assigned_master_id IS NOT NULL)::int AS with_master
         FROM orders WHERE ref = $1`, [CODE])).rows[0];
    if (s.done !== N_DONE || s.working !== N_WORKING || s.agreed !== N_AGREED || s.open ||
        s.earned !== TARGET_EARNED || s.bad_pc || s.with_master || s.min_p < MIN_P || s.max_p > MAX_P)
      throw new Error("сверка не сошлась: " + JSON.stringify(s));

    if (process.argv.includes("--dry")) {
      await c.query("ROLLBACK");
      console.log("DRY (откатено):", JSON.stringify({ ...s, clicks: nClicks, seed: seed - 1 }));
      return;
    }
    await c.query("COMMIT");
    console.log("Готово:", JSON.stringify({ ...s, clicks: nClicks, seed: seed - 1 }));
    console.log(`\nВход в кабинет: /p\n  телефон: +${phone}\n  пароль:  ${password}\n(сохраните — больше нигде не хранится)`);
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
