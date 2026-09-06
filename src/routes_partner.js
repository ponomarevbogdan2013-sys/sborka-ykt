// Эндпоинты партнёра (/api/partner/*) + QR (/qr/:code.png) + учёт переходов ?ref=
// + создание аккаунтов партнёров админом (открытой регистрации нет).
// Клиент партнёра (p.html + p.js) — зона дизайн-Claude. Контракт полей — как в public/js/p.js.
import QRCode from "qrcode";
import { q } from "./db.js";
import { clean, toInt, normPhone, PHONE_RE } from "./util.js";
import {
  hashPassword, verifyPassword, createSession, destroySession,
  setSidCookie, clearSidCookie, readSession, SID_COOKIE,
} from "./auth.js";

const RL_LOGIN = { config: { rateLimit: { max: 10, timeWindow: "5 minutes" } } };
const TIERS = ["base", "silver", "gold"];

// Публичный адрес сайта: из PUBLIC_BASE_URL или по заголовкам запроса (trustProxy включён).
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
const baseUrl = (req) => PUBLIC_BASE || `${req.protocol}://${req.headers.host}`;
const refLink = (req, code) => `${baseUrl(req)}/?ref=${code}`;
const qrUrl = (code) => `/qr/${code}.png`;

const CODE_RE = /[^a-z0-9_-]/g;
const normCode = (s) => clean(s, 40).toLowerCase().replace(CODE_RE, "");

// Заголовок заказа для списка партнёра — из позиций заявки (у orders нет поля title).
function orderTitle(items, id) {
  const names = Array.isArray(items) ? items.map((i) => i && i.nm).filter(Boolean) : [];
  if (!names.length) return "Заявка №" + id;
  const head = names.slice(0, 3).join(", ");
  return names.length > 3 ? head + "…" : head;
}

// Сводка кабинета. Деньги считаем «на лету» из orders + partner_payouts,
// чтобы не зависеть от отдельного шага начисления:
//   заработано  = Σ partner_commission_rub по выполненным заказам с этим ref
//   баланс      = заработано − выплачено(paid) − уже запрошено(requested)
async function partnerMe(p, req) {
  const s = (await q(
    `SELECT
       (SELECT COUNT(*)::int FROM partner_clicks WHERE partner_code = $1) AS clicks,
       (SELECT COUNT(*)::int FROM orders WHERE ref = $1) AS orders_count,
       (SELECT COUNT(*)::int FROM orders WHERE ref = $1 AND status = 'done') AS done_count,
       (SELECT COALESCE(SUM(partner_commission_rub),0)::int FROM orders
          WHERE ref = $1 AND status = 'done' AND partner_commission_rub IS NOT NULL) AS total_earned_rub,
       (SELECT COALESCE(SUM(amount_rub),0)::int FROM partner_payouts
          WHERE partner_code = $1 AND status = 'paid') AS paid_rub,
       (SELECT COALESCE(SUM(amount_rub),0)::int FROM partner_payouts
          WHERE partner_code = $1 AND status = 'requested') AS pending_rub`,
    [p.code],
  )).rows[0];

  const balance = Math.max(0, s.total_earned_rub - s.paid_rub - s.pending_rub);
  return {
    title: p.title,
    tier: TIERS.includes(p.tier) ? p.tier : "base",
    commission_pct: Number(p.commission_pct),
    clicks: s.clicks,
    orders_count: s.orders_count,
    done_count: s.done_count,
    total_earned_rub: s.total_earned_rub,
    balance_rub: balance,
    ref_link: refLink(req, p.code),
    qr_url: qrUrl(p.code),
  };
}

// Транслит для автогенерации code из названия магазина.
const TR = {
  а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i",
  й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t",
  у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "",
  э: "e", ю: "yu", я: "ya",
};
const slug = (s) =>
  String(s).toLowerCase().split("").map((c) => (c in TR ? TR[c] : c)).join("")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "partner";

async function uniqueCode(title) {
  const base = slug(title);
  for (let i = 0; i < 50; i++) {
    const cand = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await q(`SELECT 1 FROM partners WHERE code = $1`, [cand])).rowCount) return cand;
  }
  return `${base}-${Date.now().toString(36)}`;
}

export default function registerPartnerRoutes(app) {
  // preHandler: требует сессию партнёра, кладёт активную запись в req.partner.
  async function requirePartner(req, reply) {
    const sess = await readSession(req);
    if (!sess || sess.userType !== "partner")
      return reply.code(401).send({ ok: false, error: "нужен вход" });
    const p = (await q(`SELECT * FROM partners WHERE id = $1`, [sess.userId])).rows[0];
    if (!p || !p.active)
      return reply.code(401).send({ ok: false, error: "аккаунт недоступен" });
    req.partner = p;
  }

  // ============ Учёт переходов по ?ref=<code> ============
  // Ставим cookie `ref` (атрибуция при оформлении заявки) и пишем строку в partner_clicks.
  // Один переход на сессию: если cookie уже равен этому code — не считаем повторно.
  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET") return;
    const ref = normCode(String(req.query?.ref || ""));
    if (!ref || req.cookies?.ref === ref) return;
    const p = await q(`SELECT 1 FROM partners WHERE code = $1 AND active`, [ref]);
    if (!p.rowCount) return;
    reply.setCookie("ref", ref, {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 180,
      secure: process.env.COOKIE_SECURE === "1",
    });
    q(
      `INSERT INTO partner_clicks (partner_code, ip, user_agent, landing_path)
       VALUES ($1,$2,$3,$4)`,
      [
        ref,
        req.ip || null,
        String(req.headers["user-agent"] || "").slice(0, 300) || null,
        String(req.raw?.url || req.url || "").slice(0, 200),
      ],
    ).catch(() => {});
  });

  // ============ QR со ссылкой ?ref=<code> ============
  app.get("/qr/:code.png", async (req, reply) => {
    const code = normCode(req.params.code);
    if (!code) return reply.code(404).send();
    const ok = await q(`SELECT 1 FROM partners WHERE code = $1 AND active`, [code]);
    if (!ok.rowCount) return reply.code(404).send();
    const png = await QRCode.toBuffer(refLink(req, code), {
      type: "png",
      width: 512,
      margin: 1,
      errorCorrectionLevel: "M",
      color: { dark: "#1b3a5b", light: "#ffffff" },
    });
    return reply
      .type("image/png")
      .header("Cache-Control", "public, max-age=86400")
      .send(png);
  });

  // ============ АДМИН: создать / список партнёров, разрешить выплату ============
  app.post("/api/admin/partners", { onRequest: app.basicAuth }, async (req, reply) => {
    const b = req.body || {};
    const title = clean(b.title, 120);
    const phoneRaw = clean(b.phone, 24);
    const password = String(b.password || "");
    const tier = TIERS.includes(b.tier) ? b.tier : "base";
    const commissionPct = b.commission_pct != null && b.commission_pct !== ""
      ? Number(b.commission_pct) : null;
    let code = normCode(b.code);

    if (title.length < 2) return reply.code(400).send({ ok: false, error: "укажите название" });
    if (!PHONE_RE.test(phoneRaw)) return reply.code(400).send({ ok: false, error: "проверьте телефон" });
    const phone = normPhone(phoneRaw);
    if (phone.length < 10) return reply.code(400).send({ ok: false, error: "проверьте телефон" });
    if (password.length < 6) return reply.code(400).send({ ok: false, error: "пароль от 6 символов" });
    if (commissionPct != null && (!Number.isFinite(commissionPct) || commissionPct < 0 || commissionPct > 100))
      return reply.code(400).send({ ok: false, error: "комиссия 0–100" });

    if (code) {
      if ((await q(`SELECT 1 FROM partners WHERE code = $1`, [code])).rowCount)
        return reply.code(409).send({ ok: false, error: "code занят" });
    } else {
      code = await uniqueCode(title);
    }
    if ((await q(`SELECT 1 FROM partners WHERE phone = $1`, [phone])).rowCount)
      return reply.code(409).send({ ok: false, error: "партнёр с таким телефоном уже есть" });

    const ins = await q(
      `INSERT INTO partners (code, title, phone, password_hash, tier, active, commission_pct)
       VALUES ($1,$2,$3,$4,$5,true, COALESCE($6, 8.0))
       RETURNING code, id, tier, commission_pct`,
      [code, title, phone, await hashPassword(password), tier, commissionPct],
    );
    const row = ins.rows[0];
    return {
      ok: true,
      code: row.code,
      id: Number(row.id),
      tier: row.tier,
      commission_pct: Number(row.commission_pct),
      ref_link: refLink(req, row.code),
      qr_url: qrUrl(row.code),
      login_url: "/p",
    };
  });

  app.get("/api/admin/partners", { onRequest: app.basicAuth }, async () => {
    const rows = (await q(
      `SELECT p.code, p.title, p.phone, p.tier, p.commission_pct, p.active,
              (p.password_hash IS NOT NULL) AS has_login,
              (SELECT COUNT(*)::int FROM partner_clicks c WHERE c.partner_code = p.code) AS clicks,
              (SELECT COUNT(*)::int FROM orders o WHERE o.ref = p.code) AS orders_count,
              (SELECT COUNT(*)::int FROM orders o WHERE o.ref = p.code AND o.status = 'done') AS done_count,
              (SELECT COALESCE(SUM(o.partner_commission_rub),0)::int FROM orders o
                 WHERE o.ref = p.code AND o.status = 'done') AS earned_rub,
              (SELECT COALESCE(SUM(pp.amount_rub),0)::int FROM partner_payouts pp
                 WHERE pp.partner_code = p.code AND pp.status = 'requested') AS pending_payout_rub
         FROM partners p
        ORDER BY p.created_at DESC`,
    )).rows;
    return { ok: true, partners: rows.map((r) => ({ ...r, commission_pct: Number(r.commission_pct) })) };
  });

  // Разрешить/отклонить запрос на вывод. 'paid'/'rejected' — только из 'requested'.
  app.post("/api/admin/partners/payouts/:id", { onRequest: app.basicAuth }, async (req, reply) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return reply.code(400).send({ ok: false });
    const action = (req.body || {}).action;
    if (!["paid", "rejected"].includes(action))
      return reply.code(400).send({ ok: false, error: "action: paid | rejected" });
    const r = await q(`SELECT status FROM partner_payouts WHERE id = $1`, [id]);
    if (!r.rowCount) return reply.code(404).send({ ok: false });
    if (r.rows[0].status !== "requested")
      return reply.code(409).send({ ok: false, error: `выплата уже ${r.rows[0].status}` });
    await q(
      `UPDATE partner_payouts
          SET status = $2,
              note = COALESCE($3, note),
              paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END
        WHERE id = $1`,
      [id, action, clean((req.body || {}).note, 300) || null],
    );
    return { ok: true };
  });

  // ============ ПАРТНЁР: вход / выход ============
  app.post("/api/partner/login", RL_LOGIN, async (req, reply) => {
    const b = req.body || {};
    const phone = normPhone(clean(b.phone, 24));
    const password = String(b.password || "");
    const r = await q(
      `SELECT id, password_hash, active FROM partners WHERE phone = $1`, [phone],
    );
    if (!r.rowCount || !r.rows[0].password_hash)
      return reply.code(401).send({ ok: false, error: "неверный телефон или пароль" });
    const p = r.rows[0];
    if (!p.active) return reply.code(403).send({ ok: false, error: "аккаунт отключён" });
    if (!(await verifyPassword(password, p.password_hash)))
      return reply.code(401).send({ ok: false, error: "неверный телефон или пароль" });

    const sess = await createSession("partner", Number(p.id), req);
    setSidCookie(reply, sess.token, sess.expires);
    return { ok: true };
  });

  app.post("/api/partner/logout", async (req, reply) => {
    await destroySession(req.cookies?.[SID_COOKIE]);
    clearSidCookie(reply);
    return { ok: true };
  });

  // ============ ПАРТНЁР: кабинет ============
  app.get("/api/partner/me", { preHandler: requirePartner }, async (req) => {
    return partnerMe(req.partner, req);
  });

  app.get("/api/partner/orders", { preHandler: requirePartner }, async (req) => {
    const rows = (await q(
      `SELECT id, items, status, agreed_price_rub, partner_commission_rub
         FROM orders WHERE ref = $1 ORDER BY created_at DESC LIMIT 200`,
      [req.partner.code],
    )).rows;
    return {
      orders: rows.map((o) => ({
        id: Number(o.id),
        title: orderTitle(o.items, o.id),
        status: o.status,
        agreed_price_rub: o.agreed_price_rub,
        partner_commission_rub: o.partner_commission_rub,
      })),
    };
  });

  app.get("/api/partner/payouts", { preHandler: requirePartner }, async (req) => {
    const rows = (await q(
      `SELECT requested_at, amount_rub, status
         FROM partner_payouts WHERE partner_code = $1
        ORDER BY requested_at DESC LIMIT 100`,
      [req.partner.code],
    )).rows;
    return {
      payouts: rows.map((p) => ({
        requested_at: p.requested_at instanceof Date ? p.requested_at.toISOString() : p.requested_at,
        amount_rub: p.amount_rub,
        status: p.status,
      })),
    };
  });

  // Запрос на вывод. Сумма резервируется сразу (уходит из доступного баланса как
  // 'requested'); админ переводит в 'paid'/'rejected' через /api/admin/partners/payouts/:id.
  app.post("/api/partner/payout", { preHandler: requirePartner }, async (req, reply) => {
    const b = req.body || {};
    const amount = toInt(b.amount_rub);
    const details = clean(b.details, 300);
    if (!amount || amount < 1) return reply.code(400).send({ ok: false, error: "укажите сумму" });
    if (!details) return reply.code(400).send({ ok: false, error: "укажите куда перевести" });

    const me = await partnerMe(req.partner, req);
    if (amount > me.balance_rub)
      return reply.code(400).send({ ok: false, error: `больше доступного (${me.balance_rub} ₽)` });

    await q(
      `INSERT INTO partner_payouts (partner_code, amount_rub, status, note)
       VALUES ($1,$2,'requested',$3)`,
      [req.partner.code, amount, details],
    );
    await q(
      `UPDATE partners
          SET payout_details = jsonb_build_object('text', $2::text, 'updated_at', now()::text)
        WHERE code = $1`,
      [req.partner.code, details],
    ).catch(() => {});
    return { ok: true };
  });
}
