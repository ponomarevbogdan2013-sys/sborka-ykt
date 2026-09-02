// ===== Кабинет мастера — клиент (вызовы по контракту /api/master/*) =====
const DISTRICTS=['Центральный','Сайсары','Строительный','Автодорожный','Гагаринский','Промышленный','Губинский','17 квартал','202 мкр','203 мкр','Марха','Птицефабрика','Кангалассы','Другой / пригород'];
const CATS=[{code:'furniture',title:'Сборка мебели'}];
const fmt=n=>Number(n).toLocaleString('ru-RU')+' ₽';
const numOnly=s=>parseInt(String(s).replace(/\D/g,''),10)||0;
const $=s=>document.querySelector(s);
const state={me:null,zones:new Set(),cats:new Set(),flags:{has_tools:false,has_car:false},self:'none',offerOrder:null};

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
    await jpost('/master/activate',{invite_token:state.invite,password:p1});
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
  state.zones=new Set(me.zones||[]);
  state.cats=new Set(me.categories||[]);
  state.flags.has_tools=!!me.has_tools;state.flags.has_car=!!me.has_car;
  state.self=me.self_employed||'none';
  if(me.photo_url){$('#p_avatarText').outerHTML='<img src="'+me.photo_url+'" style="width:100%;height:100%;object-fit:cover">';}
  $('#p_nameHead').textContent=me.name||'Ваша анкета';
  $('#p_statusLine').textContent=me.status==='active'?(me.verified?'Проверенный мастер · в ленте заявок':'Активен · в ленте заявок'):'На модерации';
  renderChips();renderPortfolio(me.portfolio||[]);
  $('#docsNote').textContent=(me.documents_count?('Загружено документов: '+me.documents_count+' · на проверке'):'');
}

function buildChips(){
  $('#p_zones').innerHTML=DISTRICTS.map(d=>`<span class="chip" data-zone="${d}">${d}</span>`).join('');
  $('#p_cats').innerHTML=CATS.map(c=>`<span class="chip" data-cat="${c.code}">${c.title}</span>`).join('');
}
function renderChips(){
  document.querySelectorAll('[data-zone]').forEach(c=>c.classList.toggle('on',state.zones.has(c.dataset.zone)));
  document.querySelectorAll('[data-cat]').forEach(c=>c.classList.toggle('on',state.cats.has(c.dataset.cat)));
  document.querySelectorAll('[data-flag]').forEach(c=>c.classList.toggle('on',state.flags[c.dataset.flag]));
  document.querySelectorAll('[data-self]').forEach(c=>c.classList.toggle('on',c.dataset.self===state.self));
}
document.addEventListener('click',e=>{
  const z=e.target.closest('[data-zone]');if(z){state.zones.has(z.dataset.zone)?state.zones.delete(z.dataset.zone):state.zones.add(z.dataset.zone);renderChips();}
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
      zones:[...state.zones],categories:[...state.cats],
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

// ---- Лента заявок ----
async function loadFeed(){
  try{
    const {orders=[]}=await api('/master/feed');
    const list=$('#feedList');$('#feedEmpty').hidden=orders.length>0;
    list.innerHTML=orders.map(o=>orderCard(o)).join('');
    list.querySelectorAll('[data-offer]').forEach(b=>b.onclick=()=>openOffer(orders.find(x=>x.id==b.dataset.offer)));
  }catch(e){if(e.message!=='auth')$('#feedStatus').textContent=e.message,$('#feedStatus').hidden=false;}
}
function compose(o){const its=(o.items||[]).map(i=>i.nm+(i.qty>1?(' ×'+i.qty):'')).join(', ');return its||'Заказ';}
function orderCard(o){
  const mine=o.my_offer?`<span class="badge b-prog">ваш отклик ${fmt(o.my_offer.price_rub)}</span>`:'';
  return `<div class="card ordcard">
    <div class="ordtop"><h3>${compose(o)}</h3>${mine||'<span class="badge b-new">Новый</span>'}</div>
    <div class="metaline"><span>📍 <b>${o.district||'—'}</b></span><span>🕐 <b>${o.preferred_date||'по договорённости'}</b></span>${o.photos_count?`<span>📷 ${o.photos_count}</span>`:''}</div>
    <div style="display:flex;justify-content:space-between;align-items:center">
      <div class="budget">~${Number(o.budget_rub||0).toLocaleString('ru-RU')} ₽ <small>бюджет</small></div>
      <button class="btn navy" style="width:auto;margin:0;padding:10px 18px" data-offer="${o.id}">${o.my_offer?'Изменить':'Откликнуться'}</button>
    </div></div>`;
}
function openOffer(o){
  state.offerOrder=o;
  $('#offerOrder').innerHTML=`<div class="ordtop"><h3>${compose(o)}</h3><span class="badge b-new">${o.district||''}</span></div>
    <div class="metaline"><span>Бюджет: <b>~${Number(o.budget_rub||0).toLocaleString('ru-RU')} ₽</b></span><span>${o.preferred_date||''} ${o.preferred_time||''}</span></div>
    ${o.comment?`<p class="note" style="text-align:left;margin:6px 0 0">${o.comment}</p>`:''}`;
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
const STEPS=[['assigned','Назначен'],['en_route','Едет'],['working','Собирает'],['done','Готово']];
const OK_SVG='<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>';
async function loadDeals(){
  try{
    const {deals=[]}=await api('/master/deals');
    $('#dealsEmpty').hidden=deals.length>0;
    $('#dealsList').innerHTML=deals.map(dealCard).join('');
    $('#dealsList').querySelectorAll('[data-next]').forEach(b=>b.onclick=()=>moveStatus(b.dataset.id,b.dataset.next));
  }catch(e){}
}
function tracker(status){
  const idx=STEPS.findIndex(s=>s[0]===status);
  return `<div class="tracker">${STEPS.map((s,i)=>`<div class="tstep ${i<idx?'done':(i===idx?'active':'')}"><div class="tdot">${i<idx?OK_SVG:(i+1)}</div><div class="tlbl">${s[1]}</div></div>`).join('')}</div>`;
}
function dealCard(d){
  const idx=STEPS.findIndex(s=>s[0]===d.status);
  const next=STEPS[idx+1];
  const btn=(d.status!=='done'&&next)?`<button class="btn navy" data-id="${d.id}" data-next="${next[0]}" style="margin-top:12px">Отметить: ${next[1]}</button>`:'';
  return `<div class="card ordcard"><div class="ordtop"><h3>${compose(d)}</h3><span class="budget">${fmt(d.agreed_price_rub||d.budget_rub||0)}</span></div>
    <div class="metaline"><span>📍 <b>${d.address||d.district||''}</b></span><span>${d.client_name||''} · ${d.client_phone||'телефон откроется'}</span></div>
    ${tracker(d.status)}${btn}</div>`;
}
async function moveStatus(id,next){try{await jpost('/master/deals/'+id+'/status',{status:next});loadDeals();}catch(e){alert(e.message);}}
