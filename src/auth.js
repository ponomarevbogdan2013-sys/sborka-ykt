// Пароли (builtin crypto.scrypt, без нативных зависимостей) + серверные сессии.
import { scrypt, randomBytes, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { q } from "./db.js";

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_DAYS || 30)) * 24 * 3600 * 1000;
export const SID_COOKIE = "sid";

// формат хранения: s2$<saltHex>$<hashHex>
export async function hashPassword(pw) {
  const salt = randomBytes(16);
  const dk = await scryptAsync(String(pw), salt, SCRYPT.keylen, SCRYPT);
  return `s2$${salt.toString("hex")}$${dk.toString("hex")}`;
}

export async function verifyPassword(pw, stored) {
  if (typeof stored !== "string") return false;
  const [tag, saltHex, hashHex] = stored.split("$");
  if (tag !== "s2" || !saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const want = Buffer.from(hashHex, "hex");
  const got = await scryptAsync(String(pw), salt, want.length, SCRYPT);
  return want.length === got.length && timingSafeEqual(want, got);
}

const newSid = () => randomBytes(32).toString("base64url");

export async function createSession(userType, userId, req) {
  const token = newSid();
  const expires = new Date(Date.now() + SESSION_TTL_MS);
  await q(
    `INSERT INTO sessions (token, user_type, user_id, expires_at, last_seen_at, user_agent, ip)
     VALUES ($1,$2,$3,$4, now(), $5, $6)`,
    [token, userType, userId, expires, String(req.headers["user-agent"] || "").slice(0, 300) || null, req.ip || null],
  );
  return { token, expires };
}

export async function readSession(req) {
  const token = req.cookies?.[SID_COOKIE];
  if (!token) return null;
  const r = await q(
    `SELECT user_type, user_id, expires_at FROM sessions WHERE token = $1`, [token],
  );
  if (!r.rowCount) return null;
  if (new Date(r.rows[0].expires_at).getTime() < Date.now()) {
    await q(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
    return null;
  }
  q(`UPDATE sessions SET last_seen_at = now() WHERE token = $1`, [token]).catch(() => {});
  return { token, userType: r.rows[0].user_type, userId: Number(r.rows[0].user_id) };
}

export async function destroySession(token) {
  if (token) await q(`DELETE FROM sessions WHERE token = $1`, [token]).catch(() => {});
}

export function setSidCookie(reply, token, expires) {
  reply.setCookie(SID_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.COOKIE_SECURE === "1", // включить, когда будет HTTPS/домен
    expires,
  });
}
export function clearSidCookie(reply) {
  reply.clearCookie(SID_COOKIE, { path: "/" });
}

// Фабрика preHandler: требует сессию нужного типа. Кладёт req.user = { userType, userId }.
export function requireRole(userType) {
  return async (req, reply) => {
    const s = await readSession(req);
    if (!s || s.userType !== userType) {
      return reply.code(401).send({ ok: false, error: "нужен вход" });
    }
    req.user = s;
  };
}
