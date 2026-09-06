// СБОРКА — service worker: web-push + клик по уведомлению
self.addEventListener('install', e=>self.skipWaiting());
self.addEventListener('activate', e=>e.waitUntil(self.clients.claim()));

self.addEventListener('push', e=>{
  let d={};
  try{ d=e.data.json(); }catch(_){ d={body:e.data&&e.data.text()}; }
  const title=d.title||'СБОРКА';
  e.waitUntil(self.registration.showNotification(title,{
    body:d.body||'',
    tag:d.tag||'sborka',
    icon:d.icon||'/icon-192.png',
    badge:'/icon-192.png',
    data:{url:d.url||'/'},
    vibrate:[80,40,80]
  }));
});

self.addEventListener('notificationclick', e=>{
  e.notification.close();
  const url=(e.notification.data&&e.notification.data.url)||'/';
  e.waitUntil(
    self.clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{
      for(const c of list){ if(c.url.includes(url)&&'focus' in c) return c.focus(); }
      return self.clients.openWindow(url);
    })
  );
});
