/* СБОРКА — связь формы заявки с бэкендом. Файл бэкенд-Claude.
   Вёрстку/классы не трогает: читает состояние калькулятора из DOM,
   по клику на кнопку отправки шлёт JSON на POST /api/lead.

   Нужные id в разметке (добавляет дизайн-Claude, см. список полей):
     #leadName #leadPhone #leadAddress #leadDate #leadTime
     #leadSubmit (кнопка), #leadMsg (место под ответ)
   Пока каких-то id нет — соответствующее поле уходит пустым,
   бэкенд ответит ошибкой валидации (имя/телефон обязательны). */

(function () {
  "use strict";

  // Порядок допов — как в public/js/app.js и src/pricing.js.
  var ADDON_IDS = ["sink", "demo", "trash", "hang", "urgent"];

  var API_URL = "/api/lead";

  function $(sel) { return document.querySelector(sel); }
  function digits(s) { return String(s == null ? "" : s).replace(/\D/g, ""); }

  // Количества из калькулятора: <span id="q_<id>">N</span> внутри #calcList
  function readItems() {
    var out = [];
    document.querySelectorAll('#calcList span[id^="q_"]').forEach(function (span) {
      var id = span.id.slice(2);
      var qty = parseInt(span.textContent, 10) || 0;
      if (id && qty > 0) out.push({ id: id, qty: qty });
    });
    return out;
  }

  // Выбранные допы: .addon с классом .sel внутри #addonList, по порядку рендера
  function readAddons() {
    var out = [];
    document.querySelectorAll("#addonList .addon").forEach(function (el, i) {
      if (el.classList.contains("sel") && ADDON_IDS[i]) out.push(ADDON_IDS[i]);
    });
    return out;
  }

  function readDatetime() {
    var d = $("#leadDate") ? $("#leadDate").value : "";
    var t = $("#leadTime") ? $("#leadTime").value : "";
    return [d, t].filter(Boolean).join(" ");
  }

  function refFromUrl() {
    try {
      var p = new URLSearchParams(location.search);
      return (p.get("ref") || p.get("start") || "")
        .toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    } catch (e) { return ""; }
  }

  function showMsg(text, ok) {
    var box = $("#leadMsg");
    if (box) {
      box.textContent = text;
      box.hidden = false;
      box.style.color = ok ? "var(--green)" : "#d9534f";
    } else {
      alert(text);
    }
  }

  function findButton() {
    return (
      $("#leadSubmit") ||
      document.querySelector(
        '.role[data-role="client"] [data-cview="calc"] button.btn.primary'
      )
    );
  }

  async function submit(btn) {
    var name = $("#leadName") ? $("#leadName").value.trim() : "";
    var phone = $("#leadPhone") ? $("#leadPhone").value.trim() : "";

    if (name.length < 2) return showMsg("Укажите, как к вам обращаться", false);
    if (digits(phone).length < 6) return showMsg("Проверьте номер телефона", false);

    var body = {
      name: name,
      phone: phone,
      items: readItems(),
      addons: readAddons(),
      address: $("#leadAddress") ? $("#leadAddress").value.trim() : "",
      datetime: readDatetime(),
      budget: digits($("#budgetInp") ? $("#budgetInp").value : ""),
      total: $("#calcTotal") ? $("#calcTotal").textContent : "",
      ref: refFromUrl()
    };

    var prev = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Отправляю…"; }

    try {
      var res = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      var data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data && data.error ? data.error : "Не удалось отправить заявку");

      var est = data.estimate
        ? " Ориентир: " + data.estimate.low.toLocaleString("ru-RU") +
          " – " + data.estimate.high.toLocaleString("ru-RU") + " ₽."
        : "";
      showMsg("Заявка №" + data.id + " принята. Перезвоним и подберём мастера." + est, true);
      if (btn) btn.textContent = "Заявка отправлена";
    } catch (err) {
      showMsg(err.message, false);
      if (btn) { btn.disabled = false; btn.textContent = prev || "Найти мастера →"; }
    }
  }

  function init() {
    var btn = findButton();
    if (!btn) return;
    btn.addEventListener("click", function () { submit(btn); });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
