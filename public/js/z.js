// ===== Клиентская страница /z/<token> — отклики, выбор, сделка, отзыв =====
(function(){
  const m=location.pathname.match(/^\/z\/([A-Za-z0-9_-]+)/);
  const token=m&&m[1];
  if(!token)return; // не /z — работает обычная форма (app.js)

  const fmt=n=>Number(n||0).toLocaleString('ru-RU')+' ₽';
  const $=s=>document.querySelector(s);
  const STEPS=[['assigned','Назначен'],['en_route','Едет'],['working','Собирает'],['done','Готово']];
  const OK='<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>';
  const VERIF='<span class="verif">'+OK+'</span>';
  let data=null, current=null;

  function zshow(v){document.querySelectorAll('[data-cview]').forEach(x=>x.classList.toggle('on',x.dataset.cview===v));const sc=$('.screen');if(sc)sc.scrollTop=0;}
  async function zapi(path,opts={}){
    const r=await fetch('/api/z/'+token+path,{credentials:'include',...opts});
    const ct=r.headers.get('content-type')||'';const d=ct.includes('json')?await r.json():await r.text();
    if(!r.ok)throw new Error((d&&d.error)||'Ошибка');return d;
  }
  const jpost=(p,b)=>zapi(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});

  async function load(){
    try{
      data=await zapi('');
      $('#zHello').textContent=data.client&&data.client.name?('Заявки · '+data.client.name):'Ваши заявки';
      const orders=data.orders||[];
      if(orders.length===1){openOrder(orders[0].id);}
      else{renderList(orders);zshow('zlist');}
    }catch(e){
      $('#zListItems').innerHTML='<div class="callout">Заявка не найдена или ссылка устарела.</div>';zshow('zlist');
    }
  }

  function title(o){return o.title||(o.items||[]).map(i=>i.nm+(i.qty>1?' ×'+i.qty:'')).join(', ')||'Заказ';}
  const bStatus={open:['b-new','Ждёт откликов'],assigned:['b-prog','Мастер назначен'],en_route:['b-prog','Мастер едет'],working:['b-prog','В работе'],done:['b-done','Выполнено'],cancelled:['b-done','Отменён']};

  function renderList(orders){
    $('#zListItems').innerHTML=orders.map(o=>{
      const b=bStatus[o.status]||['b-new',o.status];
      const cnt=(o.offers&&o.offers.length)?`${o.offers.length} откл.`:'';
      return `<div class="card ordcard" data-open="${o.id}" style="cursor:pointer">
        <div class="ordtop"><h3>${title(o)}</h3><span class="badge ${b[0]}">${b[1]}</span></div>
        <div class="metaline"><span>📍 <b>${o.district||''}</b></span><span>~${fmt(o.budget_rub)}</span>${cnt?`<span>${cnt}</span>`:''}</div>
      </div>`;
    }).join('');
    $('#zListItems').querySelectorAll('[data-open]').forEach(c=>c.onclick=()=>openOrder(c.dataset.open));
  }

  function masterRow(off){
    const mst=off.master||{};
    const stars='★★★★★'.slice(0,Math.round(mst.rating_avg||5))+'☆☆☆☆☆'.slice(0,5-Math.round(mst.rating_avg||5));
    const vf=mst.verified?'<span class="verif"><svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg></span>':'';
    return `<div class="offer">
      <div class="av">${(mst.name||'М').slice(0,1)}</div>
      <div><div class="nm">${mst.name||'Мастер'} ${vf}</div>
        <div class="stars">${stars} <span style="color:var(--muted)">${(mst.rating_avg||5).toFixed(1)}</span></div>
        <div class="rline">${mst.orders_done||0} заказов${off.note?' · '+off.note:''}</div></div>
      <div class="oprice"><div class="v">${fmt(off.price_rub)}</div>
        <button class="btn navy" style="width:auto;margin:6px 0 0;padding:7px 14px;font-size:13px" data-choose="${off.id}">Выбрать</button></div>
    </div>`;
  }

  function tracker(status){
    const idx=STEPS.findIndex(s=>s[0]===status);
    return `<div class="tracker">${STEPS.map((s,i)=>`<div class="tstep ${i<idx?'done':(i===idx?'active':'')}"><div class="tdot">${i<idx?OK:(i+1)}</div><div class="tlbl">${s[1]}</div></div>`).join('')}</div>`;
  }

  function openOrder(id){
    current=(data.orders||[]).find(o=>o.id==id);if(!current)return;
    const o=current, b=bStatus[o.status]||['b-new',o.status];
    $('#zOrderHead').innerHTML=`<div class="ordtop" style="margin-bottom:8px"><h2 class="sc">${title(o)}</h2><span class="badge ${b[0]}">${b[1]}</span></div>
      <div class="metaline"><span>📍 <b>${o.district||''}</b> ${o.address||''}</span><span>~${fmt(o.budget_rub)}</span></div>`;
    let html='';
    if(o.status==='open'){
      const offers=o.offers||[];
      if(offers.length){
        html+='<div class="eyebrow">Откликнулись мастера</div><div class="card" style="margin-bottom:12px">'+offers.map(masterRow).join('')+'</div>';
      }else{
        html+='<div class="callout" style="margin-top:14px"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>Заявка отправлена мастерам. Отклики появятся здесь — придёт уведомление.</div>';
      }
      html+='<button class="btn ghost" id="zCancelBtn" style="margin-top:10px">Отменить заявку</button>';
    }else if(o.deal){
      const d=o.deal, mst=d.master||{}, vf=mst.verified?VERIF:'';
      html+='<div class="eyebrow">Ваш мастер</div>';
      html+='<div class="card" style="margin-bottom:12px"><div class="offer">';
      html+='<div class="av">'+((mst.name||'М').slice(0,1))+'</div>';
      html+='<div><div class="nm">'+(mst.name||'Мастер')+' '+vf+'</div>';
      html+='<div class="stars">★★★★★ <span style="color:var(--muted)">'+((mst.rating_avg||5).toFixed(1))+'</span></div>';
      html+='<div class="rline">'+(mst.phone||'телефон в чате')+'</div></div>';
      html+='<div class="oprice"><div class="v">'+fmt(d.agreed_price_rub)+'</div></div></div></div>';
      html+=tracker(o.status);
      if(o.status==='done'){
        if(o.review){html+='<div class="callout" style="background:var(--green-bg);color:var(--green);margin-top:14px">'+OK+' Спасибо за отзыв!</div>';}
        else{html+=reviewForm();}
      }
    }
    $('#zOrderBody').innerHTML=html;
    $('#zOrderBody').querySelectorAll('[data-choose]').forEach(btn=>btn.onclick=()=>choose(btn.dataset.choose));
    const cancel=$('#zCancelBtn');if(cancel)cancel.onclick=()=>doCancel();
    bindReview();
    zshow('zorder');
  }

  function reviewForm(){
    return `<div class="eyebrow">Оцените мастера</div>
      <div class="starpick" id="starPick">${[1,2,3,4,5].map(i=>`<span data-star="${i}">★</span>`).join('')}</div>
      <div class="field"><input class="inp" id="rvText" placeholder="Пара слов о работе (необязательно)"></div>
      <button class="btn primary" id="rvSend">Оставить отзыв</button>`;
  }
  let rvRating=5;
  function bindReview(){
    const sp=$('#starPick');if(!sp)return;
    const paint=()=>sp.querySelectorAll('[data-star]').forEach(s=>s.classList.toggle('on',+s.dataset.star<=rvRating));
    sp.querySelectorAll('[data-star]').forEach(s=>s.onclick=()=>{rvRating=+s.dataset.star;paint();});
    paint();
    $('#rvSend').onclick=()=>askPin('Подтвердите отзыв',p4=>jpost('/review',{order_id:current.id,rating:rvRating,text:$('#rvText').value.trim(),phone4:p4}).then(reload));
  }

  function choose(offerId){askPin('Подтвердите выбор мастера',p4=>jpost('/choose',{offer_id:+offerId,phone4:p4}).then(reload));}
  function doCancel(){askPin('Подтвердите отмену',p4=>jpost('/cancel',{order_id:current.id,reason:'клиент отменил',phone4:p4}).then(reload));}
  async function reload(){closePin();const id=current&&current.id;data=await zapi('');if(id)openOrder(id);else load();}

  // ---- модалка 4 цифр ----
  const modal=$('#pinModal');let pinCb=null;
  function askPin(titleText,cb){$('#pinTitle').textContent=titleText;$('#pin4').value='';$('#pinErr').hidden=true;pinCb=cb;modal.hidden=false;$('#pin4').focus();}
  function closePin(){modal.hidden=true;pinCb=null;}
  $('#pinCancel').onclick=closePin;
  $('#pinOk').onclick=async()=>{
    const v=$('#pin4').value.replace(/\D/g,'');
    if(v.length!==4){$('#pinErr').textContent='Введите 4 цифры';$('#pinErr').hidden=false;return;}
    try{await pinCb(v);}catch(e){$('#pinErr').textContent=e.message||'Не совпало';$('#pinErr').hidden=false;}
  };
  $('#zBack').onclick=()=>{renderList(data.orders||[]);zshow('zlist');};

  load();
})();
