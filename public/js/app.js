const PRICE=42; // rub per line placeholder base — overridden per item
const items=[
  {id:'kitchen_mod',nm:'Кухня модульная (с магазина)',pr:5000,unit:'за метр',q:0},
  {id:'kitchen_proj',nm:'Кухня на заказ (проектная)',pr:8000,unit:'за метр',q:0},
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
  {id:'demo',nm:'Демонтаж старой мебели',pr:2000,on:false},
  {id:'trash',nm:'Вывоз мусора',pr:1000,on:false},
  {id:'hang',nm:'Навеска: полки, ТВ, карнизы',pr:1000,on:false},
  {id:'urgent',nm:'Срочно, прямо сейчас (+30%)',pr:0,on:false,mult:1.3},
];
const fmt=n=>n.toLocaleString('ru-RU')+' ₽';
const calcList=document.getElementById('calcList');
const addonList=document.getElementById('addonList');
items.forEach((it,i)=>{
  const r=document.createElement('div');r.className='calc-row';
  r.innerHTML=`<div class="nm">${it.nm}<div class="pr">${fmt(it.pr)} · ${it.unit}</div></div>
  <div class="step"><button aria-label="меньше">–</button><span id="q_${it.id}">0</span><button aria-label="больше">+</button></div>`;
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
// portfolio placeholders (photos of real work in production)
const pfItems=['Кухня','Шкаф-купе','Кровать','Детская','Комод','Диван'];
const picIco='<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 15l-5-5L5 20"/></svg>';
const pfEl=document.getElementById('portfolio');
if(pfEl)pfEl.innerHTML=pfItems.map(p=>`<div class="pf">${picIco}<span>${p}</span></div>`).join('');

function recalc(){
  let base=0;items.forEach(it=>base+=it.q*it.pr);
  let add=0,mult=1;addons.forEach(a=>{if(a.on){if(a.mult)mult=a.mult;else add+=a.pr;}});
  let low=(base+add)*mult;
  const totalEl=document.getElementById('calcTotal'),hintEl=document.getElementById('calcHint');
  if(low<=0){totalEl.textContent='0 ₽';hintEl.textContent='Выберите, что нужно собрать';return;}
  let high=Math.round(low*1.2/100)*100;low=Math.round(low/100)*100;
  totalEl.textContent=fmt(low)+' – '+fmt(high);
  hintEl.textContent='Мастер уточнит цену на месте';
  document.getElementById('budgetInp').value=Math.round((low+high)/2).toLocaleString('ru-RU');
}

// ---- navigation ----
function goRole(role){
  document.querySelectorAll('.role').forEach(r=>r.classList.toggle('on',r.dataset.role===role));
  document.querySelectorAll('#roleSeg button').forEach(b=>{
    const map=(role==='masterprofile'||role==='deal')?'client':role;
    b.classList.toggle('on',b.dataset.role===map);
  });
}
document.querySelectorAll('#roleSeg button').forEach(b=>b.onclick=()=>goRole(b.dataset.role));

function showClient(view){
  document.querySelectorAll('[data-cview]').forEach(v=>v.classList.toggle('on',v.dataset.cview===view));
  const t={calc:['Новый заказ','Шаг 1 · что собрать и детали'],offers:['Отклики','Шаг 2 · выберите мастера']}[view];
  document.querySelector('[data-ctitle]').textContent=t[0];
  document.querySelector('[data-csub]').textContent=t[1];
  document.querySelectorAll('#clientTabs button').forEach(x=>x.classList.remove('on'));
  if(view==='calc')document.querySelector('#clientTabs button[data-goto="calc"]').classList.add('on');
  if(view==='offers')document.querySelector('#clientTabs button[data-goto="offers"]').classList.add('on');
  document.querySelector('.role[data-role="client"] .screen').scrollTop=0;
}
document.querySelectorAll('[data-goto]').forEach(el=>el.onclick=()=>showClient(el.dataset.goto));
document.querySelectorAll('[data-goto-role]').forEach(el=>el.onclick=()=>{
  if(el.dataset.gotoRole==='master')goRole('masterprofile');else goRole(el.dataset.gotoRole);
});

function showMaster(view){
  // only feed implemented; profile reuses masterprofile role
  if(view==='prof'){goRole('masterprofile');return;}
}
document.querySelectorAll('[data-mview]').forEach(el=>el.onclick=()=>showMaster(el.dataset.mview));

// theme
const tb=document.getElementById('themeBtn');
tb.onclick=()=>{
  const cur=document.documentElement.getAttribute('data-theme');
  const next=cur==='dark'?'light':(cur==='light'?'':'dark');
  if(next)document.documentElement.setAttribute('data-theme',next);
  else document.documentElement.removeAttribute('data-theme');
};
