// Клиентская страница /z/<token>: просмотр заявок, выбор мастера, отмена, отзыв.
// Доступ — по знанию токена из ссылки (логина нет). Барьер «4 цифры телефона»
// на действиях снят по решению владельца (2026-09-06). Поле phone4 в теле
// запросов принимаем и игнорируем, пока z.js его шлёт.
// Клиент /z (index.html + js/z.js) — зона дизайн-Claude. Контракт полей — как в z.js.
import { q, pool } from "./db.js";
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

  // ---------- выбрать мастера ----------
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

  // ---------- договорились с мастером (созвонились): шаг «Договорились» ----------
  // Переход assigned → agreed. Условие в самом UPDATE делает его атомарным: если мастер или клиент
  // уже нажали, повтор безвреден (ok), если заявку успели вернуть/отменить — 409.
  app.post("/api/z/:token/agree", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const orderId = toInt((req.body || {}).order_id);
    if (!orderId) return reply.code(400).send({ ok: false, error: "нет заявки" });

    const u = await q(
      `UPDATE orders SET status = 'agreed'
        WHERE id = $1 AND client_id = $2 AND status = 'assigned'
        RETURNING id, assigned_master_id, agreed_price_rub`,
      [orderId, c.id],
    );
    if (!u.rowCount) {
      const o = (await q(`SELECT status FROM orders WHERE id = $1 AND client_id = $2`, [orderId, c.id])).rows[0];
      if (!o) return reply.code(404).send({ ok: false, error: "заявка не найдена" });
      if (o.status === "agreed") return { ok: true, already: true };   // уже отмечено (мастером или вторым нажатием)
      return reply.code(409).send({ ok: false, error: "Сейчас нельзя отметить «Договорились» — обновите страницу" });
    }
    const row = u.rows[0];
    await q(
      `INSERT INTO deal_events (order_id, actor_type, actor_id, from_status, to_status, note)
       VALUES ($1,'client',$2,'assigned','agreed','клиент подтвердил: договорились с мастером')`,
      [row.id, c.id],
    );
    if (row.assigned_master_id) {
      await q(
        `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
         VALUES ('push','master',$1,'order_agreed',jsonb_build_object('order_id',$2::bigint))`,
        [row.assigned_master_id, row.id],
      ).catch((e) => app.log.error("notifications (order_agreed): " + e.message));
    }
    (async () => {
      const [oc, mc] = await Promise.all([orderCtx(row.id), row.assigned_master_id ? masterCtx(row.assigned_master_id) : null]);
      ownerEvent("deal_agreed",
        `🤝 <b>Договорились</b> (подтвердил клиент)\n${mc ? "Мастер: " + masterLine(mc) + "\n" : ""}${orderLine(oc)}` +
        `\nСумма: ${rub(row.agreed_price_rub)}`,
        { order_id: row.id, master_id: row.assigned_master_id || null });
    })().catch(() => {});
    return { ok: true };
  });

  // ---------- не договорились с мастером: вернуть заявку в поиск ----------
  // Только пока мастер не выехал (assigned или agreed). Заявка снова открыта для откликов;
  // выбранный мастер исключается (его отклик → 'declined'), ВСЕ остальные отклики, отклонённые при
  // выборе ('rejected'), возвращаются в 'active' — клиент сразу видит их и выбирает другого.
  // Цена и комиссии сбрасываются (фиксируются заново при новом выборе). Одна транзакция.
  app.post("/api/z/:token/reopen", async (req, reply) => {
    const c = await clientByToken(req.params.token);
    if (!c) return reply.code(404).send({ ok: false, error: "not found" });
    const orderId = toInt((req.body || {}).order_id);
    if (!orderId) return reply.code(400).send({ ok: false, error: "нет заявки" });

    const db = await pool.connect();
    let cur, restored;
    try {
      await db.query("BEGIN");
      cur = (await db.query(
        `SELECT id, status, assigned_master_id, chosen_offer_id, agreed_price_rub
           FROM orders WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [orderId, c.id],
      )).rows[0];
      if (!cur) { await db.query("ROLLBACK"); return reply.code(404).send({ ok: false, error: "заявка не найдена" }); }
      if (!["assigned", "agreed"].includes(cur.status)) {
        await db.query("ROLLBACK");
        const later = ["en_route", "working", "done"].includes(cur.status);
        return reply.code(409).send({
          ok: false,
          error: later ? "Мастер уже выехал или работает — вернуть заявку в поиск нельзя" : "Заявка сейчас не в статусе «мастер назначен»",
        });
      }
      await db.query(
        `UPDATE orders SET status = 'open', assigned_master_id = NULL, chosen_offer_id = NULL,
                agreed_price_rub = NULL, commission_rub = NULL, partner_commission_rub = NULL,
                contact_revealed_at = NULL
          WHERE id = $1`,
        [cur.id],
      );
      await db.query(`UPDATE offers SET status = 'declined' WHERE id = $1`, [cur.chosen_offer_id]);
      restored = (await db.query(
        `UPDATE offers SET status = 'active' WHERE order_id = $1 AND status = 'rejected' RETURNING id`,
        [cur.id],
      )).rowCount;
      const mname = (await db.query(`SELECT name FROM masters WHERE id = $1`, [cur.assigned_master_id])).rows[0]?.name || "";
      await db.query(
        `INSERT INTO deal_events (order_id, actor_type, actor_id, from_status, to_status, note)
         VALUES ($1,'client',$2,$4,'open',$3)`,
        [cur.id, c.id, `не договорились с мастером${mname ? " " + mname : ""} — заявка возвращена в поиск (откликов сохранено: ${restored})`, cur.status],
      );
      await db.query("COMMIT");
    } catch (e) {
      await db.query("ROLLBACK").catch(() => {});
      app.log.error("reopen: " + e.message);
      return reply.code(500).send({ ok: false, error: "не удалось вернуть заявку, попробуйте ещё раз" });
    } finally {
      db.release();
    }

    if (cur.assigned_master_id) {
      await q(
        `INSERT INTO notifications (channel, recipient_type, recipient_id, template, payload)
         VALUES ('push','master',$1,'order_reopened',jsonb_build_object('order_id',$2::bigint))`,
        [cur.assigned_master_id, cur.id],
      ).catch((e) => app.log.error("notifications (order_reopened): " + e.message));
    }
    (async () => {
      const oc = await orderCtx(cur.id);
      const mc = cur.assigned_master_id ? await masterCtx(cur.assigned_master_id) : null;
      ownerEvent("deal_returned",
        `↩️ <b>Не договорились — заявка снова в поиске</b>\n${orderLine(oc)}` +
        (mc ? `\nМастер, с которым не договорились: ${masterLine(mc)}` : "") +
        `\nСумма была: ${rub(cur.agreed_price_rub)} · откликов сохранено: ${restored}`,
        { order_id: cur.id, master_id: cur.assigned_master_id || null });
    })().catch(() => {});
    return { ok: true, restored };
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
    if (!["open", "assigned", "agreed"].includes(o.status))
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
        `❌ <b>Клиент отменил заявку</b>\n${orderLine(oc)}\nБыла в статусе: ${o.status === "assigned" ? "мастер назначен" : o.status === "agreed" ? "договорились" : "поиск мастера"}` +
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
