// Уведомления КЛИЕНТУ в мессенджеры с аккаунта номера: WhatsApp (sborka-wa, Baileys) → MAX (sborka-max, PyMax)
// → резерв: владельцу в Telegram, чтобы дослал руками.
// Мастерам (с 2026-10-06): «новая заявка» всем подходящим мастерам и «клиент выбрал вас» — WhatsApp → MAX;
// при неудаче «новой заявки» владельца не дёргаем (иначе спам), «клиент выбрал вас» — резерв владельцу.
//
// Очередь — таблица notifications (channel='messenger', status='queued'); воркер берёт по одной строке за тик,
// после отправки переписывает channel на фактический (whatsapp | max | telegram).
//
// Правила против бана (см. задачу владельца):
//  - текст всегда адресный ({name}, {price}); первый отклик — чередуем 2–3 варианта, не шлём одинаковый подряд;
//  - без ссылок, капса и эмодзи;
//  - сообщение на КАЖДЫЙ отклик мастера, без лимита на заявку (решение владельца 2026-10-06);
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
  "{name}, на вашу заявку на Мастера14 откликнулся мастер — {price} ₽. Откройте Мастера14, чтобы посмотреть и выбрать.",
  "{name}, здравствуйте! Мастер предложил {price} ₽ за вашу сборку. Загляните на Мастера14 и выберите.",
  "{name}, по вашей заявке есть отклик — мастер {master} готов за {price} ₽. Откройте Мастера14, чтобы выбрать.",
];
const MULTI = "{name}, у вашей заявки уже несколько откликов, цены от {price} ₽. Откройте Мастера14, чтобы сравнить и выбрать.";
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
export async function deliver({ phone, text, clientId = null, ctx = "", only = null, noOwner = false }) {
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
  if (only || noOwner) return { ok: false, via: null, attempts };
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

// Новая заявка → всем активным мастерам, у кого она попадёт в ленту (те же правила района, что у
// web-push в server.js: queueNewOrderPush), независимо от push-подписки.
export async function enqueueNewOrderMasters(order, itemsText) {
  if (MODE === "off") return 0;
  const r = await q(
    `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
     SELECT 'messenger', 'master', m.id, 'order_new',
            jsonb_build_object('order_id', $1::bigint, 'items', $2::text)
       FROM masters m
      WHERE m.status = 'active'
        AND (cardinality(COALESCE(m.zones, '{}'::text[])) = 0 OR $3::text IS NULL OR $3::text = ANY(m.zones))`,
    [order.id, itemsText || "", order.district || null],
  );
  return r.rowCount;
}

// Клиент выбрал мастера → мастеру: позвонить клиенту и договориться.
export async function enqueueAssignedMaster(masterId, orderId, price) {
  if (MODE === "off") return;
  await q(
    `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
     VALUES ('messenger','master',$1,'order_assigned',jsonb_build_object('order_id',$2::bigint,'price',$3::int))`,
    [masterId, orderId, price],
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

const MASTER_NEW = "{name}, новая заявка №{id} на Мастера14: {what}. Откройте ленту заявок на Мастера14 и предложите свою цену.";
const MASTER_ASSIGNED = "{name}, клиент выбрал вас по заявке №{id} за {price} ₽. Позвоните клиенту и договоритесь о времени: {client}, +{phone}. Адрес: {address}.";

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) : "");

async function processMasterRow(n) {
  const orderId = Number(n.payload?.order_id);
  const m = (await q(`SELECT id, name, phone, status FROM masters WHERE id = $1`, [n.recipient_id])).rows[0];
  if (!m || m.status !== "active") { await setRow(n.id, "skipped", { error: "мастер не активен" }); return false; }
  const o = (await q(
    `SELECT id, status, name, phone, address, district, preferred_date, preferred_time, budget_rub, assigned_master_id
       FROM orders WHERE id = $1`, [orderId],
  )).rows[0];
  if (!o) { await setRow(n.id, "skipped", { error: "заявки нет" }); return false; }
  if (MODE === "test" && !TEST_PHONES.has(normPhone(m.phone))) {
    await setRow(n.id, "skipped", { error: "тест-режим: номер не в MESSENGER_TEST_PHONES" });
    return false;
  }

  let text;
  if (n.template === "order_new") {
    if (o.status !== "open") { await setRow(n.id, "skipped", { error: "заявка уже не в поиске" }); return false; }
    const what = [
      n.payload?.items, o.district,
      [fmtDate(o.preferred_date), o.preferred_time].filter(Boolean).join(" "),
      o.budget_rub ? `бюджет ~${rub(o.budget_rub)} ₽` : "",
    ].filter(Boolean).join(", ") || "сборка мебели";
    text = fill(MASTER_NEW, { name: firstName(m.name), id: o.id, what });
  } else if (n.template === "order_assigned") {
    if (Number(o.assigned_master_id) !== Number(m.id) || o.status !== "assigned") {
      await setRow(n.id, "skipped", { error: "заявка уже не за этим мастером" });
      return false;
    }
    text = fill(MASTER_ASSIGNED, {
      name: firstName(m.name), id: o.id, price: rub(n.payload?.price || 0),
      client: o.name || "клиент", phone: normPhone(o.phone), address: o.address || "уточните у клиента",
    });
  } else {
    await setRow(n.id, "failed", { error: "неизвестный шаблон: " + n.template });
    return false;
  }

  const d = await deliver({
    phone: normPhone(m.phone), text,
    ctx: `мастеру ${m.name} · заявка #${o.id}`,
    noOwner: n.template === "order_new",
  });
  await setRow(n.id, d.ok ? "sent" : "failed", {
    channel: d.via || "messenger",
    error: d.attempts.length ? d.attempts.join("; ") + (d.via === "telegram" ? " → владельцу" : "") : null,
    extra: { text, via: d.via },
  });
  return true;
}

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

  // Сообщение — про конкретный отклик этой строки (каждый отклик = своё сообщение, без лимитов)
  const offerId = Number(n.payload?.offer_id);
  const f = (await q(
    `SELECT f.price_rub, m.name AS master FROM offers f JOIN masters m ON m.id = f.master_id
      WHERE f.id = $1 AND f.status = 'active'`, [offerId],
  )).rows[0];
  if (!f) { await setRow(n.id, "skipped", { error: "отклик отозван" }); return false; }

  const name = firstName(o.name);
  const master = firstName(f.master);
  const variant = await pickVariant(!!master);
  const template = "offer_received";
  const text = fill(FIRST_VARIANTS[variant], { name, price: rub(f.price_rub), master });

  const d = await deliver({ phone, text, clientId: o.client_id, ctx: `заявка #${o.id} · ${o.name || "без имени"}` });
  await setRow(n.id, d.ok ? "sent" : "failed", {
    channel: d.via || "messenger",
    template,
    error: d.attempts.length ? d.attempts.join("; ") + (d.via === "telegram" ? " → владельцу" : "") : null,
    extra: { text, via: d.via, variant },
  });
  return true;
}

let busy = false;
async function drain(log) {
  if (busy || MODE === "off") return;
  busy = true;
  try {
    const rows = (await q(
      `SELECT id, recipient_type, recipient_id, template, payload FROM notifications
        WHERE channel = 'messenger' AND status = 'queued'
        ORDER BY (template = 'order_new'), created_at LIMIT 20`,
    )).rows;
    for (const n of rows) {
      try {
        if (await (n.recipient_type === "master" ? processMasterRow(n) : processRow(n))) break;  // одна отправка за тик (15с) — умеренный темп
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
