/* СБОРКА — подписка на web-push. Файл бэкенд-Claude.
   Экспортирует:
     window.pushStatus()  -> 'unsupported' | 'denied' | 'granted' | 'default'
     window.enablePush()  -> Promise, resolve при успехе, reject(Error) с текстом
     window.disablePush() -> Promise
   Дизайн-Claude: кнопка «Включить уведомления» -> onclick=window.enablePush();
   состояние можно рисовать по window.pushStatus(). VAPID key берётся с /api/push/vapid. */

(function () {
  "use strict";

  var supported =
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;

  window.pushStatus = function () {
    if (!supported) return "unsupported";
    return Notification.permission; // 'granted' | 'denied' | 'default'
  };

  function urlB64ToUint8Array(b64) {
    var pad = "=".repeat((4 - (b64.length % 4)) % 4);
    var base = (b64 + pad).replace(/-/g, "+").replace(/_/g, "/");
    var raw = atob(base);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  function clientToken() {
    try {
      var t = localStorage.getItem("sborka_token");
      if (t) return t;
    } catch (e) {}
    // Запасной вариант: токен клиента виден в адресе страницы /z/<token>.
    var m = String(location.pathname || "").match(/\/z\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : "";
  }

  async function getRegistration() {
    var reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    return reg;
  }

  window.enablePush = async function () {
    if (!supported) throw new Error("Браузер не поддерживает push-уведомления");

    var perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Уведомления не разрешены в браузере");

    var reg = await getRegistration();

    var key = "";
    try {
      var r = await fetch("/api/push/vapid");
      key = (await r.json()).publicKey || "";
    } catch (e) {}
    if (!key) throw new Error("Сервер не отдал ключ уведомлений");

    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(key),
      });
    }

    var res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), token: clientToken() }),
    });
    var data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok || !data || !data.ok) {
      throw new Error((data && data.error) || "Не удалось включить уведомления");
    }
    return { ok: true };
  };

  window.disablePush = async function () {
    if (!supported) return { ok: true };
    var reg = await navigator.serviceWorker.getRegistration("/");
    if (!reg) return { ok: true };
    var sub = await reg.pushManager.getSubscription();
    if (!sub) return { ok: true };
    var endpoint = sub.endpoint;
    try { await sub.unsubscribe(); } catch (e) {}
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: endpoint }),
    }).catch(function () {});
    return { ok: true };
  };
})();
