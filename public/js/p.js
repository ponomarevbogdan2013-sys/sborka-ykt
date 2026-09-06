// ===== Кабинет партнёра — клиент (/api/partner/*) =====
const $=s=>document.querySelector(s);
const fmt=n=>Number(n||0).toLocaleString('ru-RU')+' ₽';
const numOnly=s=>parseInt(String(s).replace(/\D/g,''),10)||0;
const TIER={base:'базовый',silver:'серебряный',gold:'золотой'};
let me=null;

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
  $('#tierText').textContent='Уровень: '+(TIER[d.tier]||'базовый')+' · комиссия '+(d.commission_pct||8)+'%';
  $('#stClicks').textContent=d.clicks||0;
  $('#stOrders').textContent=d.orders_count||0;
  $('#stDone').textContent=d.done_count||0;
  $('#stEarned').textContent=fmt(d.total_earned_rub);
  $('#stBalance').textContent=fmt(d.balance_rub);
  $('#poBalance').textContent=fmt(d.balance_rub);
  if(d.qr_url)$('#pQr').src=d.qr_url;
  $('#pRef').textContent=d.ref_link||'';
}

$('#copyRef').onclick=async()=>{
  try{await navigator.clipboard.writeText(me.ref_link||'');$('#copyRef').textContent='Скопировано ✓';setTimeout(()=>$('#copyRef').textContent='Скопировать ссылку',1500);}catch(e){}
};
$('#toPayout').onclick=()=>{showView('payout');loadPayouts();};

async function loadOrders(){
  try{
    const {orders=[]}=await api('/partner/orders');
    $('#pOrdersEmpty').hidden=orders.length>0;
    const bs={open:['b-new','Ждёт'],assigned:['b-prog','Назначен'],en_route:['b-prog','В работе'],working:['b-prog','В работе'],done:['b-done','Выполнено'],cancelled:['b-done','Отменён']};
    $('#pOrdersList').innerHTML=orders.map(o=>{
      const b=bs[o.status]||['b-new',o.status];
      const com=o.partner_commission_rub?`<div class="budget" style="color:var(--green)">+${fmt(o.partner_commission_rub)} <small>вам</small></div>`:'<div class="rline">комиссия при выполнении</div>';
      return `<div class="card ordcard"><div class="ordtop"><h3>${o.title||'Заказ'}</h3><span class="badge ${b[0]}">${b[1]}</span></div>
        <div class="metaline"><span>${o.agreed_price_rub?('сумма '+fmt(o.agreed_price_rub)):'в работе'}</span></div>${com}</div>`;
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
