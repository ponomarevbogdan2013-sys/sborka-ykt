// Эндпоинты мастера (/api/master/*) + приглашение мастера админом.
// Клиент мастера (m.html + m.js) — зона дизайн-Claude. Контракт полей — как в public/js/m.js.
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { q } from "./db.js";
import { clean, toInt, normPhone, newToken, PHONE_RE } from "./util.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSidCookie, clearSidCookie, requireRole, SID_COOKIE,
} from "./auth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = join(__dirname, "..", "uploads");
const PUB_DIR = join(UPLOAD_DIR, "pub");   // публичные (аватар, портфолио)
const DOC_DIR = join(UPLOAD_DIR, "docs");  // под админ-доступом (документы)

const requireMaster = requireRole("master");
const RL_LOGIN = { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } };

const EXT = {
  "image/jpeg": ".jpg", "image/pjpeg": ".jpg", "image/png": ".png", "image/webp": ".webp",
  "image/heic": ".heic", "image/heif": ".heif", "image/gif": ".gif", "application/pdf": ".pdf",
};

// Сохранить файлы из multipart-запроса. accept: 'image' | 'imagepdf'. Возвращает [{url,mime,bytes}].
async function saveFiles(req, { field, dir, urlPrefix, accept, max = 6, prefix = "f" }) {
  await mkdir(dir, { recursive: true });
  const out = [];
  for await (const part of req.parts()) {
    if (part.type !== "file") continue;
    if (part.fieldname !== field || out.length >= max) { part.file.resume(); continue; }
    const mime = String(part.mimetype || "");
    const okImg = mime.startsWith("image/");
    const okPdf = accept === "imagepdf" && mime === "application/pdf";
    if (!okImg && !okPdf) { part.file.resume(); continue; }
    const buf = await part.toBuffer();
    if (part.file.truncated || buf.length === 0) continue;
    const ext = EXT[mime] || extname(part.filename || "").toLowerCase().slice(0, 5) || ".bin";
    const name = `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}${ext}`;
    await writeFile(join(dir, name), buf);
    out.push({ url: urlPrefix + name, mime, bytes: buf.length });
  }
  return out;
}

// плоский профиль мастера — как ждёт m.js onMe()
async function mePayload(id) {
  const m = (await q(`SELECT * FROM masters WHERE id = $1`, [id])).rows[0];
  if (!m) return null;
  const cats = (await q(`SELECT category FROM master_categories WHERE master_id = $1 ORDER BY category`, [id]))
    .rows.map((x) => x.category);
  const portfolio = (await q(
    `SELECT photo_url FROM portfolio_items WHERE master_id = $1 ORDER BY sort, id`, [id],
  )).rows;
  const docs = (await q(`SELECT count(*)::int AS n FROM master_documents WHERE master_id = $1`, [id])).rows[0].n;
  return {
    ok: true,
    id: Number(m.id),
    name: m.name,
    phone: m.phone,
    about: m.about,
    experience_years: m.experience_years,
    zones: m.zones || [],
    categories: cats,
    has_tools: m.has_tools,
    has_car: m.has_car,
    self_employed: m.self_employed,
    status: m.status,
    verified: m.verified,
    photo_url: m.photo_url,
    portfolio,
    documents_count: docs,
  };
}

const STEPS = ["assigned", "en_route", "working", "done"];
const itemsShort = (arr) => (Array.isArray(arr) ? arr.map((i) => ({ nm: i.nm, qty: i.qty })) : []);

export default function registerMasterRoutes(app) {
  // ============ АДМИН: пригласить / список / верификация / статус ============
  app.post("/api/admin/masters/invite", { onRequest: app.basicAuth }, async (req, reply) => {
    const b = req.body || {};
    const name = clean(b.name, 120);
    const phoneRaw = clean(b.phone, 24);
    if (name.length < 2) return reply.code(400).send({ ok: false, error: "укажите имя" });
    if (!PHONE_RE.test(phoneRaw)) return reply.code(400).send({ ok: false, error: "проверьте телефон" });
    const phone = normPhone(phoneRaw);
    if (phone.length < 10) return reply.code(400).send({ ok: false, error: "проверьте телефон" });

    const ex = await q(`SELECT id, status FROM masters WHERE phone = $1`, [phone]);
    if (ex.rowCount)
      return reply.code(409).send({ ok: false, error: `мастер уже есть (id ${ex.rows[0].id}, ${ex.rows[0].status})` });

    const invite = newToken(18);
    const ins = await q(
      `INSERT INTO masters (phone, name, invite_token, status)
       VALUES ($1,$2,$3,'invited') RETURNING id, invite_token`,
      [phone, name, invite],
    );
    return {
      ok: true,
      master_id: Number(ins.rows[0].id),
      invite_token: ins.rows[0].invite_token,
      invite_url: "/m?invite=" + ins.rows[0].invite_token,
    };
  });

  app.get("/api/admin/masters", { onRequest: app.basicAuth }, async (req) => {
    const status = clean(req.query?.status, 20);
    const params = [];
    let where = "";
    if (status) { params.push(status); where = "WHERE status = $1"; }
    const r = await q(
      `SELECT id, created_at, phone, name, status, verified, verified_at,
              rating_avg, rating_count, orders_done,
              (invite_token IS NOT NULL) AS invite_pending,
              (SELECT count(*)::int FROM master_documents d WHERE d.master_id = m.id) AS documents_count
         FROM masters m ${where} ORDER BY created_at DESC LIMIT 500`,
      params,
    );
    return { masters: r.rows };
  });

  app.get("/api/admin/masters/:id/documents", { onRequest: app.basicAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ ok: false });
    const r = await q(
      `SELECT id, kind, file_url, status, reviewed_at, created_at
         FROM master_documents WHERE master_id = $1 ORDER BY created_at DESC`, [id],
    );
    return { documents: r.rows };
  });

  app.post("/api/admin/masters/:id/verify", { onRequest: app.basicAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ ok: false });
    const verified = !!(req.body && req.body.verified);
    await q(
      `UPDATE masters SET verified = $1, verified_at = CASE WHEN $1 THEN now() ELSE NULL END WHERE id = $2`,
      [verified, id],
    );
    if (req.body && Array.isArray(req.body.document_ids)) {
      await q(`UPDATE master_documents SET status='accepted', reviewed_at=now() WHERE master_id=$1`, [id]).catch(() => {});
    }
    return { ok: true, id, verified };
  });

  app.post("/api/admin/masters/:id/status", { onRequest: app.basicAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    const status = clean(req.body?.status, 20);
    if (!Number.isInteger(id) || !["active", "suspended"].includes(status))
      return reply.code(400).send({ ok: false, error: "status: active|suspended" });
    await q(`UPDATE masters SET status = $1 WHERE id = $2`, [status, id]);
    return { ok: true, id, status };
  });

  // ============ МАСТЕР: активация / вход / выход ============
  app.post("/api/master/activate", RL_LOGIN, async (req, reply) => {
    const b = req.body || {};
    const invite = clean(b.invite_token, 64);
    const password = String(b.password || "");
    if (password.length < 6) return reply.code(400).send({ ok: false, error: "пароль от 6 символов" });

    const r = await q(`SELECT id FROM masters WHERE invite_token = $1 AND status = 'invited'`, [invite]);
    if (!r.rowCount) return reply.code(400).send({ ok: false, error: "приглашение недействительно или уже использовано" });
    const mid = Number(r.rows[0].id);

    await q(
      `UPDATE masters SET password_hash = $1, status = 'active', invite_token = NULL, last_seen_at = now()
        WHERE id = $2`,
      [await hashPassword(password), mid],
    );
    const sess = await createSession("master", mid, req);
    setSidCookie(reply, sess.token, sess.expires);
    return { ok: true };
  });

  app.post("/api/master/login", RL_LOGIN, async (req, reply) => {
    const b = req.body || {};
    const phone = normPhone(clean(b.phone, 24));
    const password = String(b.password || "");
    const r = await q(`SELECT id, password_hash, status FROM masters WHERE phone = $1`, [phone]);
    if (!r.rowCount || !r.rows[0].password_hash)
      return reply.code(401).send({ ok: false, error: "неверный телефон или пароль" });
    const m = r.rows[0];
    if (m.status === "invited")
      return reply.code(403).send({ ok: false, error: "активируйте аккаунт по ссылке-приглашению" });
    if (m.status === "suspended")
      return reply.code(403).send({ ok: false, error: "аккаунт заблокирован" });
    if (!(await verifyPassword(password, m.password_hash)))
      return reply.code(401).send({ ok: false, error: "неверный телефон или пароль" });

    await q(`UPDATE masters SET last_seen_at = now() WHERE id = $1`, [m.id]);
    const sess = await createSession("master", Number(m.id), req);
    setSidCookie(reply, sess.token, sess.expires);
    return { ok: true };
  });

  app.post("/api/master/logout", async (req, reply) => {
    await destroySession(req.cookies?.[SID_COOKIE]);
    clearSidCookie(reply);
    return { ok: true };
  });

  // ============ МАСТЕР: профиль ============
  app.get("/api/master/me", { preHandler: requireMaster }, async (req, reply) => {
    const p = await mePayload(req.user.userId);
    if (!p) return reply.code(404).send({ ok: false });
    return p;
  });

  app.put("/api/master/profile", { preHandler: requireMaster }, async (req) => {
    const b = req.body || {};
    const id = req.user.userId;
    const name = clean(b.name, 120);
    const about = clean(b.about, 1000);
    const experience_years = toInt(b.experience_years, 70);
    const zones = Array.isArray(b.zones) ? b.zones.map((z) => clean(z, 60)).filter(Boolean).slice(0, 25) : null;
    const has_tools = b.has_tools == null ? null : !!b.has_tools;
    const has_car = b.has_car == null ? null : !!b.has_car;
    const self_employed = ["none", "self_employed", "ie"].includes(b.self_employed) ? b.self_employed : null;

    await q(
      `UPDATE masters SET
         name = CASE WHEN $2 <> '' THEN $2 ELSE name END,
         about = $3,
         experience_years = COALESCE($4, experience_years),
         zones = COALESCE($5, zones),
         has_tools = COALESCE($6, has_tools),
         has_car = COALESCE($7, has_car),
         self_employed = COALESCE($8, self_employed)
       WHERE id = $1`,
      [id, name, about || null, experience_years, zones, has_tools, has_car, self_employed],
    );

    if (Array.isArray(b.categories)) {
      const valid = (await q(`SELECT code FROM service_categories WHERE active`)).rows.map((x) => x.code);
      const keep = b.categories.map((c) => clean(c, 40)).filter((c) => valid.includes(c));
      await q(`DELETE FROM master_categories WHERE master_id = $1`, [id]);
      for (const c of keep)
        await q(`INSERT INTO master_categories (master_id, category) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, c]);
    }
    return await mePayload(id);
  });

  app.post("/api/master/photo", { preHandler: requireMaster }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ ok: false });
    const files = await saveFiles(req, {
      field: "photo", dir: PUB_DIR, urlPrefix: "/uploads/pub/", accept: "image", max: 1, prefix: `m${req.user.userId}av`,
    });
    if (!files.length) return reply.code(400).send({ ok: false, error: "нет файла" });
    await q(`UPDATE masters SET photo_url = $1 WHERE id = $2`, [files[0].url, req.user.userId]);
    await q(`INSERT INTO media (owner_type, owner_id, kind, url, mime, bytes) VALUES ('master',$1,'avatar',$2,$3,$4)`,
      [req.user.userId, files[0].url, files[0].mime, files[0].bytes]).catch(() => {});
    return { ok: true, photo_url: files[0].url };
  });

  app.post("/api/master/portfolio", { preHandler: requireMaster }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ ok: false });
    const files = await saveFiles(req, {
      field: "photos", dir: PUB_DIR, urlPrefix: "/uploads/pub/", accept: "image", max: 12, prefix: `m${req.user.userId}pf`,
    });
    for (const f of files) {
      await q(`INSERT INTO portfolio_items (master_id, photo_url) VALUES ($1,$2)`, [req.user.userId, f.url]);
      await q(`INSERT INTO media (owner_type, owner_id, kind, url, mime, bytes) VALUES ('master',$1,'portfolio',$2,$3,$4)`,
        [req.user.userId, f.url, f.mime, f.bytes]).catch(() => {});
    }
    return { ok: true, added: files.length };
  });

  app.delete("/api/master/portfolio/:pid", { preHandler: requireMaster }, async (req, reply) => {
    const pid = Number(req.params.pid);
    if (!Number.isInteger(pid)) return reply.code(400).send({ ok: false });
    await q(`DELETE FROM portfolio_items WHERE id = $1 AND master_id = $2`, [pid, req.user.userId]);
    return { ok: true };
  });

  app.post("/api/master/documents", { preHandler: requireMaster }, async (req, reply) => {
    if (!req.isMultipart()) return reply.code(400).send({ ok: false });
    const files = await saveFiles(req, {
      field: "docs", dir: DOC_DIR, urlPrefix: "/uploads/docs/", accept: "imagepdf", max: 6, prefix: `m${req.user.userId}doc`,
    });
    for (const f of files) {
      await q(`INSERT INTO master_documents (master_id, kind, file_url, status) VALUES ($1,'document',$2,'pending')`,
        [req.user.userId, f.url]);
    }
    return { ok: true, added: files.length };
  });

  // ============ МАСТЕР: лента заявок ============
  app.get("/api/master/feed", { preHandler: requireMaster }, async (req) => {
    const id = req.user.userId;
    const m = (await q(`SELECT status, zones FROM masters WHERE id = $1`, [id])).rows[0];
    if (!m || m.status !== "active") return { ok: true, orders: [], note: "аккаунт неактивен" };
    const cats = (await q(`SELECT category FROM master_categories WHERE master_id = $1`, [id])).rows.map((x) => x.category);
    if (!cats.length) return { ok: true, orders: [], note: "укажите категории в анкете" };

    const limit = Math.min(50, Math.max(1, toInt(req.query?.limit, 50) || 30));
    const offset = Math.max(0, toInt(req.query?.offset, 100000) || 0);
    const zones = m.zones || [];

    const r = await q(
      `SELECT o.id, o.district,
              to_char(o.preferred_date, 'YYYY-MM-DD') AS preferred_date,
              o.preferred_time, o.budget_rub, o.comment, o.items,
              COALESCE(jsonb_array_length(o.photos), 0) AS photos_count,
              mo.price_rub AS mo_price, mo.note AS mo_note, mo.status AS mo_status
         FROM orders o
         LEFT JOIN offers mo ON mo.order_id = o.id AND mo.master_id = $1
        WHERE o.status = 'open'
          AND o.category = ANY($2)
          AND (cardinality($3::text[]) = 0 OR o.district IS NULL OR o.district = ANY($3))
        ORDER BY o.created_at DESC
        LIMIT $4 OFFSET $5`,
      [id, cats, zones, limit, offset],
    );
    return {
      ok: true,
      orders: r.rows.map((o) => ({
        id: Number(o.id),
        district: o.district,
        preferred_date: o.preferred_date,
        preferred_time: o.preferred_time,
        budget_rub: o.budget_rub,
        comment: o.comment,
        items: itemsShort(o.items),
        photos_count: o.photos_count,
        my_offer: o.mo_price != null && o.mo_status === "active"
          ? { price_rub: o.mo_price, note: o.mo_note } : null,
      })),
    };
  });

  // карточка заказа (контакты/адрес — только назначенному)
  app.get("/api/master/orders/:id", { preHandler: requireMaster }, async (req, reply) => {
    const oid = Number(req.params.id);
    if (!Number.isInteger(oid)) return reply.code(400).send({ ok: false });
    const o = (await q(`SELECT * FROM orders WHERE id = $1`, [oid])).rows[0];
    if (!o) return reply.code(404).send({ ok: false });
    const mine = Number(o.assigned_master_id) === req.user.userId;
    const base = {
      id: Number(o.id), status: o.status, district: o.district, category: o.category,
      preferred_date: o.preferred_date ? String(o.preferred_date).slice(0, 10) : null,
      preferred_time: o.preferred_time, budget_rub: o.budget_rub,
      calc_low: o.calc_low, calc_high: o.calc_high,
      items: itemsShort(o.items), addons: o.addons, comment: o.comment,
      photos_count: Array.isArray(o.photos) ? o.photos.length : 0,
      contact_revealed: mine,
    };
    if (mine) { base.name = o.name; base.phone = o.phone; base.address = o.address; }
    const myOffer = (await q(
      `SELECT id, price_rub, can_start_at, note, status FROM offers WHERE order_id = $1 AND master_id = $2`,
      [oid, req.user.userId],
    )).rows[0] || null;
    return { ok: true, order: base, my_offer: myOffer };
  });

  // ============ МАСТЕР: отклик ============
  app.post("/api/master/orders/:id/offer", { preHandler: requireMaster }, async (req, reply) => {
    const oid = Number(req.params.id);
    const b = req.body || {};
    const price = toInt(b.price_rub);
    if (!Number.isInteger(oid) || !price || price < 100)
      return reply.code(400).send({ ok: false, error: "укажите цену" });
    const note = clean(b.note, 300) || null;
    let can_start_at = null;
    if (b.can_start_at) {
      const d = new Date(b.can_start_at);
      if (!isNaN(d)) can_start_at = d.toISOString();
    }
    const o = (await q(`SELECT id, status, client_id FROM orders WHERE id = $1`, [oid])).rows[0];
    if (!o) return reply.code(404).send({ ok: false });
    if (o.status !== "open") return reply.code(409).send({ ok: false, error: "заказ уже не принимает отклики" });

    const r = await q(
      `INSERT INTO offers (order_id, master_id, price_rub, can_start_at, note, status)
       VALUES ($1,$2,$3,$4,$5,'active')
       ON CONFLICT (order_id, master_id) DO UPDATE
         SET price_rub = EXCLUDED.price_rub, can_start_at = EXCLUDED.can_start_at,
             note = EXCLUDED.note, status = 'active', created_at = now()
       RETURNING *`,
      [oid, req.user.userId, price, can_start_at, note],
    );
    await q(`INSERT INTO deal_events (order_id, actor_type, actor_id, note) VALUES ($1,'master',$2,$3)`,
      [oid, req.user.userId, `отклик: ${price} ₽`]);
    await q(
      `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
       VALUES ('push','client',$1,'offer_received',jsonb_build_object('order_id',$2,'price',$3))`,
      [o.client_id, oid, price],
    ).catch(() => {});
    return { ok: true, offer: r.rows[0] };
  });

  app.delete("/api/master/orders/:id/offer", { preHandler: requireMaster }, async (req, reply) => {
    const oid = Number(req.params.id);
    if (!Number.isInteger(oid)) return reply.code(400).send({ ok: false });
    await q(`UPDATE offers SET status='withdrawn' WHERE order_id=$1 AND master_id=$2 AND status='active'`,
      [oid, req.user.userId]);
    return { ok: true };
  });

  // ============ МАСТЕР: мои сделки ============
  app.get("/api/master/deals", { preHandler: requireMaster }, async (req) => {
    const r = await q(
      `SELECT id, status, agreed_price_rub, budget_rub, items, address, district,
              name AS client_name, phone AS client_phone
         FROM orders
        WHERE assigned_master_id = $1 AND status IN ('assigned','en_route','working','done')
        ORDER BY (status = 'done'), created_at DESC`,
      [req.user.userId],
    );
    return { ok: true, deals: r.rows.map((d) => ({ ...d, id: Number(d.id), items: itemsShort(d.items) })) };
  });

  app.post("/api/master/deals/:id/status", { preHandler: requireMaster }, async (req, reply) => {
    const oid = Number(req.params.id);
    const want = clean(req.body?.status, 20);
    if (!Number.isInteger(oid) || !STEPS.includes(want) || want === "assigned")
      return reply.code(400).send({ ok: false, error: "status: en_route|working|done" });

    const o = (await q(`SELECT status, assigned_master_id FROM orders WHERE id = $1`, [oid])).rows[0];
    if (!o) return reply.code(404).send({ ok: false });
    if (Number(o.assigned_master_id) !== req.user.userId)
      return reply.code(403).send({ ok: false, error: "не ваш заказ" });
    if (STEPS.indexOf(want) !== STEPS.indexOf(o.status) + 1)
      return reply.code(409).send({ ok: false, error: `недопустимый переход ${o.status} → ${want}` });

    await q(
      `UPDATE orders SET status = $1, completed_at = CASE WHEN $1 = 'done' THEN now() ELSE completed_at END
        WHERE id = $2`,
      [want, oid],
    );
    await q(`INSERT INTO deal_events (order_id, actor_type, actor_id, from_status, to_status) VALUES ($1,'master',$2,$3,$4)`,
      [oid, req.user.userId, o.status, want]);
    if (want === "done")
      await q(`UPDATE masters SET orders_done = orders_done + 1 WHERE id = $1`, [req.user.userId]);
    return { ok: true, status: want };
  });
}
