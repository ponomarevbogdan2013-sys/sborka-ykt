// Мелкие общие утилиты.
import { randomBytes } from "node:crypto";

export const clean = (s, max = 500) =>
  typeof s === "string" ? s.trim().slice(0, max) : "";

export const toInt = (v, max = 9_999_999) => {
  const s = String(v ?? "").replace(/[^\d.-]/g, "");
  if (s === "") return null;
  const n = Math.round(Number(s));
  return Number.isFinite(n) ? Math.max(0, Math.min(max, n)) : null;
};

// нормализация телефона РФ -> "7XXXXXXXXXX"
export function normPhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d[0] === "8") d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  return d;
}
export const phone4 = (raw) => normPhone(raw).slice(-4);

// hex, не base64url: токены уходят в ссылки, которые пересылают через Telegram/WhatsApp —
// base64url содержит "_" (маркер курсива в Markdown), мессенджер мог его съесть и сломать ссылку.
export const newToken = (bytes = 24) => randomBytes(bytes).toString("hex");

export const PHONE_RE = /^[\d+][\d\s()\-]{5,19}$/;
