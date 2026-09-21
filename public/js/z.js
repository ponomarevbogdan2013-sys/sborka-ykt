// ===== Клиент: отклики, выбор, сделка, отзыв. Работает и по ссылке /z/<token>,
// и внутри приложения по вкладке «Заказ» — токен берётся из ссылки или из
// localStorage (сохраняется там после первой заявки, см. api.js) =====
(function(){
  const $=s=>document.querySelector(s);
  const zshow=window.switchView;
  const fmt=n=>Number(n||0).toLocaleString('ru-RU')+' ₽';
  const STEPS=[['assigned','Назначен'],['en_route','Едет'],['working','Собирает'],['done','Готово']];
  const OK='<svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg>';
  const VERIF='<span class="verif">'+OK+'</span>';
  const PIN='<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px"><path d="M12 21s7-6.4 7-11a7 7 0 1 0-14 0c0 4.6 7 11 7 11z"/><circle cx="12" cy="10" r="2.3"/></svg> ';
  let data=null, current=null, token=null;
  let shownSig='';   // подпись данных, которые СЕЙЧАС нарисованы на экране (см. refresh)
  const sigOf=d=>JSON.stringify((d&&d.orders)||[]);

  function tokenFromPath(){const m=location.pathname.match(/^\/z\/([A-Za-z0-9_-]+)/);return m&&m[1];}
  function resolveToken(){
    const t=tokenFromPath();
    if(t){try{localStorage.setItem('sborka_token',t);}catch(e){}return t;}
    try{return localStorage.getItem('sborka_token')||null;}catch(e){return null;}
  }
  async function zapi(path,opts={}){
    const r=await fetch('/api/z/'+token+path,{credentials:'include',...opts});
    const ct=r.headers.get('content-type')||'';const d=ct.includes('json')?await r.json():await r.text();
    if(!r.ok)throw new Error((d&&d.error)||'Ошибка');return d;
  }
  const jpost=(p,b)=>zapi(p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});

  // Манифест с токеном клиента (server.js /manifest-z/): установленное приложение (на iOS — с
  // отдельным хранилищем) открывается сразу на его заявках, а не на калькуляторе без токена.
  // Подставляем только когда токен подтверждён ответом сервера — иначе манифест дал бы 404.
  function bindManifest(){
    const link=document.querySelector('link[rel="manifest"]');
    if(token&&link&&!/manifest-z/.test(link.getAttribute('href')||''))link.setAttribute('href','/manifest-z/'+token);
  }

  // Действующая заявка — ещё не завершена и не отменена.
  const ACTIVE=['open','assigned','en_route','working'];

  // mode=true — открыть вкладку «Заказ» со списком (клик по вкладке, данных ещё нет).
  // mode='start' — вход/обновление страницы: если есть действующая заявка — открыть её
  //   (самую новую), иначе остаётся калькулятор.
  // mode=false — тихая подгрузка в фоне, чтобы вкладка открылась мгновенно.
  async function load(mode){
    token=resolveToken();
    if(!token){ if(mode===true){renderEmpty();zshow('zlist');} return; }
    try{
      data=await zapi('');shownSig=sigOf(data);
      bindManifest();
      $('#zHello').textContent=data.client&&data.client.name?('Заявки · '+data.client.name):'Ваши заявки';
      const orders=data.orders||[];   // от новых к старым
      renderList(orders);
      if(mode===true){
        zshow('zlist');
      }else if(mode==='start'){
        const act=orders.find(o=>ACTIVE.includes(o.status));
        const onCalc=$('[data-cview="calc"]').classList.contains('on'); // клиент уже не ушёл на другой экран
        if(act&&onCalc)openOrder(act.id);
      }
    }catch(e){
      // битая ссылка /z/<token> — сказать об этом; на обычном входе молчим, остаётся калькулятор
      if(mode===true||(mode==='start'&&tokenFromPath())){
        $('#zListItems').innerHTML='<div class="callout">Заявка не найдена или ссылка устарела.</div>';zshow('zlist');
      }
    }
  }
  function renderEmpty(){
    $('#zHello').textContent='Ваши заявки';
    $('#zListItems').innerHTML='<div class="callout">Заявок пока нет — оформите первую на вкладке «Заявка».</div>';
  }

  function title(o){return o.title||(o.items||[]).map(i=>i.nm+(i.qty>1?' ×'+i.qty:'')).join(', ')||'Заказ';}
  const bStatus={open:['b-new','Ждёт откликов'],assigned:['b-prog','Мастер назначен'],en_route:['b-prog','Мастер едет'],working:['b-prog','В работе'],done:['b-done','Выполнено'],cancelled:['b-done','Отменён']};

  function renderList(orders){
    $('#zListItems').innerHTML=orders.map(o=>{
      const b=bStatus[o.status]||['b-new',o.status];
      const cnt=(o.offers&&o.offers.length)?`${o.offers.length} откл.`:'';
      return `<div class="card ordcard" data-open="${o.id}" style="cursor:pointer">
        <div class="ordtop"><h3>${title(o)}</h3><span class="badge ${b[0]}">${b[1]}</span></div>
        <div class="metaline"><span>${PIN}<b>${o.address||''}</b></span><span>~${fmt(o.budget_rub)}</span>${cnt?`<span>${cnt}</span>`:''}</div>
      </div>`;
    }).join('');
    $('#zListItems').querySelectorAll('[data-open]').forEach(c=>c.onclick=()=>openOrder(c.dataset.open));
  }

  const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  function masterRow(off){
    const mst=off.master||{};
    const stars='★★★★★'.slice(0,Math.round(mst.rating_avg||5))+'☆☆☆☆☆'.slice(0,5-Math.round(mst.rating_avg||5));
    const vf=mst.verified?'<span class="verif"><svg viewBox="0 0 24 24"><path d="M4 12l5 5L20 6"/></svg></span>':'';
    // нажатие на карточку открывает анкету мастера (кнопка «Выбрать» — отдельно)
    return `<div class="offer" data-mprof="${mst.id||''}" data-offer="${off.id}" style="cursor:pointer">
      <div class="av">${esc((mst.name||'М').slice(0,1))}</div>
      <div><div class="nm">${esc(mst.name||'Мастер')} ${vf}</div>
        <div class="stars">${stars} <span style="color:var(--muted)">${(mst.rating_avg||5).toFixed(1)}</span></div>
        <div class="rline">${mst.orders_done||0} заказов${off.note?' · '+esc(off.note):''} · анкета ›</div></div>
      <div class="oprice"><div class="v">${fmt(off.price_rub)}</div>
        <button class="btn navy" style="width:auto;margin:6px 0 0;padding:7px 14px;font-size:13px" data-choose="${off.id}">Выбрать</button></div>
    </div>`;
  }

  // ---- Анкета мастера (публичная часть; макет — reference/mockup.html, masterprofile) ----
  const yearsWord=n=>{const t=n%100,u=n%10;return n+' '+((t>10&&t<15)?'лет':u===1?'год':(u>1&&u<5)?'года':'лет');};
  function profileHtml(m,offerId){
    const ini=String(m.name||'М').trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase()||'М';
    const av=m.photo_url
      ?`<div class="pav" style="background-image:url('${esc(m.photo_url)}');background-size:cover;background-position:center"></div>`
      :`<div class="pav">${esc(ini)}</div>`;
    const skills=(m.categories||[]).concat(m.has_tools?['Свой инструмент']:[],m.has_car?['Есть автомобиль']:[]);
    const pf=(m.portfolio||[]).map(p=>`<div class="pf" style="background-image:url('${esc(p.photo_url)}');background-size:cover;background-position:center"></div>`).join('');
    const rv=(m.reviews||[]).map(r=>`<div class="review"><div class="rvtop"><span class="who">${esc(r.who)}</span><span class="stars">${'★'.repeat(r.rating||0)}${'☆'.repeat(5-(r.rating||0))}</span></div>${r.text?`<p>${esc(r.text)}</p>`:''}</div>`).join('');
    return `<div class="profhead">${av}<div>
        <h3>${esc(m.name||'Мастер')} ${m.verified?VERIF:''}</h3>
        ${m.about?`<div class="pm">${esc(m.about)}</div>`:''}
      </div></div>
      <div class="pad">
        <div class="statgrid">
          <div class="stat"><div class="n">${Number(m.rating_avg||5).toFixed(1)}</div><div class="l">рейтинг</div></div>
          <div class="stat"><div class="n">${m.orders_done||0}</div><div class="l">заказов</div></div>
          <div class="stat"><div class="n">${m.experience_years!=null?yearsWord(m.experience_years):'—'}</div><div class="l">опыт</div></div>
        </div>
        ${skills.length?`<div class="eyebrow" style="margin-top:6px">Что умеет</div><div class="skills">${skills.map(s=>`<span class="skill">${esc(s)}</span>`).join('')}</div>`:''}
        <div class="eyebrow">Портфолио</div>
        ${pf?`<div class="portfolio">${pf}</div>`:'<p class="note">Мастер пока не добавил фото работ.</p>'}
        <div class="eyebrow">Отзывы</div>
        ${rv?`<div class="card" style="padding:2px 14px">${rv}</div>`:'<p class="note">Отзывов пока нет.</p>'}
        ${offerId?`<button class="btn primary" style="margin-top:16px" data-choose-prof="${esc(offerId)}">Выбрать этого мастера</button>`:''}
      </div>`;
  }
  async function openProfile(mid,offerId){
    const body=$('#mProfBody');
    try{
      const r=await zapi('/master/'+mid);
      body.innerHTML=profileHtml(r.master,offerId);
      const b=body.querySelector('[data-choose-prof]');
      if(b)b.onclick=()=>choose(b.dataset.chooseProf);
    }catch(e){
      body.innerHTML='<div class="pad"><div class="callout">Не удалось открыть анкету. Вернитесь к заявке и попробуйте ещё раз.</div></div>';
    }
    zshow('mprof');
  }
  $('#mBack').onclick=()=>{if(current)openOrder(current.id);else zshow('zlist');};

  function tracker(status){
    const idx=STEPS.findIndex(s=>s[0]===status);
    return `<div class="tracker">${STEPS.map((s,i)=>`<div class="tstep ${i<idx?'done':(i===idx?'active':'')}"><div class="tdot">${i<idx?OK:(i+1)}</div><div class="tlbl">${s[1]}</div></div>`).join('')}</div>`;
  }

  function openOrder(id){
    current=(data.orders||[]).find(o=>o.id==id);if(!current)return;
    const o=current, b=bStatus[o.status]||['b-new',o.status];
    $('#zOrderHead').innerHTML=`<div class="ordtop" style="margin-bottom:8px"><h2 class="sc">${title(o)}</h2><span class="badge ${b[0]}">${b[1]}</span></div>
      <div class="metaline"><span>${PIN}<b>${o.address||''}</b></span><span>~${fmt(o.budget_rub)}</span></div>`;
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
      html+='<div class="card" style="margin-bottom:12px"><div class="offer"'+(mst.id?' data-mprof="'+mst.id+'" style="cursor:pointer"':'')+'>';
      html+='<div class="av">'+esc((mst.name||'М').slice(0,1))+'</div>';
      html+='<div><div class="nm">'+esc(mst.name||'Мастер')+' '+vf+'</div>';
      html+='<div class="stars">★★★★★ <span style="color:var(--muted)">'+((mst.rating_avg||5).toFixed(1))+'</span></div>';
      html+='<div class="rline">'+esc(mst.phone||'телефон в чате')+(mst.id?' · анкета ›':'')+'</div></div>';
      html+='<div class="oprice"><div class="v">'+fmt(d.agreed_price_rub)+'</div></div></div></div>';
      html+=tracker(o.status);
      if(o.status==='done'){
        if(o.review){html+='<div class="callout" style="background:var(--green-bg);color:var(--green);margin-top:14px">'+OK+' Спасибо за отзыв!</div>';}
        else{html+=reviewForm();}
      }
    }
    $('#zOrderBody').innerHTML=html;
    $('#zOrderBody').querySelectorAll('[data-choose]').forEach(btn=>btn.onclick=()=>choose(btn.dataset.choose));
    $('#zOrderBody').querySelectorAll('[data-mprof]').forEach(el=>el.onclick=e=>{
      if(e.target.closest('[data-choose]'))return;   // «Выбрать» — не открывать анкету
      if(el.dataset.mprof)openProfile(el.dataset.mprof,el.dataset.offer);
    });
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
    $('#rvSend').onclick=()=>jpost('/review',{order_id:current.id,rating:rvRating,text:$('#rvText').value.trim()}).then(reload);
  }

  function choose(offerId){jpost('/choose',{offer_id:+offerId}).then(reload);}
  function doCancel(){jpost('/cancel',{order_id:current.id,reason:'клиент отменил'}).then(reload);}
  async function reload(){closePin();const id=current&&current.id;data=await zapi('');shownSig=sigOf(data);if(id)openOrder(id);else load();}

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

  // вкладка «Заказ» внизу — открыть по накопленным данным, если уже подгружены,
  // иначе загрузить сейчас (например, если токена не было при старте страницы).
  const orderTab=document.querySelector('#cTabs [data-tab="order"]');
  if(orderTab) orderTab.addEventListener('click',()=>{
    if(!data){load(true);return;}
    if(current){openOrder(current.id);refresh(false);return;}
    const orders=data.orders||[];
    if(orders.length===1)openOrder(orders[0].id);else{renderList(orders);zshow('zlist');}
    refresh(false);   // показали то, что есть, и сразу подтягиваем свежее
  });

  // ---- Автообновление: отклики мастеров появляются без ручного обновления страницы ----
  const viewOn=v=>{const el=document.querySelector('[data-cview="'+v+'"]');return !!(el&&el.classList.contains('on'));};
  const onClientView=()=>viewOn('zorder')||viewOn('zlist');
  // не перерисовываем заявку, пока человек печатает (например, текст отзыва)
  const typing=()=>{const a=document.activeElement;return !!(a&&$('#zOrderBody').contains(a)&&/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName));};
  let refreshing=false;
  function setRefLabel(t){document.querySelectorAll('.zref .zl').forEach(x=>{x.textContent=t;});}
  // manual=true — нажали «Обновить» / потянули вниз: показываем результат подписью. Возвращает false, если нет связи.
  async function refresh(manual){
    if(refreshing)return true;
    token=resolveToken();if(!token)return false;
    refreshing=true;if(manual)setRefLabel('Обновляю…');
    let ok=true;
    try{
      const d=await zapi('');
      const sig=sigOf(d);
      const changed=sig!==shownSig;   // сравниваем с тем, что нарисовано, а не с прошлой загрузкой
      data=d;
      if(changed){
        renderList(d.orders||[]);
        if(viewOn('zorder')&&current){
          // человек печатает или открыт диалог — не перерисовываем; shownSig не трогаем,
          // значит на следующем опросе (через 15 с) попробуем снова
          if(!typing()&&modal.hidden){
            const sc=document.querySelector('.screen'),top=sc?sc.scrollTop:0;   // не сбрасывать прокрутку
            openOrder(current.id);
            if(sc)sc.scrollTop=top;
            shownSig=sig;
          }
        }else shownSig=sig;
      }
      if(manual)setRefLabel(changed?'Обновлено':'Всё актуально');
    }catch(e){ok=false;if(manual)setRefLabel('Нет связи');}
    finally{refreshing=false;if(manual)setTimeout(()=>setRefLabel('Обновить'),1600);}
    return ok;
  }
  document.querySelectorAll('.zref').forEach(b=>{b.onclick=()=>refresh(true);});
  setInterval(()=>{if(!document.hidden&&onClientView())refresh(false);},15000);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&onClientView())refresh(false);});
  window.addEventListener('focus',()=>{if(onClientView())refresh(false);});
  window.addEventListener('online',()=>{if(onClientView())refresh(false);});

  // «Потяните вниз, чтобы обновить» — в установленном приложении нет обновления страницы браузера (ptr.js)
  if(window.pullToRefresh)pullToRefresh({isActive:onClientView,onRefresh:()=>refresh(true)});

  // Вход или обновление (на / и на /z/<token>): калькулятор, а при действующей заявке — она.
  if(resolveToken()) load('start');
})();
