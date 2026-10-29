// ===== Кабинет партнёра — клиент (/api/partner/*) =====
const $=s=>document.querySelector(s);
const fmt=n=>Number(n||0).toLocaleString('ru-RU')+' ₽';
const numOnly=s=>parseInt(String(s).replace(/\D/g,''),10)||0;
let me=null;
// Ссылка для показа людям: «xn--14-…xn--p1ai» → «мастера14.рф», без https://. QR при этом не меняется.
function punyDecode(l){const b=36,o=[];let n=128,i=0,bias=72,d=l.lastIndexOf('-');
  for(let j=0;j<Math.max(d,0);j++)o.push(l.charCodeAt(j));
  for(let k=d>0?d+1:0;k<l.length;){const oi=i;let w=1;
    for(let t=b;;t+=b){const c=l.charCodeAt(k++);const dg=c-48<10?c-22:c-65<26?c-65:c-97<26?c-97:b;
      i+=dg*w;const tt=t<=bias?1:t>=bias+26?26:t-bias;if(dg<tt)break;w*=b-tt;}
    let dl=i-oi,h=o.length+1;dl=oi===0?Math.floor(dl/700):dl>>1;dl+=Math.floor(dl/h);let kk=0;
    while(dl>455){dl=Math.floor(dl/35);kk+=b;}bias=kk+Math.floor(36*dl/(dl+38));
    n+=Math.floor(i/h);i%=h;o.splice(i++,0,n);}
  return String.fromCodePoint(...o);}
function prettyLink(u){try{const x=new URL(u);
  const host=x.hostname.split('.').map(l=>l.startsWith('xn--')?punyDecode(l.slice(4)):l).join('.');
  return host+(x.port?':'+x.port:'')+(x.pathname==='/'?'/':x.pathname)+x.search;}catch(e){return u||'';}}

async function api(path,opts={}){
  const r=await fetch('/api'+path,{credentials:'include',...opts});
  if(r.status===401){showView('auth');pTabs.hidden=true;throw new Error('auth');}
  const ct=r.headers.get('content-type')||'';const d=ct.includes('json')?await r.json():await r.text();
  if(!r.ok)throw new Error((d&&d.error)||'Ошибка');return d;
}
const jpost=(p,b)=>api(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
function err(id,msg){const e=$('#'+id);if(!msg){e.hidden=true;return;}e.textContent=msg;e.hidden=false;}

const pTabs=$('#pTabs');
function showView(v){
  document.querySelectorAll('[data-pv]').forEach(x=>x.classList.toggle('on',x.dataset.pv===v));
  $('.screen').scrollTop=0;
  const inCab=['dash','orders','payout'].includes(v);
  pTabs.hidden=!inCab;
  if(inCab)document.querySelectorAll('#pTabs button').forEach(b=>b.classList.toggle('on',b.dataset.tab===v));
}
document.querySelectorAll('#pTabs button').forEach(b=>b.onclick=()=>{
  const t=b.dataset.tab;showView(t);
  if(t==='orders')loadOrders();if(t==='payout')loadPayouts();
});

(async function init(){
  try{const d=await api('/partner/me');onMe(d);showView('dash');}
  catch(e){showView('auth');}
})();

$('#pLoginBtn').onclick=async()=>{
  err('pAuthErr','');
  try{await jpost('/partner/login',{phone:$('#pa_phone').value.trim(),password:$('#pa_pass').value});
    onMe(await api('/partner/me'));showView('dash');}
  catch(e){err('pAuthErr',e.message==='auth'?'Неверный телефон или пароль':e.message);}
};

function onMe(d){
  me=d;
  $('#pTitle').textContent=d.title||'Партнёр';
  $('#pSub').textContent='Кабинет магазина';
  $('#tierText').textContent='Комиссия '+(d.commission_pct||5)+'%';
  $('#stClicks').textContent=d.clicks||0;
  $('#stOrders').textContent=d.orders_count||0;
  $('#stDone').textContent=d.done_count||0;
  $('#stEarned').textContent=fmt(d.total_earned_rub);
  $('#stBalance').textContent=fmt(d.balance_rub);
  $('#poBalance').textContent=fmt(d.balance_rub);
  if(d.qr_url)$('#pQr').src=d.qr_url;
  $('#pRef').textContent=prettyLink(d.ref_link);
}

$('#copyRef').onclick=async()=>{
  try{await navigator.clipboard.writeText(me.ref_link?'https://'+prettyLink(me.ref_link):'');$('#copyRef').textContent='Скопировано ✓';setTimeout(()=>$('#copyRef').textContent='Скопировать ссылку',1500);}catch(e){}
};
$('#toPayout').onclick=()=>{showView('payout');loadPayouts();};

async function loadOrders(){
  try{
    const {orders=[]}=await api('/partner/orders');
    $('#pOrdersEmpty').hidden=orders.length>0;
    const bs={open:['b-new','Ждёт'],assigned:['b-prog','Назначен'],agreed:['b-prog','Договорились'],en_route:['b-prog','В работе'],working:['b-prog','В работе'],done:['b-done','Выполнено'],cancelled:['b-done','Отменён']};
    $('#pOrdersList').innerHTML=orders.map(o=>{
      const b=bs[o.status]||['b-new',o.status];
      const com=o.partner_commission_rub?`<div class="budget" style="color:var(--green)">+${fmt(o.partner_commission_rub)} <small>вам</small></div>`:'<div class="rline">комиссия при выполнении</div>';
      return `<div class="card ordcard"><div class="ordtop"><h3>${o.title||'Заказ'}</h3><span class="badge ${b[0]}">${b[1]}</span></div>
        <div class="metaline">${o.category_label?`<span>${o.category_label}</span>`:''}<span>${o.agreed_price_rub?('сумма '+fmt(o.agreed_price_rub)):'в работе'}</span></div>${com}</div>`;
    }).join('');
  }catch(e){}
}

async function loadPayouts(){
  $('#poBalance').textContent=fmt(me&&me.balance_rub);
  try{
    const {payouts=[]}=await api('/partner/payouts');
    const st={requested:['b-new','на рассмотрении'],paid:['b-done','выплачено'],rejected:['b-done','отклонено']};
    $('#poHistory').innerHTML=payouts.length?payouts.map(p=>{
      const s=st[p.status]||['b-new',p.status];
      return `<div class="pstat"><span class="l">${(p.requested_at||'').slice(0,10)} · ${fmt(p.amount_rub)}</span><span class="badge ${s[0]}">${s[1]}</span></div>`;
    }).join(''):'<div class="pstat"><span class="l">Выводов пока нет</span></div>';
  }catch(e){}
}

$('#poSend').onclick=async()=>{
  err('poErr','');
  const amount=numOnly($('#po_amount').value);
  const details=$('#po_details').value.trim();
  if(amount<1)return err('poErr','Укажите сумму');
  if(amount>(me&&me.balance_rub||0))return err('poErr','Больше доступного баланса');
  if(!details)return err('poErr','Укажите куда перевести');
  try{
    await jpost('/partner/payout',{amount_rub:amount,details});
    $('#po_amount').value='';$('#po_details').value='';
    onMe(await api('/partner/me'));loadPayouts();
    $('#poSend').textContent='Заявка отправлена ✓';setTimeout(()=>$('#poSend').textContent='Запросить вывод',1800);
  }catch(e){err('poErr',e.message);}
};

// Автообновление каждые 15 с: цифры, заказы и выплаты подтягиваются сами, пока приложение открыто.
// Поля ввода (сумма и реквизиты вывода) не трогаем — обновляются только подписи и списки.
function refreshNow(){
  const cur=document.querySelector('[data-pv].on');
  const v=cur&&cur.dataset.pv;
  const jobs=[api('/partner/me').then(onMe)];
  if(v==='orders')jobs.push(loadOrders());
  if(v==='payout')jobs.push(loadPayouts());
  return Promise.all(jobs).then(()=>true).catch(()=>false);   // false — нет связи
}
function autoRefresh(){
  if(document.visibilityState!=='visible'||pTabs.hidden)return;
  refreshNow();
}
setInterval(autoRefresh,15000);
document.addEventListener('visibilitychange',autoRefresh);
window.addEventListener('online',autoRefresh);
// «Потяните вниз, чтобы обновить» — в установленном приложении нет обновления страницы браузера (ptr.js)
if(window.pullToRefresh)pullToRefresh({isActive:()=>!pTabs.hidden,onRefresh:refreshNow});
