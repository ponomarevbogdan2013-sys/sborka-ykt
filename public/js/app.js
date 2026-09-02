// ===== Прайс (источник истины для калькулятора; бэкенд сверяет по нему) =====
const items=[
  {id:'kitchen_mod',nm:'Кухня модульная',pr:2500,unit:'шкаф / полка',q:0},
  {id:'kitchen_proj',nm:'Кухня проектная (на заказ)',pr:3500,unit:'шкаф / полка',q:0},
  {id:'kupe',nm:'Шкаф-купе',pr:5000,unit:'шт',q:0},
  {id:'shkaf',nm:'Шкаф / комод',pr:3000,unit:'шт',q:0},
  {id:'bed',nm:'Кровать',pr:3000,unit:'шт',q:0},
  {id:'sofa',nm:'Диван',pr:3000,unit:'шт',q:0},
  {id:'corner',nm:'Мягкий уголок',pr:4000,unit:'шт',q:0},
  {id:'table',nm:'Стол',pr:1500,unit:'шт',q:0},
  {id:'chairs',nm:'Стулья',pr:500,unit:'шт',q:0},
];
const addons=[
  {id:'sink',nm:'Подключить мойку и смеситель',pr:2000,on:false},
  {id:'cutout',nm:'Врезка в столешницу: мойка, плита',pr:1500,on:false},
  {id:'demo',nm:'Демонтаж старой мебели',pr:2000,on:false},
  {id:'trash',nm:'Вынос мусора',pr:1000,on:false},
  {id:'hang',nm:'Навеска: полки, ТВ, карнизы',pr:1000,on:false},
  {id:'urgent',nm:'Срочно, прямо сейчас (+30%)',pr:0,on:false,mult:1.3},
];
const fmt=n=>n.toLocaleString('ru-RU')+' ₽';
let lastTotal={low:0,high:0,mid:0};

const calcList=document.getElementById('calcList');
const addonList=document.getElementById('addonList');

items.forEach((it)=>{
  const r=document.createElement('div');r.className='calc-row';
  r.innerHTML=`<div class="nm">${it.nm}<div class="pr">${fmt(it.pr)} · ${it.unit}</div></div>
  <div class="step"><button type="button" aria-label="меньше">–</button><span id="q_${it.id}">0</span><button type="button" aria-label="больше">+</button></div>`;
  const [minus,plus]=r.querySelectorAll('button');
  minus.onclick=()=>{it.q=Math.max(0,it.q-1);document.getElementById('q_'+it.id).textContent=it.q;recalc();};
  plus.onclick=()=>{it.q++;document.getElementById('q_'+it.id).textContent=it.q;recalc();};
  calcList.appendChild(r);
});
addons.forEach(a=>{
  const r=document.createElement('div');r.className='addon';
  r.innerHTML=`<div class="chk"><svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg></div>
  <div class="nm">${a.nm}</div><div class="pr">${a.pr?'+'+fmt(a.pr):'+30%'}</div>`;
  r.onclick=()=>{a.on=!a.on;r.classList.toggle('sel',a.on);recalc();};
  addonList.appendChild(r);
});

function recalc(){
  let base=0;items.forEach(it=>base+=it.q*it.pr);
  let add=0,mult=1;addons.forEach(a=>{if(a.on){if(a.mult)mult=a.mult;else add+=a.pr;}});
  let low=(base+add)*mult;
  const totalEl=document.getElementById('calcTotal'),hintEl=document.getElementById('calcHint');
  if(low<=0){totalEl.textContent='0 ₽';hintEl.textContent='Выберите, что нужно собрать';lastTotal={low:0,high:0,mid:0};return;}
  let high=Math.round(low*1.2/100)*100;low=Math.round(low/100)*100;
  const mid=Math.round((low+high)/2);
  lastTotal={low,high,mid};
  totalEl.textContent=fmt(low)+' – '+fmt(high);
  hintEl.textContent='Мастер уточнит цену на месте';
  document.getElementById('budgetInp').value=mid.toLocaleString('ru-RU');
}

// ===== Контракт для api.js (бэкенд-Claude): состав заказа из калькулятора =====
window.getCalcState=()=>({
  items: items.filter(it=>it.q>0).map(it=>({id:it.id,nm:it.nm,qty:it.q,price:it.pr})),
  addons: addons.filter(a=>a.on).map(a=>({id:a.id,nm:a.nm,price:a.pr||0,mult:a.mult||null})),
  total: {...lastTotal}
});

// ===== Переключение экранов заявка <-> спасибо (для api.js) =====
function switchView(v){
  document.querySelectorAll('[data-cview]').forEach(x=>x.classList.toggle('on',x.dataset.cview===v));
  const sc=document.querySelector('.screen'); if(sc) sc.scrollTop=0;
}
window.showThanks=()=>switchView('done');

const again=document.getElementById('leadAgain');
if(again) again.onclick=()=>{
  items.forEach(it=>{it.q=0;const q=document.getElementById('q_'+it.id);if(q)q.textContent='0';});
  addons.forEach(a=>a.on=false);
  document.querySelectorAll('.addon.sel').forEach(el=>el.classList.remove('sel'));
  ['f_name','f_phone','f_address','f_date','f_time'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  recalc();
  switchView('calc');
};

// превью числа выбранных фото
const photoInput=document.getElementById('f_photos');
const photoCount=document.getElementById('photoCount');
if(photoInput) photoInput.onchange=()=>{
  const n=photoInput.files.length;
  photoCount.textContent = n ? ('Выбрано фото: '+n) : 'Для проектной кухни приложите проект или чертёж';
};
