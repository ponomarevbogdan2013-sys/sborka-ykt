// Абстракция каналов уведомлений: notify(text) шлёт во все включённые каналы.
// Сейчас включён Telegram. WhatsApp (Green API), Max, SMS добавляются здесь же,
// без изменения вызывающего кода. SMS — обязательный запасной канал (Этап 2+).

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_OWNER_CHAT_ID || "";

async function sendTelegram(text) {
  if (!TG_TOKEN || !TG_CHAT) {
    return { channel: "telegram", ok: false, skipped: "нет TELEGRAM_BOT_TOKEN / TELEGRAM_OWNER_CHAT_ID" };
  }
  try {
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: TG_CHAT,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json();
    return { channel: "telegram", ok: !!data.ok, error: data.ok ? null : data.description };
  } catch (e) {
    return { channel: "telegram", ok: false, error: e.message };
  }
}

// Заглушки — включатся, когда появятся доступы.
async function sendWhatsApp() {
  return { channel: "whatsapp", ok: false, skipped: "Green API не настроен" };
}
async function sendSms() {
  return { channel: "sms", ok: false, skipped: "SMS-провайдер не настроен" };
}

const CHANNELS = [sendTelegram, sendWhatsApp, sendSms];

export async function notify(text) {
  const results = await Promise.all(CHANNELS.map((fn) => fn(text)));
  const okAny = results.some((r) => r.ok);
  for (const r of results) {
    if (r.ok) console.log(`уведомление → ${r.channel}: ок`);
    else if (r.skipped) console.log(`уведомление → ${r.channel}: пропущено (${r.skipped})`);
    else console.warn(`уведомление → ${r.channel}: ошибка (${r.error})`);
  }
  return { okAny, results };
}

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Форматирование заявки для владельца.
export function formatLead(lead) {
  const money = (n) => (n == null ? "—" : Number(n).toLocaleString("ru-RU") + " ₽");
  const lines = [];
  lines.push(`<b>Новая заявка №${lead.id}</b>`);
  lines.push("");
  lines.push(`<b>${esc(lead.name)}</b> · <a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a>`);
  if (lead.address) lines.push(`Адрес: ${esc(lead.address)}`);
  if (lead.preferred_date || lead.preferred_time)
    lines.push(`Когда: ${esc(lead.preferred_date || "")} ${esc(lead.preferred_time || "")}`.trim());
  lines.push("");
  if (Array.isArray(lead.items) && lead.items.length) {
    lines.push("<b>Что собрать:</b>");
    for (const it of lead.items) lines.push(`• ${esc(it.nm)} × ${esc(it.qty)} ${esc(it.unit || "")}`.trim());
  }
  if (Array.isArray(lead.addons) && lead.addons.length) {
    lines.push("<b>Доп:</b> " + lead.addons.map((a) => esc(a.nm)).join(", "));
  }
  lines.push("");
  lines.push(`Расчёт (вилка): <b>${money(lead.calc_low)} – ${money(lead.calc_high)}</b>`);
  lines.push(`Бюджет клиента: ${money(lead.budget_rub)}`);
  if (lead.comment) lines.push(`Комментарий: ${esc(lead.comment)}`);
  if (Array.isArray(lead.photos) && lead.photos.length)
    lines.push(`Фото: ${lead.photos.length} шт (в /admin)`);
  if (lead.ref) lines.push(`Источник: ${esc(lead.ref)}`);
  return lines.join("\n");
}
