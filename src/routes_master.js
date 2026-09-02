// Эндпоинты мастера (/api/master/*) + приглашение мастера админом.
// Клиент мастера (m.html + m.js) — зона дизайн-Claude. Здесь только API.
import { q } from "./db.js";
import { clean, toInt, normPhone, newToken, PHONE_RE } from "./util.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSidCookie, clearSidCookie, requireRole, SID_COOKIE,
} from "./auth.js";

const requireMaster = requireRole("master");
const RL_LOGIN = { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } };

function publicMaster(m) {
  return {
    id: Number(m.id), phone: m.phone, name: m.name, photo_url: m.photo_url,
    about: m.about, experience_years: m.experience_years, zones: m.zones || [],
    has_tools: m.has_tools, has_car: m.has_car, self_employed: m.self_employed,
    status: m.status, verified: m.verified,
    rating_avg: Number(m.rating_avg), rating_count: m.rating_count, orders_done: m.orders_done,
  };
}

async function masterCategories(id) {
  const r = await q(`SELECT category FROM master_categories WHERE master_id = $1 ORDER BY category`, [id]);
  return r.rows.map((x) => x.category);
}

export default function registerMasterRoutes(app) {
  // ---------- админ: пригласить мастера ----------
  app.post("/api/admin/masters/invite", { onRequest: app.basicAuth }, async (req, reply) => {
    const b = req.body || {};
    const name = clean(b.name, 120);
    const phoneRaw = clean(b.phone, 24);
    if (name.length < 2) return reply.code(400).send({ ok: false, error: "укажите имя" });
    if (!PHONE_RE.test(phoneRaw)) return reply.code(400).send({ ok: false, error: "проверьте телефон" });
    const phone = normPhone(phoneRaw);
    if (phone.length < 10) return reply.code(400).send({ ok: false, error: "проверьте телефон" });

    const exists = await q(`SELECT id, status FROM masters WHERE phone = $1`, [phone]);
    if (exists.rowCount) {
      return reply.code(409).send({ ok: false, error: `мастер с этим телефоном уже есть (id ${exists.rows[0].id}, ${exists.rows[0].status})` });
    }
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

  // ---------- админ: список / верификация / статус ----------
  app.get("/api/admin/masters", { onRequest: app.basicAuth }, async (req) => {
    const status = clean(req.query?.status, 20);
    const params = [];
    let where = "";
    if (status) { params.push(status); where = "WHERE status = $1"; }
    const r = await q(
      `SELECT id, created_at, phone, name, status, verified, verified_at,
              rating_avg, rating_count, orders_done,
              (invite_token IS NOT NULL) AS invite_pending
         FROM masters ${where} ORDER BY created_at DESC LIMIT 500`,
      params,
    );
    return { masters: r.rows };
  });

  app.post("/api/admin/masters/:id/verify", { onRequest: app.basicAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ ok: false });
    const verified = !!(req.body && req.body.verified);
    await q(
      `UPDATE masters SET verified = $1, verified_at = CASE WHEN $1 THEN now() ELSE NULL END
        WHERE id = $2`,
      [verified, id],
    );
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

  // ---------- мастер: активация по инвайту ----------
  app.post("/api/master/activate", RL_LOGIN, async (req, reply) => {
    const b = req.body || {};
    const invite = clean(b.invite_token, 64);
    const password = String(b.password || "");
    if (password.length < 6) return reply.code(400).send({ ok: false, error: "пароль от 6 символов" });

    const r = await q(
      `SELECT * FROM masters WHERE invite_token = $1 AND status = 'invited'`, [invite],
    );
    if (!r.rowCount) return reply.code(400).send({ ok: false, error: "приглашение недействительно или уже использовано" });
    const m = r.rows[0];

    const pw = await hashPassword(password);
    await q(
      `UPDATE masters SET password_hash = $1, status = 'active', invite_token = NULL,
              last_seen_at = now() WHERE id = $2`,
      [pw, m.id],
    );
    const sess = await createSession("master", Number(m.id), req);
    setSidCookie(reply, sess.token, sess.expires);
    const fresh = (await q(`SELECT * FROM masters WHERE id = $1`, [m.id])).rows[0];
    return { ok: true, master: publicMaster(fresh), categories: await masterCategories(m.id) };
  });

  // ---------- мастер: вход / выход ----------
  app.post("/api/master/login", RL_LOGIN, async (req, reply) => {
    const b = req.body || {};
    const phone = normPhone(clean(b.phone, 24));
    const password = String(b.password || "");
    const r = await q(`SELECT * FROM masters WHERE phone = $1`, [phone]);
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
    return { ok: true, master: publicMaster(m), categories: await masterCategories(m.id) };
  });

  app.post("/api/master/logout", async (req, reply) => {
    await destroySession(req.cookies?.[SID_COOKIE]);
    clearSidCookie(reply);
    return { ok: true };
  });

  // ---------- мастер: профиль ----------
  app.get("/api/master/me", { preHandler: requireMaster }, async (req) => {
    const m = (await q(`SELECT * FROM masters WHERE id = $1`, [req.user.userId])).rows[0];
    if (!m) return { ok: false };
    return { ok: true, master: publicMaster(m), categories: await masterCategories(m.id) };
  });

  app.put("/api/master/profile", { preHandler: requireMaster }, async (req) => {
    const b = req.body || {};
    const id = req.user.userId;
    const about = clean(b.about, 1000) || null;
    const experience_years = toInt(b.experience_years, 70);
    const zones = Array.isArray(b.zones) ? b.zones.map((z) => clean(z, 60)).filter(Boolean).slice(0, 20) : null;
    const has_tools = b.has_tools == null ? null : !!b.has_tools;
    const has_car = b.has_car == null ? null : !!b.has_car;
    const self_employed = ["none", "self_employed", "ie"].includes(b.self_employed) ? b.self_employed : null;

    await q(
      `UPDATE masters SET
         about = COALESCE($2, about),
         experience_years = COALESCE($3, experience_years),
         zones = COALESCE($4, zones),
         has_tools = COALESCE($5, has_tools),
         has_car = COALESCE($6, has_car),
         self_employed = COALESCE($7, self_employed)
       WHERE id = $1`,
      [id, about, experience_years, zones, has_tools, has_car, self_employed],
    );

    if (Array.isArray(b.categories)) {
      const cats = b.categories.map((c) => clean(c, 40)).filter(Boolean);
      const valid = (await q(`SELECT code FROM service_categories WHERE active`)).rows.map((x) => x.code);
      const keep = cats.filter((c) => valid.includes(c));
      await q(`DELETE FROM master_categories WHERE master_id = $1`, [id]);
      for (const c of keep) {
        await q(`INSERT INTO master_categories (master_id, category) VALUES ($1,$2)
                 ON CONFLICT DO NOTHING`, [id, c]);
      }
    }

    const m = (await q(`SELECT * FROM masters WHERE id = $1`, [id])).rows[0];
    return { ok: true, master: publicMaster(m), categories: await masterCategories(id) };
  });

  // ---------- мастер: лента заказов ----------
  app.get("/api/master/feed", { preHandler: requireMaster }, async (req) => {
    const id = req.user.userId;
    const m = (await q(`SELECT status, zones FROM masters WHERE id = $1`, [id])).rows[0];
    if (!m || m.status !== "active") return { ok: true, orders: [], note: "аккаунт неактивен" };
    const cats = await masterCategories(id);
    if (!cats.length) return { ok: true, orders: [], note: "укажите категории в анкете" };

    const limit = Math.min(50, Math.max(1, toInt(req.query?.limit, 50) || 20));
    const offset = Math.max(0, toInt(req.query?.offset, 100000) || 0);
    const zones = m.zones || [];

    const r = await q(
      `SELECT o.id, o.created_at, o.district, o.category, o.preferred_date, o.preferred_time,
              o.budget_rub, o.calc_low, o.calc_high, o.items, o.addons, o.comment,
              (SELECT count(*)::int FROM offers f WHERE f.order_id = o.id AND f.status = 'active') AS offers_count,
              mo.price_rub AS my_offer_price, mo.status AS my_offer_status
         FROM orders o
         LEFT JOIN offers mo ON mo.order_id = o.id AND mo.master_id = $1
        WHERE o.status = 'open'
          AND o.category = ANY($2)
          AND (cardinality($3::text[]) = 0 OR o.district IS NULL OR o.district = ANY($3))
        ORDER BY o.created_at DESC
        LIMIT $4 OFFSET $5`,
      [id, cats, zones, limit, offset],
    );
    return { ok: true, orders: r.rows };
  });

  // ---------- мастер: карточка заказа ----------
  app.get("/api/master/orders/:id", { preHandler: requireMaster }, async (req, reply) => {
    const oid = Number(req.params.id);
    if (!Number.isInteger(oid)) return reply.code(400).send({ ok: false });
    const o = (await q(`SELECT * FROM orders WHERE id = $1`, [oid])).rows[0];
    if (!o) return reply.code(404).send({ ok: false });

    const mine = Number(o.assigned_master_id) === req.user.userId;
    const base = {
      id: Number(o.id), created_at: o.created_at, status: o.status, district: o.district,
      category: o.category, preferred_date: o.preferred_date, preferred_time: o.preferred_time,
      budget_rub: o.budget_rub, calc_low: o.calc_low, calc_high: o.calc_high,
      items: o.items, addons: o.addons, comment: o.comment,
    };
    const myOffer = (await q(
      `SELECT id, price_rub, can_start_at, note, status FROM offers WHERE order_id = $1 AND master_id = $2`,
      [oid, req.user.userId],
    )).rows[0] || null;

    // контакты и точный адрес — только назначенному мастеру
    if (mine) {
      base.name = o.name; base.phone = o.phone; base.address = o.address;
      base.contact_revealed = true;
    } else {
      base.contact_revealed = false;
    }
    return { ok: true, order: base, my_offer: myOffer };
  });

  // ---------- мастер: отклик ----------
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

    const o = (await q(`SELECT id, status FROM orders WHERE id = $1`, [oid])).rows[0];
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
    await q(
      `INSERT INTO deal_events (order_id, actor_type, actor_id, note)
       VALUES ($1,'master',$2,$3)`,
      [oid, req.user.userId, `отклик: ${price} ₽`],
    );
    await q(
      `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
       SELECT 'push','client', o.client_id, 'offer_received',
              jsonb_build_object('order_id',$1,'price',$2)
         FROM orders o WHERE o.id = $1`,
      [oid, price],
    ).catch(() => {});
    return { ok: true, offer: r.rows[0] };
  });

  app.delete("/api/master/orders/:id/offer", { preHandler: requireMaster }, async (req, reply) => {
    const oid = Number(req.params.id);
    if (!Number.isInteger(oid)) return reply.code(400).send({ ok: false });
    await q(
      `UPDATE offers SET status = 'withdrawn'
        WHERE order_id = $1 AND master_id = $2 AND status = 'active'`,
      [oid, req.user.userId],
    );
    return { ok: true };
  });
}
