// Отправка web-push. Обёртка над пакетом `web-push`:
//  - setVapidDetails берёт ключи из .env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT);
//  - sendToSubscriber(type, id, {title, body, url}) — шлёт во все живые подписки получателя;
//  - мёртвую подписку (404 / 410 от push-сервиса) гасим: push_subscriptions.disabled = true.
// Полезная нагрузка — JSON {title, body, url}: ровно то, что ждёт public/sw.js.
import webpush from "web-push";
import { q } from "./db.js";

const PUB = process.env.VAPID_PUBLIC_KEY || "";
const PRIV = process.env.VAPID_PRIVATE_KEY || "";
const SUBJ = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let ready = false;
if (PUB && PRIV) {
  try {
    webpush.setVapidDetails(SUBJ, PUB, PRIV);
    ready = true;
  } catch (e) {
    console.warn("web-push: ключи заданы, но невалидны —", e.message);
  }
} else {
  console.warn("web-push: нет VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY — отправка пушей отключена");
}

export const pushReady = () => ready;

// Порог подряд идущих ошибок (не 404/410), после которого подписку считаем мёртвой.
const FAIL_LIMIT = 8;

// Шлёт одно уведомление получателю во все его активные подписки.
// type: 'client' | 'master' | 'partner'. Возвращает { sent, failed, total }.
export async function sendToSubscriber(type, id, { title, body, url }) {
  if (!ready) return { sent: 0, failed: 0, total: 0, skipped: "web-push не настроен" };
  if (!id) return { sent: 0, failed: 0, total: 0 };

  const subs = (await q(
    `SELECT id, endpoint, p256dh, auth
       FROM push_subscriptions
      WHERE subscriber_type = $1 AND subscriber_id = $2 AND NOT disabled`,
    [type, id],
  )).rows;
  if (!subs.length) return { sent: 0, failed: 0, total: 0 };

  const payload = JSON.stringify({ title, body, url });
  let sent = 0;
  let failed = 0;

  for (const s of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        { TTL: 3600 },
      );
      sent++;
      await q(
        `UPDATE push_subscriptions SET last_ok_at = now(), fail_count = 0 WHERE id = $1`,
        [s.id],
      ).catch(() => {});
    } catch (e) {
      failed++;
      const code = e && e.statusCode;
      if (code === 404 || code === 410) {
        await q(`UPDATE push_subscriptions SET disabled = true WHERE id = $1`, [s.id]).catch(() => {});
      } else {
        await q(
          `UPDATE push_subscriptions
              SET fail_count = fail_count + 1,
                  disabled = (fail_count + 1 >= $2)
            WHERE id = $1`,
          [s.id, FAIL_LIMIT],
        ).catch(() => {});
      }
    }
  }
  return { sent, failed, total: subs.length };
}
