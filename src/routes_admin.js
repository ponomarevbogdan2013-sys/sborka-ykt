// Админка владельца: страница /admin (Basic Auth) + журнал событий, заказы с откликами, лог уведомлений.
// Управление мастерами и статусами заказов — уже существующие /api/admin/masters/:id/(verify|status) и
// /api/admin/orders/:id/status; здесь только чтение.
import QRCode from "qrcode";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { q } from "./db.js";
import { toInt } from "./util.js";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "admin_page.html");

// Публичный адрес сайта: из PUBLIC_BASE_URL или по заголовкам запроса (как в routes_partner.js).
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const baseUrl = (req) => PUBLIC_BASE || `${req.protocol}://${req.headers.host}`;

export default function registerAdminRoutes(app) {
  // Страница лежит в src/, а не в public/ — иначе статика отдала бы её без пароля.
  app.get("/admin", { onRequest: app.basicAuth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(await readFile(PAGE, "utf8"));
  });

  // Приглашения мастеров: общая ссылка регистрации /m?join=<MASTER_JOIN_CODE> + адрес сайта,
  // от которого фронт строит полные ссылки для персональных приглашений (/m?invite=<токен>).
  app.get("/api/admin/master-join", { onRequest: app.basicAuth }, async (req) => {
    const base = baseUrl(req);
    const code = process.env.MASTER_JOIN_CODE || "";
    return { ok: true, base, join_url: code ? `${base}/m?join=${encodeURIComponent(code)}` : null };
  });

  // QR-код (PNG) для ссылки-приглашения, чтобы сохранить и передать мастеру. Только под админским
  // паролем и только для ссылок НАШЕГО сайта — это не общий генератор QR.
  app.get("/api/admin/qr.png", { onRequest: app.basicAuth }, async (req, reply) => {
    const u = String(req.query?.u || "");
    let ok = false;
    try {
      ok = u.length > 0 && u.length <= 400 && new URL(u).origin === new URL(baseUrl(req)).origin;
    } catch { ok = false; }
    if (!ok) return reply.code(400).send({ ok: false, error: "ссылка не с нашего сайта" });
    const png = await QRCode.toBuffer(u, {
      type: "png", width: 640, margin: 2, errorCorrectionLevel: "M",
      color: { dark: "#1b3a5b", light: "#ffffff" },
    });
    return reply.type("image/png").header("Cache-Control", "private, max-age=3600").send(png);
  });

  // Единый журнал: события заказов (заявка, отклик, выбор, статусы, отмена, отзыв, ручные правки) + новые мастера.
  app.get("/api/admin/journal", { onRequest: app.basicAuth }, async (req) => {
    const limit = Math.min(500, Math.max(1, toInt(req.query?.limit, 500) || 200));
    const orderId = toInt(req.query?.order_id, 1e12) || null;
    const masterId = toInt(req.query?.master_id, 1e12) || null;
    const r = await q(
      `SELECT * FROM (
         SELECT e.id, e.at, 'deal'::text AS kind, e.order_id, e.actor_type, e.actor_id,
                e.from_status, e.to_status, e.note,
                o.name AS client_name, o.phone AS client_phone, o.address,
                o.agreed_price_rub, o.assigned_master_id,
                am.name AS actor_master_name, mm.name AS assigned_master_name,
                mm.phone AS assigned_master_phone
           FROM deal_events e
           JOIN orders o ON o.id = e.order_id
           LEFT JOIN masters am ON e.actor_type = 'master' AND am.id = e.actor_id
           LEFT JOIN masters mm ON mm.id = o.assigned_master_id
         UNION ALL
         SELECT m.id, m.created_at, 'master_new'::text, NULL::bigint, 'master'::text, m.id,
                NULL::text, m.status, NULL::text,
                NULL::text, NULL::text, NULL::text, NULL::int, NULL::bigint,
                m.name, NULL::text, m.phone
           FROM masters m
       ) x
       WHERE ($2::bigint IS NULL OR x.order_id = $2)
         AND ($3::bigint IS NULL OR (x.kind = 'deal' AND (x.actor_id = $3 AND x.actor_type = 'master' OR x.assigned_master_id = $3))
                                 OR (x.kind = 'master_new' AND x.actor_id = $3))
       ORDER BY x.at DESC, x.id DESC
       LIMIT $1`,
      [limit, orderId, masterId],
    );
    return { events: r.rows };
  });

  // Заказы с полным списком откликов — видно, кто на что откликнулся, по какой цене, кого выбрали.
  app.get("/api/admin/orders-full", { onRequest: app.basicAuth }, async () => {
    const r = await q(
      `SELECT o.id, o.created_at, o.name, o.phone, o.address, o.status, o.budget_rub,
              o.calc_low, o.calc_high, o.agreed_price_rub, o.commission_rub, o.ref,
              o.assigned_master_id, am.name AS master_name, am.phone AS master_phone, o.items,
              COALESCE((
                SELECT json_agg(json_build_object(
                         'id', f.id, 'master_id', f.master_id, 'master_name', m.name, 'master_phone', m.phone,
                         'verified', m.verified, 'price', f.price_rub, 'status', f.status,
                         'at', f.created_at, 'note', f.note) ORDER BY f.created_at)
                  FROM offers f JOIN masters m ON m.id = f.master_id WHERE f.order_id = o.id
              ), '[]'::json) AS offers
         FROM orders o LEFT JOIN masters am ON am.id = o.assigned_master_id
        ORDER BY o.created_at DESC LIMIT 200`,
    );
    return { orders: r.rows };
  });

  // Дашборд владельца. Период: ?days=7|30|90|0 (0 = за всё время).
  // Показатели считаются по заявкам, СОЗДАННЫМ в периоде (когорта) — тогда воронка и деньги
  // сходятся между собой. Спам не считаем. Сутки — по Якутску.
  // Прибыль платформы = комиссия (commission_rub) − доля партнёра (partner_commission_rub)
  // по ВЫПОЛНЕННЫМ заказам; расходы (реклама, налоги, сервер) не учитываются.
  app.get("/api/admin/dashboard", { onRequest: app.basicAuth }, async (req) => {
    const TZ = "Asia/Yakutsk";
    const raw = Number(req.query?.days);
    const days = [7, 30, 90].includes(raw) ? raw : raw === 0 ? 0 : 30;

    const per = days
      ? (await q(
          `SELECT s AS start, ((now() AT TIME ZONE $2)::date - (s AT TIME ZONE $2)::date + 1)::int AS days
             FROM (SELECT (date_trunc('day', now() AT TIME ZONE $2) - ($1::int - 1) * interval '1 day') AT TIME ZONE $2 AS s) x`,
          [days, TZ],
        )).rows[0]
      : (await q(
          `SELECT s AS start, ((now() AT TIME ZONE $1)::date - (s AT TIME ZONE $1)::date + 1)::int AS days
             FROM (SELECT COALESCE((SELECT date_trunc('day', min(created_at) AT TIME ZONE $1) AT TIME ZONE $1
                                      FROM orders WHERE status <> 'spam'),
                                   date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1) AS s) x`,
          [TZ],
        )).rows[0];

    const a = (await q(
      `WITH o AS (
         SELECT o.status, o.agreed_price_rub AS agreed,
                COALESCE(o.commission_rub, 0) AS com, COALESCE(o.partner_commission_rub, 0) AS partner,
                (o.chosen_offer_id IS NOT NULL) AS chosen,
                (o.chosen_offer_id IS NOT NULL OR o.status IN ('assigned','en_route','working','done')) AS is_deal,
                (SELECT count(*)::int FROM offers f WHERE f.order_id = o.id) AS n_offers,
                (SELECT min(f.created_at) FROM offers f WHERE f.order_id = o.id) - o.created_at AS to_first
           FROM orders o WHERE o.status <> 'spam' AND o.created_at >= $1
       )
       SELECT count(*)::int AS created,
              count(*) FILTER (WHERE n_offers > 0 OR is_deal)::int AS with_offer,
              count(*) FILTER (WHERE is_deal)::int AS deal,
              count(*) FILTER (WHERE status = 'done')::int AS done,
              count(*) FILTER (WHERE status = 'open')::int AS f_open,
              count(*) FILTER (WHERE status = 'expired')::int AS f_expired,
              count(*) FILTER (WHERE status = 'cancelled' AND NOT chosen)::int AS f_cancel_before,
              count(*) FILTER (WHERE status = 'cancelled' AND chosen)::int AS f_cancel_after,
              count(*) FILTER (WHERE status IN ('assigned','en_route','working'))::int AS f_work,
              COALESCE(sum(agreed) FILTER (WHERE status = 'done'), 0)::int AS gmv_done,
              COALESCE(sum(com - partner) FILTER (WHERE status = 'done'), 0)::int AS profit_done,
              COALESCE(sum(agreed) FILTER (WHERE status IN ('assigned','en_route','working')), 0)::int AS gmv_work,
              COALESCE(sum(com - partner) FILTER (WHERE status IN ('assigned','en_route','working')), 0)::int AS profit_work,
              count(*) FILTER (WHERE agreed IS NOT NULL AND status IN ('assigned','en_route','working','done'))::int AS deals_n,
              avg(agreed) FILTER (WHERE agreed IS NOT NULL AND status IN ('assigned','en_route','working','done')) AS avg_check,
              count(*) FILTER (WHERE n_offers = 0 AND NOT is_deal)::int AS no_offer,
              avg(n_offers) AS offers_per_order,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM to_first) / 60)
                FILTER (WHERE to_first IS NOT NULL) AS median_first_min
         FROM o`,
      [per.start],
    )).rows[0];

    const extra = (await q(
      `SELECT (SELECT count(*)::int FROM orders WHERE status <> 'spam') AS orders_all,
              (SELECT count(*)::int FROM masters WHERE status = 'active') AS masters_active,
              (SELECT count(DISTINCT master_id)::int FROM offers WHERE created_at >= $1) AS masters_offered`,
      [per.start],
    )).rows[0];

    // заявок по дням (график: не больше последних 90 суток)
    const chartDays = Math.min(per.days, 90);
    const perDay = (await q(
      `SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(c.n, 0)::int AS n
         FROM generate_series(((now() AT TIME ZONE $2)::date - ($1::int - 1)), (now() AT TIME ZONE $2)::date, interval '1 day') d
         LEFT JOIN (SELECT (created_at AT TIME ZONE $2)::date AS day, count(*) AS n
                      FROM orders WHERE status <> 'spam' GROUP BY 1) c ON c.day = d::date
        ORDER BY d`,
      [chartDays, TZ],
    )).rows;

    // «Требует внимания» — состояние на сейчас, от периода не зависит
    const person = `o.id, o.created_at, o.name, o.phone, o.address, o.budget_rub`;
    const noOffers = (await q(
      `SELECT ${person}, o.created_at AS since
         FROM orders o
        WHERE o.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM offers f WHERE f.order_id = o.id AND f.status = 'active')
        ORDER BY o.created_at`,
    )).rows;
    const notChosen = (await q(
      `SELECT ${person}, min(f.created_at) AS since, count(*)::int AS n_offers, min(f.price_rub) AS min_price
         FROM orders o JOIN offers f ON f.order_id = o.id AND f.status = 'active'
        WHERE o.status = 'open'
        GROUP BY o.id ORDER BY since`,
    )).rows;
    const stalled = (await q(
      `SELECT ${person}, o.status, o.agreed_price_rub, m.name AS master_name, m.phone AS master_phone,
              COALESCE((SELECT max(e.at) FROM deal_events e WHERE e.order_id = o.id), o.created_at) AS since
         FROM orders o LEFT JOIN masters m ON m.id = o.assigned_master_id
        WHERE o.status IN ('assigned','en_route','working')
          AND COALESCE((SELECT max(e.at) FROM deal_events e WHERE e.order_id = o.id), o.created_at) < now() - interval '24 hours'
        ORDER BY since`,
    )).rows;
    const num = (r) => ({ ...r, id: Number(r.id) });

    const round1 = (x) => Math.round(x * 10) / 10;
    return {
      period: { days, span_days: per.days, from: per.start },
      kpi: {
        orders: a.created, orders_all: extra.orders_all,
        per_day: round1(a.created / per.days),
        avg_check: a.avg_check == null ? null : Math.round(Number(a.avg_check)), deals_n: a.deals_n,
        gmv_done: a.gmv_done, gmv_work: a.gmv_work,
        profit_done: a.profit_done, profit_work: a.profit_work,
        profit_pct: a.gmv_done > 0 ? round1((a.profit_done / a.gmv_done) * 100) : null,
        no_offer_pct: a.created ? Math.round((a.no_offer / a.created) * 100) : null, no_offer: a.no_offer,
        median_first_min: a.median_first_min == null ? null : Math.round(a.median_first_min),
        offers_per_order: a.created ? round1(Number(a.offers_per_order)) : null,
        masters_active: extra.masters_active, masters_offered: extra.masters_offered,
      },
      funnel: { created: a.created, with_offer: a.with_offer, deal: a.deal, done: a.done },
      fate: {
        open: a.f_open, expired: a.f_expired, cancelled_before: a.f_cancel_before,
        cancelled_after: a.f_cancel_after, in_work: a.f_work, done: a.done,
      },
      per_day: perDay,
      attention: { no_offers: noOffers.map(num), not_chosen: notChosen.map(num), stalled: stalled.map(num) },
    };
  });

  // Что и когда ушло владельцу в Telegram (и не упало ли).
  app.get("/api/admin/notifications", { onRequest: app.basicAuth }, async () => {
    const r = await q(
      `SELECT id, created_at, channel, recipient_type, template, status, sent_at, error, payload
         FROM notifications ORDER BY created_at DESC LIMIT 200`,
    );
    return { notifications: r.rows };
  });
}
