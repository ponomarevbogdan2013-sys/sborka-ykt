import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import "dotenv/config";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import formbody from "@fastify/formbody";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import basicAuth from "@fastify/basic-auth";
import rateLimit from "@fastify/rate-limit";
import { q } from "./db.js";
import { calcEstimate, ITEMS, ADDONS } from "./pricing.js";
import { notify, formatLead } from "./notify.js";
import { clean, toInt, normPhone, newToken, PHONE_RE } from "./util.js";
import { readSession } from "./auth.js";
import registerMasterRoutes from "./routes_master.js";
import registerClientRoutes from "./routes_client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const UPLOAD_DIR = join(__dirname, "..", "uploads");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

await mkdir(UPLOAD_DIR, { recursive: true });

const app = Fastify({
  trustProxy: true,
  logger: { level: process.env.LOG_LEVEL || "info" },
  bodyLimit: 128 * 1024,
});

await app.register(cookie);
await app.register(formbody);
await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024, files: 6, fields: 25 },
});
await app.register(rateLimit, { global: false });

await app.register(basicAuth, {
  validate: async (username, password) => {
    if (!ADMIN_PASS) throw new Error("админ отключён: не задан ADMIN_PASS");
    const ok =
      username === ADMIN_USER &&
      password.length === ADMIN_PASS.length &&
      timingSafeEqualStr(password, ADMIN_PASS);
    if (!ok) throw new Error("неверный логин или пароль");
  },
  authenticate: { realm: "sborka-admin" },
});

function timingSafeEqualStr(a, b) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

// ---- helpers (clean/toInt/normPhone/newToken/PHONE_RE — из util.js) ----
const IMG_EXT = {
  "image/jpeg": ".jpg", "image/pjpeg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif", "image/gif": ".gif",
};

function parseJSON(v, fallback) {
  if (v && typeof v === "object") return v;
  try { const o = JSON.parse(v); return o ?? fallback; } catch { return fallback; }
}

// order из getCalcState(): { items:[{id,nm,qty,price}], addons:[{id,...}], total:{low,high,mid} }
function normalizeOrder(order) {
  const o = parseJSON(order, {}) || {};
  const items = Array.isArray(o.items)
    ? o.items.map((x) => ({ id: clean(x && x.id, 40), qty: toInt(x && x.qty, 999) || 0 }))
        .filter((x) => x.id && x.qty > 0)
    : [];
  const addons = Array.isArray(o.addons)
    ? o.addons.map((x) => clean(x && (typeof x === "object" ? x.id : x), 40)).filter(Boolean)
    : [];
  const t = o.total && typeof o.total === "object" ? o.total : {};
  return { items, addons, total: { low: toInt(t.low), high: toInt(t.high), mid: toInt(t.mid) } };
}

async function readMultipart(req) {
  const fields = {};
  const photos = [];
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "photos" || !String(part.mimetype || "").startsWith("image/")) {
        part.file.resume();
        continue;
      }
      const buf = await part.toBuffer();
      if (part.file.truncated || buf.length === 0) continue;
      const ext = IMG_EXT[part.mimetype] || extname(part.filename || "").toLowerCase().slice(0, 5) || ".img";
      const name = `lead_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
      await writeFile(join(UPLOAD_DIR, name), buf);
      photos.push("/uploads/" + name);
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  return { fields, photos };
}

// ---- infra API ----
app.get("/api/health", async () => {
  const r = await q("SELECT 1 AS ok");
  return { ok: r.rows[0].ok === 1, ts: new Date().toISOString() };
});
app.get("/api/pricing", async () => ({ items: ITEMS, addons: ADDONS }));

// VAPID public key для подписки на web-push с фронта (ключ не хардкодить)
app.get("/api/push/vapid", async () => ({ publicKey: process.env.VAPID_PUBLIC_KEY || "" }));

// Подписка на web-push. Мастер/партнёр — по сессии; клиент — по token в теле.
app.post("/api/push/subscribe", async (req, reply) => {
  const b = req.body || {};
  const sub = b.subscription || {};
  const endpoint = clean(sub.endpoint, 500);
  const p256dh = clean(sub.keys && sub.keys.p256dh, 200);
  const auth = clean(sub.keys && sub.keys.auth, 200);
  if (!endpoint || !p256dh || !auth)
    return reply.code(400).send({ ok: false, error: "нет данных подписки" });

  const s = await readSession(req);
  let subType = null;
  let subId = null;
  if (s && (s.userType === "master" || s.userType === "partner")) {
    subType = s.userType;
    subId = s.userId;
  } else if (b.token) {
    const c = await q("SELECT id FROM clients WHERE token = $1 AND NOT blocked", [clean(b.token, 64)]);
    if (c.rowCount) { subType = "client"; subId = Number(c.rows[0].id); }
  }
  if (!subType) return reply.code(401).send({ ok: false, error: "не удалось определить получателя" });

  await q(
    `INSERT INTO push_subscriptions (subscriber_type, subscriber_id, endpoint, p256dh, auth, user_agent, last_ok_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (endpoint) DO UPDATE
       SET subscriber_type = EXCLUDED.subscriber_type, subscriber_id = EXCLUDED.subscriber_id,
           p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, disabled = false, fail_count = 0`,
    [subType, subId, endpoint, p256dh, auth, clean(req.headers["user-agent"], 300) || null],
  );
  return { ok: true };
});

app.post("/api/push/unsubscribe", async (req, reply) => {
  const endpoint = clean((req.body || {}).endpoint, 500);
  if (endpoint) await q("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]).catch(() => {});
  return { ok: true };
});

// Эндпоинты мастера + приглашение мастера админом
registerMasterRoutes(app);

// ---- приём заявки: создать/склеить клиента, выдать токен ----
async function createOrder(req, reply) {
  let b = {};
  let photos = [];
  if (req.isMultipart()) {
    const parsed = await readMultipart(req);
    b = parsed.fields;
    photos = parsed.photos;
  } else {
    b = req.body || {};
  }

  const name = clean(b.name, 120);
  const phone = clean(b.phone, 24);
  if (name.length < 2) return reply.code(400).send({ ok: false, error: "Укажите имя" });
  if (!PHONE_RE.test(phone))
    return reply.code(400).send({ ok: false, error: "Проверьте номер телефона" });

  const nphone = normPhone(phone);
  if (nphone.length < 10)
    return reply.code(400).send({ ok: false, error: "Проверьте номер телефона" });

  const address = clean(b.address, 300) || null;
  const district = clean(b.district, 80) || null;
  const preferred_date = /^\d{4}-\d{2}-\d{2}$/.test(clean(b.date, 10)) ? clean(b.date, 10) : null;
  const preferred_time = /^\d{1,2}:\d{2}$/.test(clean(b.time, 8)) ? clean(b.time, 8) : null;
  const budget_rub = toInt(b.budget);
  const comment = clean(b.comment, 1000) || null;
  const ref = clean(b.ref || req.cookies?.ref, 40).toLowerCase() || null;
  const source = clean(b.source, 200) || null;

  const order = normalizeOrder(b.order ?? { items: b.items, addons: b.addons, total: b.total });
  const est = calcEstimate(order.items, order.addons);
  const client_total = order.total.mid ?? order.total.low ?? null;

  let refValid = null;
  if (ref) {
    const p = await q("SELECT code FROM partners WHERE code = $1 AND active", [ref]);
    refValid = p.rowCount ? ref : null;
  }

  // клиент: склейка по нормализованному телефону, токен не меняем при повторе
  const cli = await q(
    `INSERT INTO clients (phone, name, token, ref, last_seen_at)
     VALUES ($1,$2,$3,$4, now())
     ON CONFLICT (phone) DO UPDATE
       SET name = EXCLUDED.name,
           ref = COALESCE(clients.ref, EXCLUDED.ref),
           last_seen_at = now()
     RETURNING id, token`,
    [nphone, name, newToken(), refValid],
  );
  const client = cli.rows[0];

  const ins = await q(
    `INSERT INTO orders
       (client_id, name, phone, address, district, preferred_date, preferred_time,
        budget_rub, comment, items, addons, photos, calc_low, calc_high, client_total,
        ref, source, user_agent, ip, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18,$19,'open')
     RETURNING *`,
    [
      client.id, name, phone, address, district, preferred_date, preferred_time,
      budget_rub, comment,
      JSON.stringify(est.itemsResolved), JSON.stringify(est.addonsResolved),
      JSON.stringify(photos), est.low, est.high, client_total,
      refValid, source, clean(req.headers["user-agent"], 300) || null, req.ip || null,
    ],
  );
  const row = ins.rows[0];

  await q(
    `INSERT INTO deal_events (order_id, actor_type, to_status, note)
     VALUES ($1,'client','open','заявка создана')`,
    [row.id],
  );

  if (
    (order.total.low != null && order.total.low !== est.low) ||
    (order.total.high != null && order.total.high !== est.high)
  ) {
    app.log.warn(`order ${row.id}: вилка фронта ${order.total.low}–${order.total.high} ≠ бэк ${est.low}–${est.high}`);
  }

  notify(formatLead(row))
    .then((res) => {
      if (res.okAny) q("UPDATE orders SET notified_at = now() WHERE id = $1", [row.id]).catch(() => {});
    })
    .catch((e) => app.log.error("notify: " + e.message));

  return {
    ok: true,
    id: Number(row.id),
    token: client.token,
    url: "/z/" + client.token,
    estimate: { low: est.low, high: est.high },
  };
}
app.post("/api/orders", createOrder);
app.post("/api/lead", createOrder); // алиас Этапа 1

// ---- клиент: /api/z/* (просмотр без барьера, действия — 4 цифры телефона) ----
registerClientRoutes(app);

// ---- служебный JSON по заявкам ----
async function adminOrders(req) {
  const status = clean(req.query?.status, 20);
  const params = [];
  let where = "";
  if (status) { params.push(status); where = `WHERE status = $1`; }
  const r = await q(
    `SELECT id, created_at, name, phone, district, address, preferred_date, preferred_time,
            budget_rub, comment, items, addons, photos, calc_low, calc_high, client_total,
            ref, status, assigned_master_id, agreed_price_rub, notified_at
       FROM orders ${where} ORDER BY created_at DESC LIMIT 500`,
    params,
  );
  const counts = await q(`SELECT status, count(*)::int AS n FROM orders GROUP BY status`);
  return { orders: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) };
}
app.get("/api/admin/orders", { onRequest: app.basicAuth }, adminOrders);
app.get("/api/admin/leads", { onRequest: app.basicAuth }, adminOrders); // алиас

const STATUSES = new Set(["open", "assigned", "en_route", "working", "done", "cancelled", "expired", "spam"]);
app.post("/api/admin/orders/:id/status", { onRequest: app.basicAuth }, async (req, reply) => {
  const id = Number(req.params.id);
  const status = clean(req.body?.status, 20);
  if (!Number.isInteger(id) || !STATUSES.has(status)) return reply.code(400).send({ ok: false });
  await q("UPDATE orders SET status = $1 WHERE id = $2", [status, id]);
  await q(`INSERT INTO deal_events (order_id, actor_type, to_status, note) VALUES ($1,'admin',$2,'смена статуса вручную')`, [id, status]);
  return { ok: true };
});

// ---- статика ----
await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  index: ["index.html"],
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
});
// SPA-роуты
app.get("/z/:token", (req, reply) => reply.sendFile("index.html")); // клиент
app.get("/m", (req, reply) => reply.sendFile("m.html"));            // мастер
app.get("/m/*", (req, reply) => reply.sendFile("m.html"));

// index.html / m.html ссылаются на css/*, js/* относительными путями.
// На /z/<token> и /m/<x> (глубина пути) они не резолвятся к корню — отдаём их и по префиксу.
const safe = (f) => String(f || "").replace(/[^\w.\-]/g, "");
for (const pfx of ["/z", "/m"]) {
  app.get(`${pfx}/js/:f`, (req, reply) => reply.sendFile("js/" + safe(req.params.f)));
  app.get(`${pfx}/css/:f`, (req, reply) => reply.sendFile("css/" + safe(req.params.f)));
}

// Публичные медиа мастеров (аватар, портфолио)
app.get("/uploads/pub/*", (req, reply) => {
  const rel = String(req.params["*"] || "");
  if (rel.includes("..") || rel.includes("/")) return reply.code(404).send();
  return reply.sendFile(rel, join(UPLOAD_DIR, "pub"));
});
// Всё остальное (фото заказов, документы) — только под админ-доступом
app.get("/uploads/*", { onRequest: app.basicAuth }, (req, reply) => {
  const rel = String(req.params["*"] || "");
  if (rel.includes("..")) return reply.code(404).send();
  return reply.sendFile(rel, UPLOAD_DIR);
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`СБОРКА веб — http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
