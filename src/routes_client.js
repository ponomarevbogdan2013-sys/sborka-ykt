// Клиентская страница /z/<token>: просмотр заявок, выбор мастера, отмена, отзыв.
// Доступ — по знанию токена из ссылки (логина нет). Барьер «4 цифры телефона»
// на действиях снят по решению владельца (2026-09-06). Поле phone4 в теле
// запросов принимаем и игнорируем, пока z.js его шлёт.
// Клиент /z (index.html + js/z.js) — зона дизайн-Claude. Контракт полей — как в z.js.
import { q } from "./db.js";
import { clean, toInt } from "./util.js";
import { ownerEvent, orderCtx, masterCtx, orderLine, masterLine, rub, esc } from "./events.js";

const COMMISSION_PCT = 30; // комиссия платформы
const itemsShort = (a) => (Array.isArray(a) ? a.map((i) => ({ nm: i.nm, qty: i.qty })) : []);

async function clientByToken(token) {
  const r = await q(`SELECT id, name, phone FROM clients WHERE token = $1 AND NOT blocked`, [clean(token, 64)]);
  if (!r.rowCount) return null;
  const row = r.rows[0];
  return { id: Number(row.id), name: row.name, phone: row.phone }; // id: bigint -> Number
}

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
        `SELECT f.id, f.order_id, f.price_rub, f.note, f.master_id,
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
            id: Number(o.master_id),
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
                  id: Number(m.id),
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

  // ---------- выбрать мастера ----------
  // ---------- анкета мастера (публичная часть) ----------
  // Клиент видит только тех мастеров, кто откликался на ЕГО заявки (или назначен на них).
  // Телефон, документы, самозанятость наружу не отдаём — только то, что в макете «Анкета мастера».
  app.get("/api/z/:token/master/:mid", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const mid = toInt(req.params.mid);
    if (!Number.isInteger(mid)) return reply.code(400).send({ ok: false });

    const seen = await q(
      `SELECT 1 FROM offers f JOIN orders o ON o.id = f.order_id
        WHERE o.client_id = $1 AND f.master_id = $2 LIMIT 1`,
      [c.id, mid],
    );
    if (!seen.rowCount) return reply.code(404).send({ ok: false, error: "not found" });

    const m = (await q(
      `SELECT id, name, about, experience_years, has_tools, has_car, verified, photo_url,
              rating_avg, orders_done
         FROM masters WHERE id = $1 AND status = 'active'`,
      [mid],
    )).rows[0];
    if (!m) return reply.code(404).send({ ok: false, error: "not found" });

    const cats = (await q(
      `SELECT sc.title FROM master_categories mc JOIN service_categories sc ON sc.code = mc.category
        WHERE mc.master_id = $1 ORDER BY sc.sort, sc.title`,
      [mid],
    )).rows.map((x) => x.title);
    const portfolio = (await q(
      `SELECT photo_url FROM portfolio_items WHERE master_id = $1 ORDER BY sort, id`, [mid],
    )).rows;
    // отзывы клиентов о мастере; имя автора — только первое слово
    const reviews = (await q(
      `SELECT r.rating, r.text, cl.name AS author
         FROM reviews r LEFT JOIN clients cl ON cl.id = r.author_id
        WHERE r.target_type = 'master' AND r.target_id = $1 AND r.author_type = 'client' AND r.visible
        ORDER BY r.created_at DESC LIMIT 20`,
      [mid],
    )).rows.map((r) => ({
      rating: r.rating, text: r.text,
      who: String(r.author || "").trim().split(/\s+/)[0] || "Клиент",
    }));

    return {
      ok: true,
      master: {
        id: Number(m.id), name: m.name, about: m.about, experience_years: m.experience_years,
        has_tools: m.has_tools, has_car: m.has_car, verified: m.verified, photo_url: m.photo_url,
        rating_avg: Number(m.rating_avg), orders_done: m.orders_done,
        categories: cats, portfolio, reviews,
      },
    };
  });

  app.post("/api/z/:token/choose", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const b = req.body || {};

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
       VALUES ('push','master',$1,'order_assigned',jsonb_build_object('order_id',$2::bigint,'price',$3::int))`,
      [off.master_id, off.order_id, agreed],
    ).catch((e) => app.log.error("notifications (order_assigned): " + e.message));
    (async () => {
      const [oc, mc, cnt] = await Promise.all([
        orderCtx(off.order_id), masterCtx(off.master_id),
        q(`SELECT count(*)::int AS n FROM offers WHERE order_id = $1`, [off.order_id]),
      ]);
      ownerEvent("order_taken",
        `✅ <b>Заказ взят мастером</b>\nМастер: ${masterLine(mc)}\n${orderLine(oc)}` +
        (oc && oc.address ? `\nАдрес: ${esc(oc.address)}` : "") +
        `\nСумма: ${rub(agreed)} · комиссия платформы: ${rub(commission)}` +
        (partnerCommission != null ? ` · партнёру (${esc(off.ref)}): ${rub(partnerCommission)}` : "") +
        `\nВыбран из ${cnt.rows[0].n} откл.`,
        { order_id: off.order_id, master_id: off.master_id, price: agreed });
    })().catch(() => {});

    return { ok: true };
  });

  // ---------- отменить заявку ----------
  app.post("/api/z/:token/cancel", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const b = req.body || {};

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
         VALUES ('push','master',$1,'order_cancelled',jsonb_build_object('order_id',$2::bigint))`,
        [o.assigned_master_id, o.id],
      ).catch((e) => app.log.error("notifications (order_cancelled): " + e.message));
    }
    (async () => {
      const oc = await orderCtx(o.id);
      const mc = o.assigned_master_id ? await masterCtx(o.assigned_master_id) : null;
      ownerEvent("order_cancelled",
        `❌ <b>Клиент отменил заявку</b>\n${orderLine(oc)}\nБыла в статусе: ${o.status === "assigned" ? "мастер назначен" : "поиск мастера"}` +
        (mc ? `\nМастер: ${masterLine(mc)}` : "") +
        `\nПричина: ${esc(clean(b.reason, 300) || "не указана")}`,
        { order_id: o.id, master_id: o.assigned_master_id || null });
    })().catch(() => {});
    return { ok: true };
  });

  // ---------- отзыв о мастере ----------
  app.post("/api/z/:token/review", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const b = req.body || {};

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
    await q(`INSERT INTO deal_events (order_id, actor_type, actor_id, note) VALUES ($1,'client',$2,$3)`,
      [o.id, c.id, `отзыв ${rating}/5` + (clean(b.text, 200) ? `: ${clean(b.text, 200)}` : "")]).catch(() => {});
    (async () => {
      const [oc, mc] = await Promise.all([orderCtx(o.id), masterCtx(o.assigned_master_id)]);
      ownerEvent("review_new",
        `⭐ <b>Отзыв ${rating}/5</b>\nМастер: ${masterLine(mc)}\n${orderLine(oc)}` +
        (clean(b.text, 1000) ? `\n«${esc(clean(b.text, 1000))}»` : ""),
        { order_id: o.id, master_id: o.assigned_master_id, rating });
    })().catch(() => {});
    return { ok: true };
  });
}
