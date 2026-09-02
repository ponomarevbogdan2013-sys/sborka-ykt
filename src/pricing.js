// Внутренний прайс калькулятора и пересчёт вилки на бэкенде.
// Источник истины по ЦЕНАМ — public/js/app.js (массивы items/addons) и таблица в CLAUDE.md.
// Держать в синхроне с ними. Фронтовому total не доверяем — считаем здесь.
//
// Формула округления — как в public/js/app.js:
//   raw  = (база + фикс.допы) * множитель
//   низ  = округл_до_100(raw)
//   верх = округл_до_100(raw * 1.2)          // от неокруглённого raw

export const ITEMS = [
  { id: "kitchen_mod",  nm: "Кухня модульная",             price: 2500, unit: "шкаф / полка" },
  { id: "kitchen_proj", nm: "Кухня проектная (на заказ)",  price: 3500, unit: "шкаф / полка" },
  { id: "kupe",         nm: "Шкаф-купе",                    price: 5000, unit: "шт" },
  { id: "shkaf",        nm: "Шкаф / комод",                 price: 3000, unit: "шт" },
  { id: "bed",          nm: "Кровать",                      price: 3000, unit: "шт" },
  { id: "sofa",         nm: "Диван",                        price: 3000, unit: "шт" },
  { id: "corner",       nm: "Мягкий уголок",                price: 4000, unit: "шт" },
  { id: "table",        nm: "Стол",                         price: 1500, unit: "шт" },
  { id: "chairs",       nm: "Стулья",                       price: 500,  unit: "шт" },
];

export const ADDONS = [
  { id: "sink",   nm: "Подключить мойку и смеситель",       price: 2000 },
  { id: "cutout", nm: "Врезка в столешницу: мойка, плита",  price: 1500 },
  { id: "demo",   nm: "Демонтаж старой мебели",             price: 2000 },
  { id: "trash",  nm: "Вынос мусора",                       price: 1000 },
  { id: "hang",   nm: "Навеска: полки, ТВ, карнизы",        price: 1000 },
  { id: "urgent", nm: "Срочно, прямо сейчас",               price: 0, mult: 1.3 },
];

const ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
const ADDON_BY_ID = Object.fromEntries(ADDONS.map((a) => [a.id, a]));

const round100 = (n) => Math.round(n / 100) * 100;

// Нормализует items к парам [id, qty]. Принимает [{id,qty}] (в т.ч. с лишними
// полями nm/price из getCalcState) или объект {id:qty}.
function itemPairs(items) {
  if (Array.isArray(items)) {
    return items.map((it) => [String(it && it.id), it ? it.qty : 0]);
  }
  if (items && typeof items === "object") {
    return Object.entries(items);
  }
  return [];
}

// Нормализует addons к списку id. Принимает ["sink",...] или [{id:"sink",...}].
function addonIds(addons) {
  if (!Array.isArray(addons)) return [];
  return addons.map((a) => (a && typeof a === "object" ? String(a.id) : String(a)));
}

// Возвращает { base, low, high, itemsResolved, addonsResolved }. Суммы — целые ₽.
export function calcEstimate(items = [], addons = []) {
  let base = 0;
  const itemsResolved = [];
  for (const [id, qtyRaw] of itemPairs(items)) {
    const it = ITEM_BY_ID[id];
    const qty = Math.max(0, Math.min(999, Math.floor(Number(qtyRaw) || 0)));
    if (!it || qty === 0) continue;
    const sum = it.price * qty;
    base += sum;
    itemsResolved.push({ id, nm: it.nm, qty, unit: it.unit, sum });
  }

  let add = 0;
  let mult = 1;
  const addonsResolved = [];
  for (const id of addonIds(addons)) {
    const a = ADDON_BY_ID[id];
    if (!a) continue;
    if (a.mult) mult = a.mult;
    else add += a.price;
    addonsResolved.push({ id: a.id, nm: a.nm, price: a.price, mult: a.mult || null });
  }

  const raw = (base + add) * mult;
  const low = round100(raw);
  const high = round100(raw * 1.2);
  return { base, low, high, itemsResolved, addonsResolved };
}
