// СБОРКА — PWA: регистрация SW, установка на экран, включение уведомлений
(function(){
  if('serviceWorker' in navigator){ navigator.serviceWorker.register('/sw.js').catch(()=>{}); }

  const isiOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone;
  let deferredPrompt=null, bar=null;

  function closeBar(){ if(bar){bar.remove();bar=null;} }
  function showBar(inner){
    closeBar();
    bar=document.createElement('div'); bar.className='pwabar'; bar.innerHTML=inner;
    document.body.appendChild(bar);
    const x=bar.querySelector('.pwax'); if(x)x.onclick=closeBar;
  }

  window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); deferredPrompt=e; });

  // Явная кнопка «Установить» в интерфейсе (не только автобаннер) — кабинеты вызывают это напрямую.
  window.pwaStandalone=standalone;
  window.pwaInstallNow=async function(){
    if(standalone) return 'installed';
    if(deferredPrompt){ const p=deferredPrompt; deferredPrompt=null; p.prompt(); try{await p.userChoice;}catch(e){} return 'prompted'; }
    if(isiOS){ showBar('<span>Добавьте на экран: кнопка «Поделиться» → «На экран „Домой“».</span><span class="pwax">✕</span>'); return 'ios'; }
    showBar('<span>Установка сейчас недоступна — откройте сайт в Chrome или Safari.</span><span class="pwax">✕</span>');
    return 'unsupported';
  };

  // Кнопка «включить уведомления» — по жесту пользователя (push.js уже загружен)
  function canPush(){ return ('Notification' in window) && typeof window.enablePush==='function' && Notification.permission!=='granted' && Notification.permission!=='denied'; }

  function offer(){
    if(standalone) { if(canPush()) pushPrompt(); return; }
    if(deferredPrompt){
      showBar('<span>Установите приложение — открывается с экрана, приходят уведомления.</span><button class="pwabtn" id="pwaInstall">На экран</button><span class="pwax">✕</span>');
      bar.querySelector('#pwaInstall').onclick=async()=>{ closeBar(); deferredPrompt.prompt(); deferredPrompt=null; };
    } else if(isiOS && !localStorage.getItem('sb_ios')){
      showBar('<span>Добавьте на экран: кнопка «Поделиться» → «На экран „Домой“».</span><span class="pwax" onclick="localStorage.setItem(\'sb_ios\',1)">✕</span>');
    } else if(canPush()){ pushPrompt(); }
  }

  function pushPrompt(){
    showBar('<span>Включить уведомления об откликах и заказах?</span><button class="pwabtn" id="pwaPush">Включить</button><span class="pwax">✕</span>');
    bar.querySelector('#pwaPush').onclick=async()=>{ try{ await window.enablePush(); }catch(e){} closeBar(); };
  }

  setTimeout(offer, 2500);
})();
