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
import { q } from "./db.js";
import { calcEstimate, ITEMS, ADDONS } from "./pricing.js";
import { notify, formatLead } from "./notify.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, "..", "public");
const UPLOAD_DIR = join(__dirname, "..", "uploads");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "";

await mkdir(UPLOAD_DIR, { recursive: true });

const app = Fastify({
  trustProxy: true, // за nginx — реальный IP из X-Forwarded-For
  logger: { level: process.env.LOG_LEVEL || "info" },
  bodyLimit: 128 * 1024,
});

await app.register(cookie);
await app.register(formbody);
await app.register(multipart, {
  limits: { fileSize: 10 * 1024 * 1024, files: 6, fields: 25 },
});

// ---- админ-доступ (Basic Auth) для служебного JSON и фото заявок ----
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

// ---- helpers ----
const clean = (s, max = 500) => (typeof s === "string" ? s.trim().slice(0, max) : "");
const PHONE_RE = /^[\d+][\d\s()\-]{5,19}$/;
const toInt = (v, max = 9_999_999) => {
  const n = Math.round(Number(String(v ?? "").replace(/[^\d.-]/g, "")));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : null;
};
const IMG_EXT = {
  "image/jpeg": ".jpg", "image/pjpeg": ".jpg", "image/png": ".png",
  "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif", "image/gif": ".gif",
};

function parseJSON(v, fallback) {
  if (v && typeof v === "object") return v;
  try { const o = JSON.parse(v); return o ?? fallback; } catch { return fallback; }
}

// order из getCalcState(): { items:[{id,nm,qty,price}], addons:[{id,nm,price,mult}], total:{low,high,mid} }
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

// Разбор multipart: текстовые поля -> объект, картинки -> файлы в uploads/.
async function readMultipart(req) {
  const fields = {};
  const photos = [];
  for await (const part of req.parts()) {
    if (part.type === "file") {
      if (part.fieldname !== "photos" || !String(part.mimetype || "").startsWith("image/")) {
        part.file.resume();
        continue;
      }
      const buf = await part.toBuffer(); // ограничено limits.fileSize
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

// ---- API ----

app.get("/api/health", async () => {
  const r = await q("SELECT 1 AS ok");
  return { ok: r.rows[0].ok === 1, ts: new Date().toISOString() };
});

app.get("/api/pricing", async () => ({ items: ITEMS, addons: ADDONS }));

// Приём заявки. Форма шлёт multipart:
//   name, phone, address, date, time, budget,
//   order = JSON(getCalcState()) = { items, addons, total },
//   photos = файлы (0..6)
// JSON-тело тоже принимается (для curl). Сумму считаем сами по src/pricing.js.
app.post("/api/lead", async (req, reply) => {
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

  const address = clean(b.address, 300) || null;
  const preferred_date = /^\d{4}-\d{2}-\d{2}$/.test(clean(b.date, 10)) ? clean(b.date, 10) : null;
  const preferred_time = /^\d{1,2}:\d{2}$/.test(clean(b.time, 8)) ? clean(b.time, 8) : null;
  const budget_rub = toInt(b.budget);
  const comment = clean(b.comment, 1000) || null;
  const ref = clean(b.ref || req.cookies?.ref, 40).toLowerCase() || null;
  const source = clean(b.source, 200) || null;

  const order = normalizeOrder(b.order);
  const est = calcEstimate(order.items, order.addons);
  const client_total = order.total.mid ?? order.total.low ?? null;

  let refValid = null;
  if (ref) {
    const p = await q("SELECT code FROM partners WHERE code = $1 AND active", [ref]);
    refValid = p.rowCount ? ref : null;
  }

  const ins = await q(
    `INSERT INTO leads
       (name, phone, address, preferred_date, preferred_time, budget_rub, comment,
        items, addons, photos, calc_low, calc_high, client_total,
        ref, source, user_agent, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      name, phone, address, preferred_date, preferred_time,
      budget_rub, comment,
      JSON.stringify(est.itemsResolved), JSON.stringify(est.addonsResolved),
      JSON.stringify(photos),
      est.low, est.high, client_total,
      refValid, source,
      clean(req.headers["user-agent"], 300) || null, req.ip || null,
    ],
  );
  const lead = ins.rows[0];

  if (
    (order.total.low != null && order.total.low !== est.low) ||
    (order.total.high != null && order.total.high !== est.high)
  ) {
    app.log.warn(
      `lead ${lead.id}: вилка фронта ${order.total.low}–${order.total.high} ≠ расчёт бэка ${est.low}–${est.high}`,
    );
  }

  // Уведомление владельцу — в фоне, ответ клиенту не задерживаем.
  notify(formatLead(lead))
    .then((res) => {
      if (res.okAny)
        q("UPDATE leads SET notified_at = now() WHERE id = $1", [lead.id]).catch(() => {});
    })
    .catch((e) => app.log.error("notify: " + e.message));

  return { ok: true, id: Number(lead.id), estimate: { low: est.low, high: est.high } };
});

// ---- Служебный JSON по заявкам (страницу /admin делает дизайн-Claude) ----
app.get("/api/admin/leads", { onRequest: app.basicAuth }, async (req) => {
  const status = clean(req.query?.status, 20);
  const params = [];
  let where = "";
  if (status) { params.push(status); where = `WHERE status = $1`; }
  const r = await q(
    `SELECT id, created_at, name, phone, address, preferred_date, preferred_time,
            budget_rub, comment, items, addons, photos, calc_low, calc_high, client_total,
            ref, status, notified_at
       FROM leads ${where}
      ORDER BY created_at DESC
      LIMIT 500`,
    params,
  );
  const counts = await q(`SELECT status, count(*)::int AS n FROM leads GROUP BY status`);
  return { leads: r.rows, counts: Object.fromEntries(counts.rows.map((x) => [x.status, x.n])) };
});

const STATUSES = new Set(["new", "in_progress", "done", "spam"]);
app.post("/api/admin/leads/:id/status", { onRequest: app.basicAuth }, async (req, reply) => {
  const id = Number(req.params.id);
  const status = clean(req.body?.status, 20);
  if (!Number.isInteger(id) || !STATUSES.has(status))
    return reply.code(400).send({ ok: false });
  await q("UPDATE leads SET status = $1 WHERE id = $2", [status, id]);
  return { ok: true };
});

// ---- Статика фронта (public/ — зона дизайн-Claude, не редактируем) ----
await app.register(fastifyStatic, {
  root: PUBLIC_DIR,
  index: ["index.html"],
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
});

// Фото заявок — только под админ-доступом.
app.get("/uploads/*", { onRequest: app.basicAuth }, (req, reply) => {
  const rel = String(req.params["*"] || "");
  if (rel.includes("..") || rel.includes("/")) return reply.code(404).send();
  return reply.sendFile(rel, UPLOAD_DIR);
});

try {
  await app.listen({ port: PORT, host: HOST });
  app.log.info(`СБОРКА веб — http://${HOST}:${PORT}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
