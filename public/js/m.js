// ===== Кабинет мастера — клиент (вызовы по контракту /api/master/*) =====
const CATS=[{code:'furniture',title:'Сборка мебели'}];
const fmt=n=>Number(n).toLocaleString('ru-RU')+' ₽';
const numOnly=s=>parseInt(String(s).replace(/\D/g,''),10)||0;
const $=s=>document.querySelector(s);
const state={me:null,cats:new Set(),flags:{has_tools:false,has_car:false},self:'none',offerOrder:null};

// ---- API ----
async function api(path,opts={}){
  const r=await fetch('/api'+path,{credentials:'include',...opts});
  if(r.status===401){showView('auth');mTabs.hidden=true;throw new Error('auth');}
  const ct=r.headers.get('content-type')||'';
  const data=ct.includes('json')?await r.json():await r.text();
  if(!r.ok)throw new Error((data&&data.error)||'Ошибка сервера');
  return data;
}
function jpost(path,body){return api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
function jput(path,body){return api(path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}
function err(id,msg){const e=$('#'+id);if(!msg){e.hidden=true;return;}e.textContent=msg;e.hidden=false;}
// Текст от клиента (комментарий, адрес, имя…) попадает на страницу мастера — всегда экранируем.
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
// Телефон для показа («+7 900 123-45-67») и для ссылки «Позвонить» (tel:+79001234567)
const phoneFmt=p=>{const d=String(p||'').replace(/\D/g,'');const n=(d.length===11&&(d[0]==='7'||d[0]==='8'))?d.slice(1):(d.length===10?d:null);return n?'+7 '+n.slice(0,3)+' '+n.slice(3,6)+'-'+n.slice(6,8)+'-'+n.slice(8):String(p||'');};
const telHref=p=>{const d=String(p||'').replace(/\D/g,'');if(d.length===11&&(d[0]==='7'||d[0]==='8'))return 'tel:+7'+d.slice(1);if(d.length===10)return 'tel:+7'+d;return 'tel:'+String(p||'').replace(/[^\d+]/g,'');};

// ---- Фото клиента: миниатюры (готовые .portfolio/.pf) и просмотр на весь экран ----
// Ссылки ведут на защищённый /api/master/orders/:id/photos/:n — файлы лежат в закрытой папке.
function photoTiles(box,urls){
  box.innerHTML=urls.map((u,i)=>`<div class="pf" data-i="${i}" role="button" aria-label="Фото ${i+1}" style="background-image:url('${u}');background-size:cover;background-position:center;cursor:pointer"></div>`).join('');
  box.querySelectorAll('[data-i]').forEach(t=>{t.onclick=()=>openViewer(urls,+t.dataset.i);});
}
function openViewer(urls,start){
  if(!urls||!urls.length)return;
  let i=Math.min(Math.max(start||0,0),urls.length-1);
  const many=urls.length>1;
  const nav='position:absolute;top:50%;transform:translateY(-50%);width:52px;height:96px;border:0;background:transparent;color:#fff;font-size:38px;cursor:pointer;';
  const ov=document.createElement('div');
  ov.className='modal';
  ov.style.cssText='background:rgba(20,35,58,.95);padding:0;z-index:80';
  ov.innerHTML='<img alt="" style="max-width:100%;max-height:100vh;object-fit:contain;display:block">'
    +'<div class="vcap" style="position:absolute;top:16px;left:16px;color:#fff;font-size:13px;font-weight:700"></div>'
    +'<button type="button" class="vx" aria-label="Закрыть" style="position:absolute;top:4px;right:4px;width:52px;height:52px;border:0;background:transparent;color:#fff;font-size:26px;cursor:pointer">✕</button>'
    +(many?`<button type="button" class="vp" aria-label="Предыдущее фото" style="${nav}left:0">‹</button><button type="button" class="vn" aria-label="Следующее фото" style="${nav}right:0">›</button>`:'');
  const img=ov.querySelector('img'),cap=ov.querySelector('.vcap');
  function show(){
    cap.textContent=(many?(i+1)+' / '+urls.length:'');
    img.style.visibility='visible';
    img.src=urls[i];
  }
  img.onerror=()=>{img.style.visibility='hidden';cap.textContent='Фото недоступно'+(many?' · '+(i+1)+' / '+urls.length:'');};
  function step(d){i=(i+d+urls.length)%urls.length;show();}
  function close(){document.removeEventListener('keydown',onKey);ov.remove();}
  function onKey(e){if(e.key==='Escape')close();else if(many&&e.key==='ArrowLeft')step(-1);else if(many&&e.key==='ArrowRight')step(1);}
  ov.querySelector('.vx').onclick=close;
  if(many){ov.querySelector('.vp').onclick=()=>step(-1);ov.querySelector('.vn').onclick=()=>step(1);}
  ov.onclick=e=>{if(e.target===ov)close();};
  let x0=null;
  ov.addEventListener('touchstart',e=>{x0=e.touches.length===1?e.touches[0].clientX:null;},{passive:true});
  ov.addEventListener('touchend',e=>{
    if(x0==null||!many)return;
    const dx=e.changedTouches[0].clientX-x0;x0=null;
    if(Math.abs(dx)>50)step(dx<0?1:-1);
  });
  document.addEventListener('keydown',onKey);
  document.body.appendChild(ov);
  show();
}

// ---- Навигация ----
const mTabs=$('#mTabs');
function showView(v){
  document.querySelectorAll('[data-mv]').forEach(x=>x.classList.toggle('on',x.dataset.mv===v));
  $('.screen').scrollTop=0;
  const inCab=['feed','deals','profile'].includes(v);
  mTabs.hidden=!inCab;
  if(inCab)document.querySelectorAll('#mTabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===v));
}
document.querySelectorAll('#mTabs button').forEach(b=>b.onclick=()=>{
  const t=b.dataset.tab;showView(t);
  if(t==='feed')loadFeed();if(t==='deals')loadDeals();
});

// ---- Старт: инвайт / сессия / вход ----
(async function init(){
  buildChips();
  const p=new URLSearchParams(location.search);
  const invite=p.get('invite');
  if(invite){state.invite=invite;showView('activate');return;}
  const join=p.get('join');
  if(join){
    state.join=join;
    $('#acLead').textContent='Регистрация мастера в СБОРКЕ. Укажите имя, телефон и задайте пароль — потом заполним анкету.';
    $('#acNameWrap').hidden=false;$('#acPhoneWrap').hidden=false;
    showView('activate');return;
  }
  try{const me=await api('/master/me');onMe(me);showView('feed');loadFeed();}
  catch(e){showView('auth');}
})();

// ---- Вход ----
$('#loginBtn').onclick=async()=>{
  err('authErr','');
  try{
    await jpost('/master/login',{phone:$('#a_phone').value.trim(),password:$('#a_pass').value});
    const me=await api('/master/me');onMe(me);showView('feed');loadFeed();
  }catch(e){err('authErr',e.message==='auth'?'Неверный телефон или пароль':e.message);}
};

// ---- Активация по инвайту ----
$('#activateBtn').onclick=async()=>{
  err('acErr','');
  const p1=$('#ac_pass').value,p2=$('#ac_pass2').value;
  if(p1.length<6)return err('acErr','Пароль минимум 6 символов');
  if(p1!==p2)return err('acErr','Пароли не совпадают');
  try{
    if(state.join){
      const name=$('#ac_name').value.trim(),phone=$('#ac_phone').value.trim();
      if(name.length<2)return err('acErr','Укажите имя');
      if(!phone)return err('acErr','Укажите телефон');
      await jpost('/master/register',{join_code:state.join,name,phone,password:p1});
    }else await jpost('/master/activate',{invite_token:state.invite,password:p1});
    const me=await api('/master/me');onMe(me);
    history.replaceState({},'', '/m');
    showView('profile');
  }catch(e){err('acErr',e.message);}
};

// ---- Профиль ----
function onMe(me){
  state.me=me;
  $('#p_name').value=me.name||'';
  $('#p_about').value=me.about||'';
  $('#p_exp').value=me.experience_years||'';
  state.cats=new Set(me.categories||[]);
  state.flags.has_tools=!!me.has_tools;state.flags.has_car=!!me.has_car;
  state.self=me.self_employed||'none';
  if(me.photo_url){$('#p_avatarText').outerHTML='<img src="'+me.photo_url+'" style="width:100%;height:100%;object-fit:cover">';}
  $('#p_nameHead').textContent=me.name||'Ваша анкета';
  $('#p_statusLine').textContent=me.status==='active'?(me.verified?'Проверенный мастер · в ленте заявок':'Активен · в ленте заявок'):'На модерации';
  renderChips();renderPortfolio(me.portfolio||[]);
  $('#docsNote').textContent=(me.documents_count?('Загружено документов: '+me.documents_count+' · на проверке'):'');
  // Если браузер уже когда-то дал разрешение на уведомления (Notification.permission==='granted'),
  // но подписка на сервере не сохранилась — например мастер нажал «Включить уведомления» ДО входа
  // в кабинет, запрос улетел без сессии (401) и тихо потерялся (баг, 2026-09-22) — тут молча
  // пробуем подписаться повторно теперь, когда сессия точно есть. Если permission ещё 'default',
  // ничего не делаем: запрос разрешения должен идти по клику на баннер pwa.js, а не сам по себе.
  try{
    if('Notification' in window && Notification.permission==='granted' && typeof window.enablePush==='function'){
      window.enablePush().catch(()=>{});
    }
  }catch(e){}
}

function buildChips(){
  $('#p_cats').innerHTML=CATS.map(c=>`<span class="chip" data-cat="${c.code}">${c.title}</span>`).join('');
}
function renderChips(){
  document.querySelectorAll('[data-cat]').forEach(c=>c.classList.toggle('on',state.cats.has(c.dataset.cat)));
  document.querySelectorAll('[data-flag]').forEach(c=>c.classList.toggle('on',state.flags[c.dataset.flag]));
  document.querySelectorAll('[data-self]').forEach(c=>c.classList.toggle('on',c.dataset.self===state.self));
}
document.addEventListener('click',e=>{
  const c=e.target.closest('[data-cat]');if(c){state.cats.has(c.dataset.cat)?state.cats.delete(c.dataset.cat):state.cats.add(c.dataset.cat);renderChips();}
  const f=e.target.closest('[data-flag]');if(f){state.flags[f.dataset.flag]=!state.flags[f.dataset.flag];renderChips();}
  const s=e.target.closest('[data-self]');if(s){state.self=s.dataset.self;renderChips();}
});

$('#profSave').onclick=async()=>{
  err('profErr','');
  try{
    await jput('/master/profile',{
      name:$('#p_name').value.trim(),about:$('#p_about').value.trim(),
      experience_years:numOnly($('#p_exp').value),
      categories:[...state.cats],
      has_tools:state.flags.has_tools,has_car:state.flags.has_car,self_employed:state.self
    });
    const me=await api('/master/me');onMe(me);
    err('profErr','');$('#profSave').textContent='Сохранено ✓';
    setTimeout(()=>$('#profSave').textContent='Сохранить анкету',1500);
  }catch(e){err('profErr',e.message);}
};

$('#p_photo').onchange=e=>uploadFile('/master/photo','photo',e.target.files[0],()=>api('/master/me').then(onMe));
$('#p_portUpload').onchange=e=>uploadMany('/master/portfolio','photos',e.target.files,()=>api('/master/me').then(onMe));
$('#p_docs').onchange=e=>uploadMany('/master/documents','docs',e.target.files,()=>api('/master/me').then(m=>{onMe(m);$('#docsNote').textContent='Документы отправлены на проверку';}));

async function uploadFile(path,field,file,done){if(!file)return;const fd=new FormData();fd.append(field,file);await api(path,{method:'POST',body:fd});done&&done();}
async function uploadMany(path,field,files,done){if(!files.length)return;const fd=new FormData();[...files].forEach(f=>fd.append(field,f));await api(path,{method:'POST',body:fd});done&&done();}

function renderPortfolio(items){
  const el=$('#p_portfolio');
  if(!items.length){el.innerHTML='<div class="pf"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 20"/></svg><span>нет фото</span></div>';return;}
  el.innerHTML=items.map(p=>`<div class="pf" style="background-image:url('${p.photo_url}');background-size:cover"></div>`).join('');
}

$('#logoutBtn').onclick=async()=>{try{await api('/master/logout',{method:'POST'});}catch(e){}location.href='/m';};

if(!(window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone)){$('#installBtn').hidden=false;}
$('#installBtn').onclick=()=>window.pwaInstallNow&&window.pwaInstallNow();

// ---- Лента заявок ----
async function loadFeed(){
  try{
    const {orders=[]}=await api('/master/feed');
    $('#feedStatus').hidden=true;   // связь есть — убрать прошлое сообщение об ошибке
    const sig=JSON.stringify(orders);if(sig===state.feedSig)return;state.feedSig=sig;   // не перерисовывать, если ничего не изменилось
    const list=$('#feedList');$('#feedEmpty').hidden=orders.length>0;
    list.innerHTML=orders.map(o=>orderCard(o)).join('');
    list.querySelectorAll('[data-offer]').forEach(b=>b.onclick=()=>openOffer(orders.find(x=>x.id==b.dataset.offer)));
    list.querySelectorAll('[data-ph]').forEach(el=>{el.onclick=()=>{const o=orders.find(x=>x.id==el.dataset.ph);if(o)openViewer(o.photos,0);};});
  }catch(e){if(e.message!=='auth')$('#feedStatus').textContent=e.message,$('#feedStatus').hidden=false;}
}
// Автообновление каждые 15 с: пока приложение открыто, на вкладке «Лента» подтягиваются новые заявки,
// на «Мои заказы» — выбор клиента и смена статусов. Руками обновлять не нужно. Также — сразу при
// возвращении в приложение и появлении связи.
function viewOn(v){var el=document.querySelector('[data-mv="'+v+'"]');return !!(el&&el.classList.contains('on'));}
function refreshNow(){
  if(viewOn('feed'))return loadFeed();
  if(viewOn('deals'))return loadDeals();
}
function autoRefresh(){
  if(document.visibilityState!=='visible'||!state.me)return;
  refreshNow();
}
setInterval(autoRefresh,15000);
document.addEventListener('visibilitychange',autoRefresh);
window.addEventListener('online',autoRefresh);
// «Потяните вниз, чтобы обновить» — в установленном приложении нет обновления страницы браузера (ptr.js)
if(window.pullToRefresh)pullToRefresh({isActive:function(){return !!state.me&&(viewOn('feed')||viewOn('deals'));},onRefresh:async function(){await refreshNow();}});
function compose(o){const its=(o.items||[]).map(i=>i.nm+(i.qty>1?(' ×'+i.qty):'')).join(', ');return esc(its||'Заказ');}
function orderCard(o){
  const mine=o.my_offer?`<span class="badge b-prog">ваш отклик ${fmt(o.my_offer.price_rub)}</span>`:'';
  return `<div class="card ordcard">
    <div class="ordtop"><h3>${compose(o)}</h3>${mine||'<span class="badge b-new">Новый</span>'}</div>
    <div class="metaline"><span>📍 <b>${esc(o.district||'—')}</b></span><span>🕐 <b>${esc(o.preferred_date||'по договорённости')}</b></span>${o.photos_count?`<span data-ph="${o.id}" role="button" style="cursor:pointer;color:var(--navy);font-weight:700;text-decoration:underline">📷 ${o.photos_count}</span>`:''}</div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div class="budget">~${Number(o.budget_rub||0).toLocaleString('ru-RU')} ₽ <small>бюджет</small></div>
      <button class="btn navy" style="width:auto;margin:0;padding:10px 18px" data-offer="${o.id}">${o.my_offer?'Изменить':'Откликнуться'}</button>
    </div></div>`;
}
function openOffer(o){
  state.offerOrder=o;
  const ph=o.photos||[];
  $('#offerOrder').innerHTML=`<div class="ordtop"><h3>${compose(o)}</h3><span class="badge b-new">${esc(o.district||'')}</span></div>
    <div class="metaline"><span>Бюджет: <b>~${Number(o.budget_rub||0).toLocaleString('ru-RU')} ₽</b></span><span>${esc(o.preferred_date||'')} ${esc(o.preferred_time||'')}</span></div>
    ${o.comment?`<p class="note" style="text-align:left;margin:6px 0 0">${esc(o.comment)}</p>`:''}
    ${ph.length?`<div class="eyebrow" style="margin-top:12px">Фото от клиента</div><div class="portfolio" id="offerPhotos"></div>`:''}`;
  if(ph.length)photoTiles($('#offerPhotos'),ph);
  if(o.my_offer){$('#o_price').value=o.my_offer.price_rub;$('#o_note').value=o.my_offer.note||'';}else{$('#o_price').value='';$('#o_note').value='';}
  err('offerErr','');showView('offer');
}
$('#offerBack').onclick=()=>{showView('feed');loadFeed();};
$('#offerSend').onclick=async()=>{
  err('offerErr','');
  const price=numOnly($('#o_price').value);
  if(price<300)return err('offerErr','Укажите цену');
  const d=$('#o_date').value,t=$('#o_time').value;
  const can_start_at=d?(d+'T'+(t||'09:00')):null;
  try{
    await jpost('/master/orders/'+state.offerOrder.id+'/offer',{price_rub:price,can_start_at,note:$('#o_note').value.trim()});
    showView('feed');loadFeed();
  }catch(e){err('offerErr',e.message);}
};

// ---- Мои сделки ----
const STEPS=[['assigned','Назначен'],['agreed','Договорились'],['en_route','Едет'],['working','Собирает'],['done','Готово']];
const OK_SVG='<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>';
async function loadDeals(){
  try{
    const {deals=[]}=await api('/master/deals');
    const sig=JSON.stringify(deals);if(sig===state.dealsSig)return;state.dealsSig=sig;
    $('#dealsEmpty').hidden=deals.length>0;
    $('#dealsList').innerHTML=deals.map(dealCard).join('');
    $('#dealsList').querySelectorAll('[data-next]').forEach(b=>b.onclick=()=>moveStatus(b.dataset.id,b.dataset.next));
    deals.forEach(d=>{const box=$('#dealsList').querySelector('[data-dph="'+d.id+'"]');if(box)photoTiles(box,d.photos);});
  }catch(e){}
}
function tracker(status){
  const idx=STEPS.findIndex(s=>s[0]===status);
  return `<div class="tracker">${STEPS.map((s,i)=>`<div class="tstep ${i<idx?'done':(i===idx?'active':'')}"><div class="tdot">${i<idx?OK_SVG:(i+1)}</div><div class="tlbl">${s[1]}</div></div>`).join('')}</div>`;
}
// Новый заказ (клиент выбрал мастера): надо позвонить клиенту и обсудить детали. Кнопка звонка — пока заказ не завершён.
function callBlock(d){
  if(d.status==='done'||!d.client_phone)return '';
  const btn=`<a class="btn navy" href="${telHref(d.client_phone)}" style="display:block;text-align:center;text-decoration:none;margin-top:10px">Позвонить клиенту</a>`;
  if(d.status!=='assigned')return btn;
  return `<div class="callout" style="margin-top:12px"><svg viewBox="0 0 24 24"><path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg><div>Позвоните клиенту${d.client_name?' ('+esc(d.client_name)+')':''} и обсудите детали. Если не договоритесь — клиент вернёт заявку в поиск.</div></div>`+btn;
}
function dealCard(d){
  const idx=STEPS.findIndex(s=>s[0]===d.status);
  const next=STEPS[idx+1];
  const btn=(d.status!=='done'&&next)?`<button class="btn navy" data-id="${d.id}" data-next="${next[0]}" style="margin-top:12px">Отметить: ${next[1]}</button>`:'';
  return `<div class="card ordcard"><div class="ordtop"><h3>${compose(d)}</h3><span class="budget">${fmt(d.agreed_price_rub||d.budget_rub||0)}</span></div>
    <div class="metaline"><span>📍 <b>${esc(d.address||d.district||'')}</b></span><span>${esc(d.client_name||'')} · ${esc(d.client_phone?phoneFmt(d.client_phone):'телефон откроется')}</span></div>
    ${callBlock(d)}
    ${(d.photos&&d.photos.length)?`<div class="eyebrow" style="margin-top:12px">Фото от клиента</div><div class="portfolio" data-dph="${d.id}"></div>`:''}
    ${tracker(d.status)}${btn}</div>`;
}
async function moveStatus(id,next){try{await jpost('/master/deals/'+id+'/status',{status:next});loadDeals();}catch(e){alert(e.message);}}
