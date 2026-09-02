// Внутренний прайс калькулятора и пересчёт вилки на бэкенде.
// Источник истины по ЦЕНАМ — public/js/app.js (массивы items/addons) и таблица в CLAUDE.md.
// Этот файл держится с ними в синхроне; фронтовому total не доверяем — считаем здесь.
//
// Формула округления — как в public/js/app.js:
//   raw  = (база + фикс.допы) * множитель
//   низ  = округл_до_100(raw)
//   верх = округл_до_100(raw * 1.2)          // именно от неокруглённого raw

export const ITEMS = [
  { id: "kitchen_mod",  nm: "Кухня модульная (с магазина)", price: 5000, unit: "за метр" },
  { id: "kitchen_proj", nm: "Кухня на заказ (проектная)",    price: 8000, unit: "за метр" },
  { id: "kupe",         nm: "Шкаф-купе",                      price: 5000, unit: "шт" },
  { id: "shkaf",        nm: "Шкаф / комод",                   price: 3000, unit: "шт" },
  { id: "bed",          nm: "Кровать",                        price: 3000, unit: "шт" },
  { id: "sofa",         nm: "Диван",                          price: 3000, unit: "шт" },
  { id: "corner",       nm: "Мягкий уголок",                  price: 4000, unit: "шт" },
  { id: "table",        nm: "Стол",                           price: 1500, unit: "шт" },
  { id: "chairs",       nm: "Стулья",                         price: 500,  unit: "шт" },
];

export const ADDONS = [
  { id: "sink",   nm: "Подключить мойку и смеситель", price: 2000 },
  { id: "demo",   nm: "Демонтаж старой мебели",       price: 2000 },
  { id: "trash",  nm: "Вывоз мусора",                 price: 1000 },
  { id: "hang",   nm: "Навеска: полки, ТВ, карнизы",  price: 1000 },
  { id: "urgent", nm: "Срочно, прямо сейчас",         price: 0, mult: 1.3 },
];

const ITEM_BY_ID = Object.fromEntries(ITEMS.map((i) => [i.id, i]));
const ADDON_BY_ID = Object.fromEntries(ADDONS.map((a) => [a.id, a]));

const round100 = (n) => Math.round(n / 100) * 100;

// Нормализует items к парам [id, qty].
// Принимает и контрактный формат [{id,qty}], и объект {id:qty}.
function itemPairs(items) {
  if (Array.isArray(items)) {
    return items.map((it) => [String(it && it.id), it ? it.qty : 0]);
  }
  if (items && typeof items === "object") {
    return Object.entries(items);
  }
  return [];
}

// items:  [{id,qty}]  (или {id:qty})
// addons: [id]
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
  for (const id of Array.isArray(addons) ? addons : []) {
    const a = ADDON_BY_ID[String(id)];
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
