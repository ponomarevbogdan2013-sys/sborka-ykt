// Пересчёт вилки на бэкенде. ЦЕН ЗДЕСЬ НЕТ — единственный источник прайса public/catalog.json
// (его же берёт браузер через fetch). Читается один раз при старте: правка прайса = правка
// catalog.json + рестарт sborka-web. Фронтовому total не доверяем — считаем здесь.
//
// Формула (та же в public/js/app.js → recalc):
//   raw  = (сумма позиций + фикс. допы) * множитель
//   низ  = округл_до_100(raw)
//   верх = округл_до_100(raw * 1.2)          // от неокруглённого raw
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const CATALOG_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "catalog.json");
export const CATALOG = JSON.parse(readFileSync(CATALOG_PATH, "utf8"));
export const DEFAULT_CATEGORY = "furniture";

const BY_CAT = Object.fromEntries(
  Object.entries(CATALOG).map(([code, c]) => [code, {
    items: Object.fromEntries((c.items || []).map((i) => [i.id, i])),
    addons: Object.fromEntries((c.addons || []).map((a) => [a.id, a])),
  }]),
);

export const categoryLabel = (code) => (CATALOG[code] && CATALOG[code].label) || code || "";

const round100 = (n) => Math.round(n / 100) * 100;
const clampQty = (v) => Math.max(0, Math.min(999, Math.floor(Number(v) || 0)));

// items: [{id,qty}] (лишние поля nm/price из getCalcState игнорируются) или объект {id:qty}.
function itemPairs(items) {
  if (Array.isArray(items)) return items.map((it) => [String(it && it.id), it ? it.qty : 0]);
  if (items && typeof items === "object") return Object.entries(items);
  return [];
}

// addons: ["sink",...] или [{id,qty?}]. qty нужен только поштучным допам (с unit); без qty — 1.
function addonPairs(addons) {
  if (!Array.isArray(addons)) return [];
  return addons.map((a) => (a && typeof a === "object" ? [String(a.id), a.qty ?? 1] : [String(a), 1]));
}

// Позиции и допы, которых нет в каталоге ЭТОЙ категории, отбрасываются (чужие не считаем).
// Возвращает { base, low, high, itemsResolved, addonsResolved }. Суммы — целые ₽.
export function calcEstimate(category, items = [], addons = []) {
  const cat = BY_CAT[category] || BY_CAT[DEFAULT_CATEGORY];
  let base = 0;
  const itemsResolved = [];
  for (const [id, qtyRaw] of itemPairs(items)) {
    const it = cat.items[id];
    const qty = clampQty(qtyRaw);
    if (!it || qty === 0) continue;
    const sum = it.pr * qty;
    base += sum;
    itemsResolved.push({ id, nm: it.nm, qty, unit: it.unit, sum });
  }

  let add = 0;
  let mult = 1;
  const addonsResolved = [];
  for (const [id, qtyRaw] of addonPairs(addons)) {
    const a = cat.addons[id];
    if (!a) continue;
    const qty = a.unit ? clampQty(qtyRaw) : 1;
    if (qty === 0) continue;
    if (a.mult) mult = a.mult;
    else add += a.pr * qty;
    addonsResolved.push({
      id: a.id,
      nm: a.unit ? `${a.nm} × ${qty} ${a.unit}` : a.nm,
      price: a.pr * qty,
      mult: a.mult || null,
      ...(a.unit ? { qty } : {}),
    });
  }

  const raw = (base + add) * mult;
  return { base, low: round100(raw), high: round100(raw * 1.2), itemsResolved, addonsResolved };
}
