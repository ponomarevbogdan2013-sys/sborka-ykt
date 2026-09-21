/* СБОРКА — «потянуть вниз, чтобы обновить» для установленного приложения (иконка на экране).
   У такого приложения нет обновления страницы браузера, а прокручивается внутренний блок .screen,
   поэтому жест сделан сами. Подключается перед z.js / m.js / p.js.

   pullToRefresh({
     isActive: () => bool,          // на каком экране жест включён (не на формах и входе)
     onRefresh: async () => bool,   // обновить данные; false — нет связи
     scroller: '.screen'            // необязательно
   })
   Жест срабатывает, только если блок прокручен в самый верх и потянули вниз больше чем на 70 px. */
(function () {
  "use strict";

  window.pullToRefresh = function (o) {
    var sc = document.querySelector(o.scroller || ".screen");
    if (!sc) return;

    var HIDE = "translate(-50%,-70px)";
    var pill = document.createElement("div");
    pill.style.cssText =
      "position:fixed;top:10px;left:50%;transform:" + HIDE + ";transition:transform .15s;" +
      "background:var(--navy);color:#fff;border-radius:20px;padding:7px 14px;font-size:12.5px;" +
      "font-weight:600;z-index:70;pointer-events:none;white-space:nowrap";
    document.body.appendChild(pill);

    var y0 = null, dy = 0, busy = false;

    sc.addEventListener("touchstart", function (e) {
      y0 = (!busy && o.isActive() && sc.scrollTop <= 0 && e.touches.length === 1) ? e.touches[0].clientY : null;
      dy = 0;
    }, { passive: true });

    sc.addEventListener("touchmove", function (e) {
      if (y0 == null) return;
      dy = e.touches[0].clientY - y0;
      if (dy > 10) {
        pill.textContent = dy > 70 ? "Отпустите — обновлю" : "Потяните вниз, чтобы обновить";
        pill.style.transform = "translate(-50%," + Math.min(dy / 3, 28) + "px)";
      } else {
        pill.style.transform = HIDE;
      }
    }, { passive: true });

    sc.addEventListener("touchcancel", function () { y0 = null; pill.style.transform = HIDE; }, { passive: true });

    sc.addEventListener("touchend", async function () {
      if (y0 == null) return;
      var go = dy > 70;
      y0 = null;
      if (!go) { pill.style.transform = HIDE; return; }
      busy = true;
      pill.textContent = "Обновляю…";
      var ok = true;
      try { ok = (await o.onRefresh()) !== false; } catch (e) { ok = false; }
      pill.textContent = ok ? "Обновлено" : "Нет связи";
      setTimeout(function () { pill.style.transform = HIDE; busy = false; }, 800);
    });
  };
})();
