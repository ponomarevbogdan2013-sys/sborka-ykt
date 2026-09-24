// Сервис WhatsApp (Baileys) — отдельный процесс (systemd sborka-wa), слушает только 127.0.0.1.
// Аккаунт номера привязывается как «связанное устройство» по QR. Сессия — в PostgreSQL (wa_auth).
// Отдельно от sborka-web: рестарт сайта не рвёт WhatsApp-сессию (частые переподключения — сигнал для бана).
//
// HTTP (заголовок x-internal-token = MESSENGER_INTERNAL_TOKEN):
//   GET  /status          → { state, me, qr }   state: idle | connecting | qr | open
//   POST /login           → начать привязку (появится QR в /status)
//   POST /logout          → отвязать номер, стереть сессию
//   POST /send {phone,text} → { ok, code?, error? }   code: not_ready | not_registered | bad_phone | send_failed
// Входящие личные сообщения → POST {BACKEND}/api/internal/messenger/incoming (опт-ин клиента).
import "dotenv/config";
import http from "node:http";
import P from "pino";
import {
  makeWASocket, BufferJSON, initAuthCreds, DisconnectReason, fetchLatestBaileysVersion,
  proto, Browsers, jidDecode, isPnUser,
} from "baileys";
import { q, pool } from "./db.js";

const PORT = Number(process.env.WA_PORT || 3101);
const TOKEN = process.env.MESSENGER_INTERNAL_TOKEN || "";
const BACKEND = `http://127.0.0.1:${process.env.PORT || 3000}`;
const MIN_GAP_MS = Number(process.env.MESSENGER_MIN_GAP_SEC || 20) * 1000;

if (!TOKEN) {
  console.error("wa: нет MESSENGER_INTERNAL_TOKEN в .env — останавливаюсь");
  process.exit(1);
}

const logger = P({ level: process.env.WA_LOG_LEVEL || "warn" });

// ---------- auth state в PostgreSQL (аналог useMultiFileAuthState) ----------
async function readRow(id) {
  const r = await q(`SELECT data FROM wa_auth WHERE id = $1`, [id]);
  return r.rowCount ? JSON.parse(r.rows[0].data, BufferJSON.reviver) : null;
}
async function writeRow(id, value) {
  await q(
    `INSERT INTO wa_auth (id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [id, JSON.stringify(value, BufferJSON.replacer)],
  );
}
async function useDbAuthState() {
  const creds = (await readRow("creds")) || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const out = {};
          await Promise.all(ids.map(async (id) => {
            let v = await readRow(`${type}-${id}`);
            if (type === "app-state-sync-key" && v) v = proto.Message.AppStateSyncKeyData.fromObject(v);
            out[id] = v;
          }));
          return out;
        },
        set: async (data) => {
          const tasks = [];
          for (const cat in data) {
            for (const id in data[cat]) {
              const v = data[cat][id];
              tasks.push(v ? writeRow(`${cat}-${id}`, v) : q(`DELETE FROM wa_auth WHERE id = $1`, [`${cat}-${id}`]));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeRow("creds", creds),
  };
}

// ---------- сокет ----------
let sock = null;
let state = "idle";
let lastQr = null;
let me = null;
let retry = 0;

async function hasSession() {
  const c = await readRow("creds");
  return !!(c && c.me);   // после привязки по QR в creds появляется me
}

async function connect() {
  if (sock) return;
  state = "connecting";
  const { state: auth, saveCreds } = await useDbAuthState();
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  const s = makeWASocket({
    version,
    auth,
    logger,
    browser: Browsers.ubuntu("Chrome"),
    markOnlineOnConnect: false,   // не «в сети» постоянно — на телефоне продолжают приходить уведомления
    syncFullHistory: false,
    getMessage: async () => undefined,
  });
  sock = s;

  s.ev.on("creds.update", saveCreds);

  s.ev.on("connection.update", async (u) => {
    if (u.qr) { lastQr = u.qr; state = "qr"; }
    if (u.connection === "open") {
      state = "open"; lastQr = null; retry = 0;
      me = s.user ? { id: s.user.id, name: s.user.name || null, phone: jidDecode(s.user.id)?.user || null } : null;
      console.log(`wa: подключён как +${me?.phone || "?"}`);
    }
    if (u.connection === "close") {
      const code = u.lastDisconnect?.error?.output?.statusCode;
      sock = null; me = null;
      if (code === DisconnectReason.loggedOut) {
        console.warn("wa: номер отвязан (logged out) — стираю сессию");
        await q(`DELETE FROM wa_auth`).catch(() => {});
        state = "idle"; lastQr = null;
        return;
      }
      if (code === DisconnectReason.restartRequired) {
        // штатно сразу после сканирования QR: WhatsApp просит переподключиться уже с сессией
        setTimeout(() => connect().catch((e) => console.error("wa connect:", e.message)), 500);
        return;
      }
      if (state === "qr" && !(await hasSession())) {
        // QR так и не отсканировали — не крутим привязку бесконечно, ждём нового /login
        console.warn("wa: QR не отсканирован, привязка остановлена");
        state = "idle"; lastQr = null;
        return;
      }
      retry++;
      const delay = Math.min(60_000, 2_000 * retry);
      console.warn(`wa: соединение закрыто (код ${code ?? "?"}), переподключение через ${delay / 1000}с`);
      state = "connecting";
      setTimeout(() => connect().catch((e) => console.error("wa connect:", e.message)), delay);
    }
  });

  s.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;
    for (const m of messages) {
      try {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid || "";
        if (jid.endsWith("@g.us") || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
        // Номер: сам jid (если это номер), иначе альтернативный jid (WhatsApp прячет номер за LID)
        const pnJid = isPnUser(jid) ? jid : [m.key.remoteJidAlt, m.key.senderPn].find((j) => j && isPnUser(j));
        const phone = pnJid ? jidDecode(pnJid)?.user : null;
        if (!phone) continue;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";
        await fetch(`${BACKEND}/api/internal/messenger/incoming`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-internal-token": TOKEN },
          body: JSON.stringify({ channel: "whatsapp", phone, text: text.slice(0, 500) }),
        }).catch((e) => console.warn("wa → backend:", e.message));
      } catch (e) {
        console.warn("wa incoming:", e.message);
      }
    }
  });
}

// ---------- отправка: строго по одному, с паузой и «печатает…» ----------
let chain = Promise.resolve();
let lastSentAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(phone, text) {
  const job = chain.then(async () => {
    if (state !== "open" || !sock) return { ok: false, code: "not_ready", error: "WhatsApp не подключён" };
    const digits = String(phone || "").replace(/\D/g, "");
    if (digits.length < 10) return { ok: false, code: "bad_phone", error: "плохой номер" };
    const wait = lastSentAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    try {
      const [res] = (await sock.onWhatsApp(digits)) || [];
      if (!res || !res.exists) return { ok: false, code: "not_registered", error: "номер не в WhatsApp" };
      const jid = res.jid;
      await sock.sendPresenceUpdate("composing", jid).catch(() => {});
      await sleep(1500 + Math.round(Math.random() * 2000) + Math.min(3000, text.length * 25));
      await sock.sendPresenceUpdate("paused", jid).catch(() => {});
      const sent = await sock.sendMessage(jid, { text });
      lastSentAt = Date.now();
      return { ok: true, id: sent?.key?.id || null };
    } catch (e) {
      lastSentAt = Date.now();
      return { ok: false, code: "send_failed", error: e.message };
    }
  });
  chain = job.catch(() => {});
  return job;
}

// ---------- HTTP ----------
const readJson = (req) => new Promise((resolve) => {
  let b = "";
  req.on("data", (c) => { b += c; if (b.length > 20_000) req.destroy(); });
  req.on("end", () => { try { resolve(JSON.parse(b || "{}")); } catch { resolve({}); } });
});

const server = http.createServer(async (req, res) => {
  const out = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  if (req.headers["x-internal-token"] !== TOKEN) return out(403, { ok: false });
  try {
    if (req.method === "GET" && req.url === "/status") return out(200, { ok: true, state, me, qr: lastQr });
    if (req.method === "POST" && req.url === "/login") {
      if (!sock) await connect();
      return out(200, { ok: true, state });
    }
    if (req.method === "POST" && req.url === "/logout") {
      if (sock) await sock.logout().catch(() => {});
      sock?.end?.(undefined);
      sock = null; me = null; lastQr = null; state = "idle";
      await q(`DELETE FROM wa_auth`);
      return out(200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/send") {
      const b = await readJson(req);
      if (!b.text) return out(400, { ok: false, error: "нет текста" });
      return out(200, await send(b.phone, String(b.text).slice(0, 2000)));
    }
    out(404, { ok: false });
  } catch (e) {
    out(500, { ok: false, error: e.message });
  }
});

server.listen(PORT, "127.0.0.1", async () => {
  console.log(`wa: сервис на 127.0.0.1:${PORT}`);
  if (await hasSession()) connect().catch((e) => console.error("wa connect:", e.message));
  else console.log("wa: номер не привязан — ждём /login (QR в админке)");
});

const stop = async () => { server.close(); sock?.end?.(undefined); await pool.end().catch(() => {}); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("unhandledRejection", (e) => console.error("wa unhandledRejection:", e?.message || e));
