// Уведомления КЛИЕНТУ в мессенджеры с аккаунта номера: WhatsApp (sborka-wa, Baileys) → MAX (sborka-max, PyMax)
// → резерв: владельцу в Telegram, чтобы дослал руками. Мастерам сюда не шлём (у них web-push).
//
// Очередь — таблица notifications (channel='messenger', status='queued'); воркер берёт по одной строке за тик,
// после отправки переписывает channel на фактический (whatsapp | max | telegram).
//
// Правила против бана (см. задачу владельца):
//  - текст всегда адресный ({name}, {price}); первый отклик — чередуем 2–3 варианта, не шлём одинаковый подряд;
//  - без ссылок, капса и эмодзи;
//  - на заявку максимум 2 сообщения: «первый отклик» и один раз «уже несколько откликов» (не раньше
//    MESSENGER_MULTI_DELAY_MIN после первого); остальные отклики — молча (клиенту идёт web-push);
//  - сами сервисы шлют строго по одному с паузой MESSENGER_MIN_GAP_SEC.
//
// Режим MESSENGER_MODE: off — ничего не шлём; test — только на номера из MESSENGER_TEST_PHONES; live — всем.
import QRCode from "qrcode";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { q } from "./db.js";
import { notify } from "./notify.js";
import { normPhone, clean } from "./util.js";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "messenger_page.html");

const MODE = ["off", "test", "live"].includes(process.env.MESSENGER_MODE) ? process.env.MESSENGER_MODE : "off";
const TEST_PHONES = new Set(
  String(process.env.MESSENGER_TEST_PHONES || "").split(/[,\s]+/).map(normPhone).filter((p) => p.length >= 11),
);
const TOKEN = process.env.MESSENGER_INTERNAL_TOKEN || "";
const MULTI_DELAY_MS = Number(process.env.MESSENGER_MULTI_DELAY_MIN || 60) * 60_000;
const SERVICES = {
  whatsapp: `http://127.0.0.1:${process.env.WA_PORT || 3101}`,
  max: `http://127.0.0.1:${process.env.MAX_PORT || 3102}`,
};
const CH_ORDER = ["whatsapp", "max"];
const CH_NAME = { whatsapp: "WhatsApp", max: "MAX" };

export const messengerMode = () => MODE;

// ---------- тексты ----------
const rub = (n) => Number(n).toLocaleString("ru-RU");
// Первое слово имени с заглавной: «иван петров» → «Иван».
const firstName = (s) => {
  const w = String(s || "").trim().split(/\s+/)[0] || "";
  return w ? w[0].toUpperCase() + w.slice(1) : "";
};
// Без имени убираем «{name}, » в начале и поднимаем первую букву.
function fill(tpl, v) {
  let t = tpl;
  if (!v.name) t = t.replace(/^\{name\},\s*/, "");
  t = t.replace(/\{(\w+)\}/g, (_, k) => (v[k] == null ? "" : String(v[k])));
  return t[0].toUpperCase() + t.slice(1);
}

const FIRST_VARIANTS = [
  "{name}, на вашу заявку в СБОРКЕ откликнулся мастер — {price} ₽. Откройте СБОРКУ, чтобы посмотреть и выбрать.",
  "{name}, здравствуйте! Мастер предложил {price} ₽ за вашу сборку. Загляните в СБОРКУ и выберите.",
  "{name}, по вашей заявке есть отклик — мастер {master} готов за {price} ₽. Откройте СБОРКУ, чтобы выбрать.",
];
const MULTI = "{name}, у вашей заявки уже несколько откликов, цены от {price} ₽. Откройте СБОРКУ, чтобы сравнить и выбрать.";
const OPTIN = "{name}, канал подключён. Сюда сообщим, как только мастер откликнётся на вашу заявку.";

// Вариант первого отклика: случайный, но не тот, что ушёл последним; 3-й — только если известно имя мастера.
async function pickVariant(hasMaster) {
  const r = await q(
    `SELECT (payload->>'variant')::int AS v FROM notifications
      WHERE template IN ('offer_received','test_first') AND payload ? 'variant'
      ORDER BY id DESC LIMIT 1`,
  );
  const last = r.rows[0]?.v;
  const pool = [0, 1, 2].filter((i) => (hasMaster || i !== 2) && i !== last);
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---------- вызов сервисов ----------
async function callService(ch, path, body, timeoutMs = 90_000) {
  try {
    const res = await fetch(SERVICES[ch] + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-internal-token": TOKEN },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json();
  } catch (e) {
    return { ok: false, code: "service_down", error: `сервис ${CH_NAME[ch]} недоступен (${e.message})` };
  }
}

// Шлём клиенту: сначала каналы, куда он сам нам писал, потом WhatsApp → MAX; не вышло — владельцу в Telegram.
// only: 'whatsapp' | 'max' — строго один канал (тест из админки), без резерва.
export async function deliver({ phone, text, clientId = null, ctx = "", only = null }) {
  let order = CH_ORDER;
  if (only) order = [only];
  else if (clientId) {
    const opted = (await q(`SELECT channel FROM client_channels WHERE client_id = $1 ORDER BY opted_in_at`, [clientId]))
      .rows.map((r) => r.channel);
    order = [...opted, ...CH_ORDER.filter((c) => !opted.includes(c))];
  }
  const attempts = [];
  for (const ch of order) {
    const r = await callService(ch, "/send", { phone, text });
    if (r.ok) return { ok: true, via: ch, attempts };
    attempts.push(`${CH_NAME[ch]}: ${r.error || r.code || "ошибка"}`);
  }
  if (only) return { ok: false, via: null, attempts };
  const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tg = await notify(
    `⚠️ <b>Клиенту не доставлено — дошлите вручную</b>\n${esc(ctx)}\nТелефон: <a href="tel:+${esc(phone)}">+${esc(phone)}</a>\n` +
    `${attempts.map(esc).join("\n")}\n\n<b>Текст:</b>\n${esc(text)}`,
  );
  return { ok: tg.okAny, via: "telegram", attempts };
}

// ---------- постановка в очередь (из обработчика отклика) ----------
export async function enqueueOfferMessage(clientId, orderId, offerId, price) {
  if (MODE === "off") return;
  await q(
    `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
     VALUES ('messenger','client',$1,'offer_received',
             jsonb_build_object('order_id',$2::bigint,'offer_id',$3::bigint,'price',$4::int))`,
    [clientId, orderId, offerId, price],
  );
}

// ---------- воркер ----------
const setRow = (id, status, fields = {}) =>
  q(
    `UPDATE notifications
        SET status = $2, sent_at = now(), error = $3,
            channel = COALESCE($4, channel), template = COALESCE($5, template),
            payload = payload || $6::jsonb
      WHERE id = $1`,
    [id, status, fields.error ?? null, fields.channel ?? null, fields.template ?? null, JSON.stringify(fields.extra || {})],
  );

// Обработка одной строки. Возвращает true, если была попытка отправки (тогда в этот тик больше не шлём).
async function processRow(n) {
  const orderId = Number(n.payload?.order_id);
  const o = (await q(`SELECT id, status, name, phone, client_id FROM orders WHERE id = $1`, [orderId])).rows[0];
  if (!o || o.status !== "open") { await setRow(n.id, "skipped", { error: "заявка уже не в поиске" }); return false; }

  const phone = normPhone(o.phone);
  if (MODE === "off") { await setRow(n.id, "skipped", { error: "MESSENGER_MODE=off" }); return false; }
  if (MODE === "test" && !TEST_PHONES.has(phone)) {
    await setRow(n.id, "skipped", { error: "тест-режим: номер не в MESSENGER_TEST_PHONES" });
    return false;
  }

  const offers = (await q(
    `SELECT f.price_rub, m.name AS master FROM offers f JOIN masters m ON m.id = f.master_id
      WHERE f.order_id = $1 AND f.status = 'active' ORDER BY f.created_at`, [orderId],
  )).rows;
  if (!offers.length) { await setRow(n.id, "skipped", { error: "активных откликов нет (отозван)" }); return false; }

  const prev = (await q(
    `SELECT count(*)::int AS cnt, max(sent_at) AS last FROM notifications
      WHERE recipient_type = 'client' AND status = 'sent' AND channel IN ('whatsapp','max','telegram')
        AND template IN ('offer_received','offer_multi') AND payload->>'order_id' = $1`, [String(orderId)],
  )).rows[0];

  let template, text, variant = null;
  const name = firstName(o.name);
  const minPrice = Math.min(...offers.map((f) => f.price_rub));
  if (prev.cnt >= 2) { await setRow(n.id, "skipped", { error: "лимит: 2 сообщения на заявку" }); return false; }
  if (prev.cnt === 1) {
    if (offers.length < 2) { await setRow(n.id, "skipped", { error: "уже сообщали, новых мастеров нет" }); return false; }
    if (Date.now() - new Date(prev.last).getTime() < MULTI_DELAY_MS) return false;  // не частим — ждём
    template = "offer_multi";
    text = fill(MULTI, { name, price: rub(minPrice) });
  } else if (offers.length >= 2) {
    template = "offer_multi";  // пока ждали очереди, набралось несколько — одно сообщение про все
    text = fill(MULTI, { name, price: rub(minPrice) });
  } else {
    const master = firstName(offers[0].master);
    variant = await pickVariant(!!master);
    template = "offer_received";
    text = fill(FIRST_VARIANTS[variant], { name, price: rub(offers[0].price_rub), master });
  }

  const d = await deliver({ phone, text, clientId: o.client_id, ctx: `заявка #${o.id} · ${o.name || "без имени"}` });
  await setRow(n.id, d.ok ? "sent" : "failed", {
    channel: d.via || "messenger",
    template,
    error: d.attempts.length ? d.attempts.join("; ") + (d.via === "telegram" ? " → владельцу" : "") : null,
    extra: { text, via: d.via, ...(variant != null ? { variant } : {}) },
  });
  // Остальные отклики этой заявки в очереди уже учтены этим сообщением
  await q(
    `UPDATE notifications SET status = 'skipped', sent_at = now(), error = $2
      WHERE channel = 'messenger' AND status = 'queued' AND payload->>'order_id' = $1 AND id <> $3`,
    [String(orderId), `объединено с #${n.id}`, n.id],
  );
  return true;
}

let busy = false;
async function drain(log) {
  if (busy || MODE === "off") return;
  busy = true;
  try {
    const rows = (await q(
      `SELECT id, payload FROM notifications WHERE channel = 'messenger' AND status = 'queued'
        ORDER BY created_at LIMIT 20`,
    )).rows;
    for (const n of rows) {
      try {
        if (await processRow(n)) break;  // одна отправка за тик (15с) — умеренный темп
      } catch (e) {
        log.error(`мессенджеры, строка #${n.id}: ${e.message}`);
        await setRow(n.id, "failed", { error: e.message }).catch(() => {});
      }
    }
  } catch (e) {
    log.error("воркер мессенджеров: " + e.message);
  } finally {
    busy = false;
  }
}

// ---------- маршруты ----------
export default function registerMessengerRoutes(app) {
  if (MODE !== "off") {
    const t = setInterval(() => drain(app.log).catch(() => {}), 15_000);
    t.unref?.();
    app.log.info(`мессенджеры: режим ${MODE}` + (MODE === "test" ? `, тест-номера: ${[...TEST_PHONES].join(", ") || "нет"}` : ""));
  }

  // Входящее от сервиса (клиент сам написал нам) → опт-ин: запоминаем канал и отвечаем один раз.
  app.post("/api/internal/messenger/incoming", async (req, reply) => {
    if (!TOKEN || req.headers["x-internal-token"] !== TOKEN) return reply.code(403).send({ ok: false });
    const b = req.body || {};
    const channel = b.channel === "max" ? "max" : b.channel === "whatsapp" ? "whatsapp" : null;
    const phone = normPhone(b.phone);
    if (!channel || phone.length < 11) return { ok: false };
    const c = (await q(`SELECT id, name FROM clients WHERE phone = $1`, [phone])).rows[0];
    if (!c) return { ok: true, known: false };
    const ins = await q(
      `INSERT INTO client_channels (client_id, channel) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING client_id`,
      [c.id, channel],
    );
    if (!ins.rowCount || MODE === "off" || (MODE === "test" && !TEST_PHONES.has(phone))) return { ok: true, known: true };
    (async () => {
      const text = fill(OPTIN, { name: firstName(c.name) });
      const d = await deliver({ phone, text, only: channel });
      await q(
        `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload, status, sent_at, error)
         VALUES ($1,'client',$2,'optin',$3,$4,now(),$5)`,
        [channel, c.id, { text }, d.ok ? "sent" : "failed", d.ok ? null : d.attempts.join("; ")],
      );
    })().catch((e) => app.log.error("опт-ин: " + e.message));
    return { ok: true, known: true, optin: true };
  });

  // ----- админка: подключение номеров и тест -----
  const auth = { onRequest: app.basicAuth };

  app.get("/admin/messenger", auth, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(await readFile(PAGE, "utf8"));
  });

  app.get("/api/admin/messenger/status", auth, async () => {
    const [wa, mx] = await Promise.all([callService("whatsapp", "/status", undefined, 5000), callService("max", "/status", undefined, 5000)]);
    if (wa.qr) wa.qr_img = await QRCode.toDataURL(wa.qr, { margin: 1, width: 300 });
    delete wa.qr;
    const queue = (await q(
      `SELECT status, count(*)::int AS n FROM notifications WHERE recipient_type = 'client'
         AND template IN ('offer_received','offer_multi','optin') AND created_at > now() - interval '7 days'
       GROUP BY status`,
    )).rows;
    return { ok: true, mode: MODE, test_phones: [...TEST_PHONES], whatsapp: wa, max: mx, week: queue };
  });

  app.post("/api/admin/messenger/whatsapp/login", auth, async () => callService("whatsapp", "/login", {}));
  app.post("/api/admin/messenger/whatsapp/logout", auth, async () => callService("whatsapp", "/logout", {}));
  app.post("/api/admin/messenger/max/login", auth, async (req) => callService("max", "/login", { phone: normPhone(req.body?.phone) }, 30_000));
  app.post("/api/admin/messenger/max/code", auth, async (req) => callService("max", "/code", { code: clean(req.body?.code, 12) }, 30_000));
  app.post("/api/admin/messenger/max/password", auth, async (req) => callService("max", "/password", { password: clean(req.body?.password, 200) }, 30_000));
  app.post("/api/admin/messenger/max/logout", auth, async () => callService("max", "/logout", {}));

  // Тестовая отправка: kind first|multi|optin, channel auto (с резервом владельцу) | whatsapp | max.
  app.post("/api/admin/messenger/test", auth, async (req, reply) => {
    const b = req.body || {};
    const phone = normPhone(b.phone);
    if (phone.length < 11) return reply.code(400).send({ ok: false, error: "укажите номер" });
    const name = firstName(b.name) || "Богдан";
    const kind = ["first", "multi", "optin"].includes(b.kind) ? b.kind : "first";
    let text, variant = null;
    if (kind === "multi") text = fill(MULTI, { name, price: rub(4500) });
    else if (kind === "optin") text = fill(OPTIN, { name });
    else {
      variant = await pickVariant(true);
      text = fill(FIRST_VARIANTS[variant], { name, price: rub(5000), master: "Алексей" });
    }
    const only = b.channel === "whatsapp" || b.channel === "max" ? b.channel : null;
    const d = await deliver({ phone, text, only, ctx: "ТЕСТ из админки" });
    await q(
      `INSERT INTO notifications (channel, recipient_type, template, payload, status, sent_at, error)
       VALUES ($1,'test',$2,$3,$4,now(),$5)`,
      [d.via || only || "messenger", "test_" + kind, { phone, text, ...(variant != null ? { variant } : {}) }, d.ok ? "sent" : "failed", d.attempts.join("; ") || null],
    );
    return { ok: d.ok, via: d.via, attempts: d.attempts, text };
  });
}
