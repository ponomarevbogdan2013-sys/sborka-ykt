/* СБОРКА — связь формы заявки с бэкендом. Файл бэкенд-Claude.
   Вёрстку и классы не трогает. Работает по контракту из public/js/app.js:
     window.getCalcState() -> { items, addons, total }
     window.showThanks()   -> показать экран «Заявка принята»
   Поля формы: #f_name #f_phone #f_address #f_date #f_time #budgetInp
               #f_photos (file, multiple)  #leadSubmit  #formErr (div, hidden) */

(function () {
  "use strict";

  var API_URL = "/api/lead";
  var $ = function (id) { return document.getElementById(id); };
  var digits = function (s) { return String(s == null ? "" : s).replace(/\D/g, ""); };

  function showErr(msg) {
    var el = $("formErr");
    if (el) { el.textContent = msg; el.hidden = false; }
    else alert(msg);
  }
  function clearErr() {
    var el = $("formErr");
    if (el) el.hidden = true;
  }

  function refFromUrl() {
    try {
      var p = new URLSearchParams(location.search);
      return (p.get("ref") || p.get("start") || "")
        .toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
    } catch (e) { return ""; }
  }

  async function submit(btn) {
    clearErr();

    var name = ($("f_name") && $("f_name").value || "").trim();
    var phone = ($("f_phone") && $("f_phone").value || "").trim();
    if (name.length < 2) return showErr("Напишите, как к вам обращаться");
    if (digits(phone).length < 10) return showErr("Проверьте номер телефона");

    var order = (typeof window.getCalcState === "function")
      ? window.getCalcState()
      : { items: [], addons: [], total: {} };

    var fd = new FormData();
    fd.append("name", name);
    fd.append("phone", phone);
    fd.append("address", ($("f_address") && $("f_address").value || "").trim());
    fd.append("district", ($("f_district") && $("f_district").value) || "");
    fd.append("date", ($("f_date") && $("f_date").value) || "");
    fd.append("time", ($("f_time") && $("f_time").value) || "");
    fd.append("budget", digits($("budgetInp") && $("budgetInp").value));
    fd.append("order", JSON.stringify(order));
    fd.append("ref", refFromUrl());

    var picker = $("f_photos");
    if (picker && picker.files) {
      for (var i = 0; i < picker.files.length && i < 6; i++) {
        fd.append("photos", picker.files[i], picker.files[i].name);
      }
    }

    var prevText = btn ? btn.textContent : "";
    if (btn) { btn.disabled = true; btn.textContent = "Отправляем…"; }

    try {
      var res = await fetch(API_URL, { method: "POST", body: fd });
      var data = null;
      try { data = await res.json(); } catch (e) { /* ignore */ }
      if (!res.ok || !data || !data.ok) {
        throw new Error((data && data.error) || "Не удалось отправить заявку. Попробуйте ещё раз.");
      }

      // токен клиента: запомнить + показать ссылку «Смотреть отклики»
      if (data.token) {
        try { localStorage.setItem("sborka_token", data.token); } catch (e) {}
        var link = $("trackLink");
        if (link) {
          link.href = data.url || ("/z/" + data.token);
          link.style.display = "block";
        }
      }

      if (typeof window.showThanks === "function") window.showThanks();
      else showErr("Заявка №" + data.id + " принята.");
    } catch (err) {
      showErr(err.message || "Ошибка сети. Проверьте связь и повторите.");
      if (btn) { btn.disabled = false; btn.textContent = prevText || "Найти мастера →"; }
    }
  }

  function init() {
    var btn = $("leadSubmit");
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      e.preventDefault();
      submit(btn);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
