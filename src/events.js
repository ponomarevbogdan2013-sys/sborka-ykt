// Уведомления владельцу о событиях сделки (отклик, выбор мастера, статусы, отмена, отзыв).
// ownerEvent() шлёт сообщение в Telegram и пишет строку в `notifications` (лог: что и когда ушло, ок/ошибка).
// Никогда не бросает исключение и вызывается без await — сбой уведомления не должен ломать действие пользователя.
import { q } from "./db.js";
import { notify } from "./notify.js";

const TZ = "Asia/Yakutsk";

export const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const rub = (n) => (n == null ? "—" : Number(n).toLocaleString("ru-RU") + " ₽");
export const when = (d = new Date()) =>
  new Date(d).toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// Данные заказа и мастера для текста уведомления.
export async function orderCtx(orderId) {
  const r = await q(
    `SELECT o.id, o.name, o.phone, o.address, o.status, o.ref, o.agreed_price_rub, o.commission_rub,
            (SELECT count(*)::int FROM offers f WHERE f.order_id = o.id AND f.status = 'active') AS offers_active
       FROM orders o WHERE o.id = $1`, [orderId],
  );
  return r.rows[0] || null;
}
export async function masterCtx(masterId) {
  const r = await q(`SELECT id, name, phone FROM masters WHERE id = $1`, [masterId]);
  return r.rows[0] || null;
}

export const orderLine = (o) => (o ? `заявка #${o.id} · клиент ${esc(o.name)}, ${esc(o.phone)}` : "заявка");
export const masterLine = (m) => (m ? `${esc(m.name)}, +${esc(m.phone)}` : "мастер");

export function ownerEvent(template, text, payload = {}) {
  (async () => {
    const res = await notify(`${text}\n<i>${when()}</i>`);
    const tg = (res.results || [])[0] || {};
    await q(
      `INSERT INTO notifications (channel, recipient_type, template, payload, status, sent_at, error)
       VALUES ('telegram','owner',$1,$2,$3,$4,$5)`,
      [template, payload, tg.ok ? "sent" : "failed", tg.ok ? new Date() : null, tg.ok ? null : (tg.error || tg.skipped || null)],
    );
  })().catch((e) => console.warn("ownerEvent:", e.message));
}
