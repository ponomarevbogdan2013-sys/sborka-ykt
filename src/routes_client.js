// Клиентская страница /z/<token>: просмотр заявок, выбор мастера, отмена, отзыв.
// Просмотр — без барьера. Действия — барьер: последние 4 цифры телефона.
// Клиент /z (index.html + js/z.js) — зона дизайн-Claude. Контракт полей — как в z.js.
import { q } from "./db.js";
import { clean, toInt } from "./util.js";

const COMMISSION_PCT = 30; // комиссия платформы
const itemsShort = (a) => (Array.isArray(a) ? a.map((i) => ({ nm: i.nm, qty: i.qty })) : []);
const digits = (s) => String(s ?? "").replace(/\D/g, "");

async function clientByToken(token) {
  const r = await q(`SELECT id, name, phone FROM clients WHERE token = $1 AND NOT blocked`, [clean(token, 64)]);
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return { id: Number(row.id), name: row.name, phone: row.phone }; // id: bigint -> Number
}
const pinOk = (client, phone4) => digits(phone4).length === 4 && digits(client.phone).slice(-4) === digits(phone4);

export default function registerClientRoutes(app) {
  // ---------- просмотр всех заявок клиента ----------
  app.get("/api/z/:token", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    await q(`UPDATE clients SET last_seen_at = now() WHERE id = $1`, [c.id]);

    const orders = (await q(
      `SELECT id, status, items, district, address,
              to_char(preferred_date,'YYYY-MM-DD') AS preferred_date, preferred_time,
              budget_rub, photos, assigned_master_id, agreed_price_rub
         FROM orders WHERE client_id = $1 ORDER BY created_at DESC`,
      [c.id],
    )).rows;

    const ids = orders.map((o) => o.id);
    const offersByOrder = {};
    const reviewByOrder = {};
    const masterById = {};
    if (ids.length) {
      const offs = (await q(
        `SELECT f.id, f.order_id, f.price_rub, f.note,
                m.name AS m_name, m.rating_avg, m.orders_done, m.verified
           FROM offers f JOIN masters m ON m.id = f.master_id
          WHERE f.order_id = ANY($1) AND f.status = 'active'
          ORDER BY f.price_rub ASC`,
        [ids],
      )).rows;
      for (const o of offs) {
        (offersByOrder[o.order_id] ||= []).push({
          id: Number(o.id), price_rub: o.price_rub, note: o.note,
          master: {
            name: o.m_name, rating_avg: Number(o.rating_avg),
            orders_done: o.orders_done, verified: o.verified,
          },
        });
      }
      const rvs = (await q(
        `SELECT order_id, rating, text FROM reviews WHERE order_id = ANY($1) AND author_type = 'client'`,
        [ids],
      )).rows;
      for (const rv of rvs) reviewByOrder[rv.order_id] = { rating: rv.rating, text: rv.text };

      const mids = orders.map((o) => o.assigned_master_id).filter(Boolean);
      if (mids.length) {
        const ms = (await q(
          `SELECT id, name, phone, rating_avg, verified FROM masters WHERE id = ANY($1)`, [mids],
        )).rows;
        for (const m of ms) masterById[m.id] = m;
      }
    }

    return {
      client: { name: c.name },
      orders: orders.map((o) => {
        const m = o.assigned_master_id ? masterById[o.assigned_master_id] : null;
        return {
          id: Number(o.id),
          status: o.status,
          items: itemsShort(o.items),
          district: o.district,
          address: o.address,
          preferred_date: o.preferred_date,
          preferred_time: o.preferred_time,
          budget_rub: o.budget_rub,
          photos: Array.isArray(o.photos) ? o.photos : [],
          offers: offersByOrder[o.id] || [],
          deal: m
            ? {
                master: {
                  name: m.name, phone: m.phone,
                  rating_avg: Number(m.rating_avg), verified: m.verified,
                },
                agreed_price_rub: o.agreed_price_rub,
                status: o.status,
              }
            : null,
          review: reviewByOrder[o.id] || null,
        };
      }),
    };
  });

  // ---------- выбрать мастера (барьер) ----------
  app.post("/api/z/:token/choose", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const b = req.body || {};
    if (!pinOk(c, b.phone4)) return reply.code(403).send({ ok: false, error: "Неверные цифры телефона" });

    const offerId = toInt(b.offer_id);
    if (!offerId) return reply.code(400).send({ ok: false, error: "нет отклика" });

    const off = (await q(
      `SELECT f.id, f.order_id, f.master_id, f.price_rub, f.status,
              o.client_id, o.status AS order_status, o.ref
         FROM offers f JOIN orders o ON o.id = f.order_id
        WHERE f.id = $1`,
      [offerId],
    )).rows[0];
    if (!off || Number(off.client_id) !== c.id)
      return reply.code(404).send({ ok: false, error: "отклик не найден" });
    if (off.order_status !== "open" || off.status !== "active")
      return reply.code(409).send({ ok: false, error: "заявка уже не в поиске мастера" });

    const agreed = off.price_rub;
    const commission = Math.round((agreed * COMMISSION_PCT) / 100);
    let partnerCommission = null;
    if (off.ref) {
      const p = (await q(`SELECT commission_pct FROM partners WHERE code = $1 AND active`, [off.ref])).rows[0];
      if (p) partnerCommission = Math.round((agreed * Number(p.commission_pct)) / 100);
    }

    await q(
      `UPDATE orders SET status = 'assigned', assigned_master_id = $2, chosen_offer_id = $3,
              agreed_price_rub = $4, commission_rub = $5, partner_commission_rub = $6,
              contact_revealed_at = now()
        WHERE id = $1`,
      [off.order_id, off.master_id, off.id, agreed, commission, partnerCommission],
    );
    await q(`UPDATE offers SET status = 'accepted' WHERE id = $1`, [off.id]);
    await q(`UPDATE offers SET status = 'rejected' WHERE order_id = $1 AND id <> $2 AND status = 'active'`,
      [off.order_id, off.id]);
    await q(
      `INSERT INTO deal_events (order_id, actor_type, actor_id, from_status, to_status, note)
       VALUES ($1,'client',$2,'open','assigned',$3)`,
      [off.order_id, c.id, `выбран мастер, ${agreed} ₽`],
    );
    await q(
      `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
       VALUES ('push','master',$1,'order_assigned',jsonb_build_object('order_id',$2,'price',$3))`,
      [off.master_id, off.order_id, agreed],
    ).catch(() => {});

    return { ok: true };
  });

  // ---------- отменить заявку (барьер) ----------
  app.post("/api/z/:token/cancel", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const b = req.body || {};
    if (!pinOk(c, b.phone4)) return reply.code(403).send({ ok: false, error: "Неверные цифры телефона" });

    const orderId = toInt(b.order_id);
    const o = (await q(`SELECT id, status, assigned_master_id FROM orders WHERE id = $1 AND client_id = $2`,
      [orderId, c.id])).rows[0];
    if (!o) return reply.code(404).send({ ok: false, error: "заявка не найдена" });
    if (!["open", "assigned"].includes(o.status))
      return reply.code(409).send({ ok: false, error: "заявку уже нельзя отменить" });

    await q(`UPDATE orders SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1`,
      [o.id, clean(b.reason, 300) || "клиент отменил"]);
    await q(`UPDATE offers SET status = 'expired' WHERE order_id = $1 AND status = 'active'`, [o.id]);
    await q(
      `INSERT INTO deal_events (order_id, actor_type, actor_id, from_status, to_status, note)
       VALUES ($1,'client',$2,$3,'cancelled',$4)`,
      [o.id, c.id, o.status, clean(b.reason, 300) || "клиент отменил"],
    );
    if (o.assigned_master_id) {
      await q(
        `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
         VALUES ('push','master',$1,'order_cancelled',jsonb_build_object('order_id',$2))`,
        [o.assigned_master_id, o.id],
      ).catch(() => {});
    }
    return { ok: true };
  });

  // ---------- отзыв о мастере (барьер) ----------
  app.post("/api/z/:token/review", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const b = req.body || {};
    if (!pinOk(c, b.phone4)) return reply.code(403).send({ ok: false, error: "Неверные цифры телефона" });

    const orderId = toInt(b.order_id);
    const rating = toInt(b.rating, 5);
    if (!rating || rating < 1 || rating > 5)
      return reply.code(400).send({ ok: false, error: "оценка 1–5" });

    const o = (await q(
      `SELECT id, status, assigned_master_id FROM orders WHERE id = $1 AND client_id = $2`,
      [orderId, c.id],
    )).rows[0];
    if (!o || !o.assigned_master_id)
      return reply.code(404).send({ ok: false, error: "заявка не найдена" });
    if (o.status !== "done")
      return reply.code(409).send({ ok: false, error: "отзыв можно оставить после выполнения" });

    // На пилоте клиентский отзыв виден сразу (двигает рейтинг мастера).
    // Строгий «слепой» режим (visible при обоих отзывах / через 7 дней) — включим в Этапе 3.
    await q(
      `INSERT INTO reviews (order_id, author_type, author_id, target_type, target_id, rating, text, visible)
       VALUES ($1,'client',$2,'master',$3,$4,$5,true)
       ON CONFLICT (order_id, author_type)
       DO UPDATE SET rating = EXCLUDED.rating, text = EXCLUDED.text, visible = true`,
      [o.id, c.id, o.assigned_master_id, rating, clean(b.text, 1000) || null],
    );
    return { ok: true };
  });
}
