// ===== Калькулятор. Прайс НЕ здесь — единственный источник public/catalog.json (его же читает бэк,
// src/pricing.js). Категории: furniture / doors / plumbing — переключатель #catSeg, ?c=doors в ссылке. =====
const fmt=n=>n.toLocaleString('ru-RU')+' ₽';
let CATALOG=null;          // весь каталог из catalog.json
let cat='furniture';       // текущая категория
let items=[],addons=[];    // позиции текущей категории с количеством (q) / отметкой (on)
let lastTotal={low:0,high:0,mid:0};

const calcList=document.getElementById('calcList');
const addonList=document.getElementById('addonList');
const $id=id=>document.getElementById(id);
const DEFAULT_PHOTO_HINT='Для проектной кухни приложите проект или чертёж';

function catFromUrl(){
  try{const c=new URLSearchParams(location.search).get('c');return c&&CATALOG&&CATALOG[c]?c:null;}catch(e){return null;}
}
const hasSelection=()=>items.some(it=>it.q>0)||addons.some(a=>a.unit?a.q>0:a.on);

// Подписи экрана под категорию (шапка, «Что собрать/установить», фото, дата, пустой итог, title)
function applyLabels(){
  const c=CATALOG[cat];
  $id('catSub').textContent=c.subtitle;
  $id('listLabel').textContent=c.listLabel;
  $id('whenLabel').textContent=c.whenLabel;
  document.title=c.title;
  const pi=$id('f_photos');
  if(!(pi&&pi.files&&pi.files.length)) $id('photoCount').textContent=c.photoHint;
  document.querySelectorAll('#catSeg [data-cat]').forEach(b=>{
    const on=b.dataset.cat===cat;b.classList.toggle('on',on);b.setAttribute('aria-pressed',on?'true':'false');
  });
}

function stepRow(x,prefix){
  const r=document.createElement('div');r.className='calc-row';
  r.innerHTML=`<div class="nm">${x.nm}<div class="pr">от ${prefix}${fmt(x.pr)} · ${x.unit}</div></div>
  <div class="step"><button type="button" aria-label="меньше">–</button><span id="q_${x.id}">0</span><button type="button" aria-label="больше">+</button></div>`;
  const [minus,plus]=r.querySelectorAll('button');
  minus.onclick=()=>{x.q=Math.max(0,x.q-1);$id('q_'+x.id).textContent=x.q;recalc();};
  plus.onclick=()=>{x.q++;$id('q_'+x.id).textContent=x.q;recalc();};
  return r;
}

function renderCalc(){
  const c=CATALOG[cat];
  items=c.items.map(it=>({...it,q:0}));
  addons=c.addons.map(a=>a.unit?{...a,q:0}:{...a,on:false});
  calcList.innerHTML='';addonList.innerHTML='';
  items.forEach(it=>calcList.appendChild(stepRow(it,'')));
  addons.forEach(a=>{
    if(a.unit){ // поштучный доп (врезка в столешницу) — строка со степпером в «Что собрать», под указанной позицией
      const r=stepRow(a,'+');
      const anchor=a.after&&$id('q_'+a.after);
      if(anchor) anchor.closest('.calc-row').after(r); else calcList.appendChild(r);
      return;
    }
    const r=document.createElement('div');r.className='addon';
    r.innerHTML=`<div class="chk"><svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg></div>
  <div class="nm">${a.nm}</div><div class="pr">${a.pr?'от +'+fmt(a.pr):'+'+Math.round((a.mult-1)*100)+'%'}</div>`;
    r.onclick=()=>{a.on=!a.on;r.classList.toggle('sel',a.on);recalc();};
    addonList.appendChild(r);
  });
  const addonBlock=addonList.previousElementSibling; // eyebrow «Дополнительно» — прячем, если допов-галочек нет
  const anyCheck=addons.some(a=>!a.unit);
  addonList.hidden=!anyCheck;if(addonBlock&&addonBlock.classList.contains('eyebrow'))addonBlock.hidden=!anyCheck;
  applyLabels();
  recalc();
}

// Сменить категорию. Количества и допы сбрасываются; имя, телефон, адрес, дата, фото и комментарий — нет.
// force=true — без вопроса (кросс-продажа, открытие по ссылке).
function setCategory(code,force){
  if(!CATALOG||!CATALOG[code]||code===cat&&items.length)return true;
  if(!force&&hasSelection()&&!confirm(`Сбросить выбранное и перейти в «${CATALOG[code].label}»?`))return false;
  cat=code;renderCalc();
  if(location.pathname==='/'){ // ссылку можно переслать — откроется та же категория (?ref= сохраняется)
    try{const u=new URL(location.href);if(code==='furniture')u.searchParams.delete('c');else u.searchParams.set('c',code);history.replaceState(history.state,'',u.pathname+u.search+u.hash);}catch(e){}
  }
  return true;
}
window.setCategory=setCategory;
document.querySelectorAll('#catSeg [data-cat]').forEach(b=>b.onclick=()=>setCategory(b.dataset.cat,false));

function recalc(){
  let base=0;items.forEach(it=>base+=it.q*it.pr);
  let add=0,mult=1;addons.forEach(a=>{if(a.unit)add+=a.q*a.pr;else if(a.on){if(a.mult)mult=a.mult;else add+=a.pr;}});
  let low=(base+add)*mult;
  const totalEl=$id('calcTotal'),hintEl=$id('calcHint');
  if(low<=0){totalEl.textContent='0 ₽';hintEl.textContent=CATALOG?CATALOG[cat].emptyHint:'';lastTotal={low:0,high:0,mid:0};return;}
  let high=Math.round(low*1.2/100)*100;low=Math.round(low/100)*100;
  const mid=Math.round((low+high)/2);
  lastTotal={low,high,mid};
  totalEl.textContent=fmt(low)+' – '+fmt(high);
  hintEl.textContent='Цена ориентировочная.';
  $id('budgetInp').value=mid.toLocaleString('ru-RU');
}

// ===== Контракт для api.js: состав заказа из калькулятора =====
window.getCalcState=()=>({
  category: cat,
  items: items.filter(it=>it.q>0).map(it=>({id:it.id,nm:it.nm,qty:it.q,price:it.pr})),
  addons: addons.filter(a=>a.unit?a.q>0:a.on).map(a=>a.unit?{id:a.id,nm:a.nm,qty:a.q,price:a.pr}:{id:a.id,nm:a.nm,price:a.pr||0,mult:a.mult||null}),
  total: {...lastTotal}
});

// Загрузка прайса. window.calcReady — промис для z.js (кросс-продажа ждёт готовый калькулятор).
window.calcReady=fetch('/catalog.json',{cache:'no-cache'})
  .then(r=>{if(!r.ok)throw new Error(r.status);return r.json();})
  .then(c=>{CATALOG=c;cat=catFromUrl()||'furniture';renderCalc();})
  .catch(()=>{calcList.innerHTML='<div class="calc-row"><div class="nm">Не удалось загрузить цены. Обновите страницу.</div></div>';});

// ===== Переключение экранов + вкладки внизу (Заявка / Заказ) =====
const TAB_GROUP={calc:'calc',done:'calc',zlist:'order',zorder:'order',mprof:'order'};
function switchView(v){
  document.querySelectorAll('[data-cview]').forEach(x=>x.classList.toggle('on',x.dataset.cview===v));
  const sc=document.querySelector('.screen'); if(sc) sc.scrollTop=0;
  const grp=TAB_GROUP[v]||'calc';
  document.querySelectorAll('#cTabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===grp));
}
window.switchView=switchView;
window.showThanks=()=>switchView('done');
const cTabCalc=document.querySelector('#cTabs [data-tab="calc"]');
if(cTabCalc) cTabCalc.onclick=()=>switchView('calc');

const again=$id('leadAgain');
if(again) again.onclick=()=>{
  ['f_name','f_phone','f_address','f_date','f_time'].forEach(id=>{const el=$id(id);if(el)el.value='';});
  resetPhotoPreview();
  if(CATALOG)renderCalc();
  switchView('calc');
};

// превью выбранных фото — миниатюры на месте плиток "+"
const photoInput=$id('f_photos');
const photoCount=$id('photoCount');
const photoTiles=[...document.querySelectorAll('.photos .ph')];
const photoTileDefault=photoTiles.map(t=>t.textContent);
const photoHint=()=>CATALOG?CATALOG[cat].photoHint:DEFAULT_PHOTO_HINT;
function resetPhotoPreview(){
  photoTiles.forEach((t,i)=>{
    if(t.dataset.url){URL.revokeObjectURL(t.dataset.url);delete t.dataset.url;}
    t.style.backgroundImage='';t.textContent=photoTileDefault[i];
  });
  if(photoInput) photoInput.value='';
  if(photoCount) photoCount.textContent=photoHint();
}
if(photoInput) photoInput.onchange=()=>{
  const files=[...photoInput.files].slice(0,photoTiles.length);
  photoTiles.forEach((t,i)=>{
    if(t.dataset.url){URL.revokeObjectURL(t.dataset.url);delete t.dataset.url;}
    if(files[i]){
      const url=URL.createObjectURL(files[i]);
      t.dataset.url=url;
      t.style.backgroundImage=`url('${url}')`;t.style.backgroundSize='cover';t.style.backgroundPosition='center';
      t.textContent='';
    }else{
      t.style.backgroundImage='';t.textContent=photoTileDefault[i];
    }
  });
  const n=photoInput.files.length;
  photoCount.textContent = n ? ('Выбрано фото: '+n) : photoHint();
};

// кнопка «Установить приложение» — общая логика с кабинетом мастера (js/pwa.js)
const installBtn=$id('installBtn');
if(installBtn){
  if(!(window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone)) installBtn.hidden=false;
  installBtn.onclick=()=>window.pwaInstallNow&&window.pwaInstallNow();
}
