// Админка владельца: страница /admin (Basic Auth) + журнал событий, заказы с откликами, лог уведомлений.
// Управление мастерами и статусами заказов — уже существующие /api/admin/masters/:id/(verify|status) и
// /api/admin/orders/:id/status; здесь только чтение.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { q } from "./db.js";
import { toInt } from "./util.js";

const PAGE = join(dirname(fileURLToPath(import.meta.url)), "admin_page.html");

export default function registerAdminRoutes(app) {
  // Страница лежит в src/, а не в public/ — иначе статика отдала бы её без пароля.
  app.get("/admin", { onRequest: app.basicAuth }, async (req, reply) => {
    reply.header("Cache-Control", "no-store");
    return reply.type("text/html; charset=utf-8").send(await readFile(PAGE, "utf8"));
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

  // Что и когда ушло владельцу в Telegram (и не упало ли).
  app.get("/api/admin/notifications", { onRequest: app.basicAuth }, async () => {
    const r = await q(
      `SELECT id, created_at, channel, recipient_type, template, status, sent_at, error, payload
         FROM notifications ORDER BY created_at DESC LIMIT 200`,
    );
    return { notifications: r.rows };
  });
}
