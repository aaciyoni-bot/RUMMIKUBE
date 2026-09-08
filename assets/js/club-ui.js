/* Shared, presentation-only club screens. Financial mutations stay in the app. */
(function (w) {
  'use strict';
  const R = w.React, h = R.createElement;
  const amount = n => (Number(n) || 0).toLocaleString('he-IL', {minimumFractionDigits:2, maximumFractionDigits:2});
  const icon = name => h('i', {className:'fa-solid fa-' + name, 'aria-hidden':true});

  function LobbyOverview({user, tables = [], brand, locale = 'he', onResume}) {
    const he = locale === 'he';
    const mine = tables.find(t => t.players && t.players[user.uid]);
    const seats = tables.reduce((n,t) => n + Object.keys(t.players || {}).length, 0);
    return h('section', {className:'club-welcome', dir:he?'rtl':'ltr', 'aria-label':he?'סיכום הלובי':'Lobby overview'},
      h('div', {className:'club-welcome-copy'},
        h('span', {className:'club-eyebrow'}, brand + ' / ' + (he?'המועדון שלך':'YOUR CLUB')),
        h('h1', null, he?'בוחרים שולחן. מתחילים לשחק.':'Your next hand starts here.'),
        h('p', null, he?`שלום ${user.username || 'שחקן'}, כל השולחנות והמשחקים שלך במקום אחד.`:`Welcome, ${user.username || 'player'}. Find a table or return to your seat.`),
        mine && onResume && h('button', {className:'club-primary', onClick:()=>onResume(mine)}, icon('arrow-rotate-left'), he?'חזרה לשולחן שלי':'Return to my table')),
      h('dl', {className:'club-lobby-facts'},
        h('div', null, h('dt', null, icon('table-cells'), he?'שולחנות במועדון':'Club tables'), h('dd', null, tables.length)),
        h('div', null, h('dt', null, icon('users'), he?'מקומות תפוסים':'Occupied seats'), h('dd', null, seats)),
        h('div', null, h('dt', null, icon('id-card'), he?'מזהה שחקן':'Player ID'), h('dd', {className:'club-player-id',dir:'ltr'}, user.playerId || '—'))));
  }

  function SettlementPlayerCards({players = [], results = {}, rakes = {}, members = {}, logs = [], period, locale = 'en', formatAmount = amount}) {
    const he = locale === 'he';
    const [selected, setSelected] = R.useState(null), [page, setPage] = R.useState(0);
    const dialog = R.useRef(null);
    const signature = players.map(p=>p.uid || p.id).join('|');
    R.useEffect(()=>setPage(0), [signature, period]);
    const current = players.find(p=>(p.uid || p.id) === selected);
    R.useEffect(()=>{if(selected && !current)setSelected(null);},[selected,current]);
    R.useEffect(()=>{
      if(!selected)return;
      const before=w.document.activeElement;
      dialog.current?.querySelector('button')?.focus();
      return()=>{if(before?.isConnected)before.focus();};
    },[selected]);
    const maxPage = Math.max(0, Math.ceil(players.length/12)-1), actualPage = Math.min(page,maxPage);
    const label = (en, heb) => he?heb:en;
    const keys = e => {
      if(e.key==='Escape'){e.stopPropagation();setSelected(null);}
      if(e.key!=='Tab')return;
      const list=[...dialog.current.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')];
      const first=list[0], last=list[list.length-1];
      if(e.shiftKey && w.document.activeElement===first){e.preventDefault();last.focus();}
      else if(!e.shiftKey && w.document.activeElement===last){e.preventDefault();first.focus();}
    };
    return h('section',{className:'settlement-cards',dir:he?'rtl':'ltr','aria-label':label('Player account cards','כרטיסי התחשבנות לשחקנים')},
      h('div',{className:'club-card-grid'},players.slice(actualPage*12,actualPage*12+12).map(p=>h('button',{
        key:p.uid || p.id, className:'club-account-card', onClick:()=>setSelected(p.uid || p.id),
        'aria-label':label('Open account for ','פתח כרטיס של ') + (p.username || p.playerId || '')
      },
        h('span',{className:'club-account-identity'},h('span',{className:'club-avatar'},icon('user')),h('span',null,h('strong',null,p.username || '—'),h('small',{dir:'ltr'},p.playerId || '—')),icon('arrow-up-right-from-square')),
        h('span',{className:'club-account-result'},h('small',null,label('Period result','תוצאת התקופה')),h('strong',{className:(results[p.uid] || 0)<0?'club-negative':'club-positive',dir:'ltr'},formatAmount(results[p.uid]))),
        h('span',{className:'club-account-numbers'},h('span',null,h('small',null,label('Current balance','יתרה נוכחית')),h('b',{dir:'ltr'},formatAmount(p.balance))),h('span',null,h('small',null,label('Period rake','רייק בתקופה')),h('b',{dir:'ltr'},formatAmount(rakes[p.uid])))),
        h('span',{className:'club-account-agent'},icon('handshake'),members[p.agentUid]?.username || label('No assigned agent','ללא סוכן משויך'))))),
      !players.length && h('p',{className:'club-empty'},label('No players match these filters.','לא נמצאו שחקנים שמתאימים לסינון.')),
      maxPage>0 && h('nav',{className:'club-pagination','aria-label':label('Player pages','עמודי שחקנים')},
        h('button',{disabled:actualPage===0,onClick:()=>setPage(actualPage-1)},label('Previous','הקודם')),
        h('span',null,`${actualPage+1} / ${maxPage+1}`),
        h('button',{disabled:actualPage===maxPage,onClick:()=>setPage(actualPage+1)},label('Next','הבא'))),
      current && w.ReactDOM.createPortal(h('div',{className:'club-account-backdrop',onClick:e=>{if(e.target===e.currentTarget)setSelected(null);}},
        h('section',{ref:dialog,className:'club-account-dialog',role:'dialog','aria-modal':true,'aria-label':label('Player account: ','כרטיס שחקן: ')+(current.username||''),dir:he?'rtl':'ltr',onKeyDown:keys},
          h('button',{className:'club-dialog-close',onClick:()=>setSelected(null)},icon('xmark'),label('Close','סגור')),
          h('span',{className:'club-eyebrow'},label('PLAYER ACCOUNT','כרטיס שחקן')),
          h('h2',null,current.username || '—'),
          h('p',null,label('Player ID: ','מזהה שחקן: '),h('bdi',null,current.playerId || '—')),
          h('dl',{className:'club-profile-facts'},
            h('div',null,h('dt',null,label('Current balance','יתרה נוכחית')),h('dd',{dir:'ltr'},formatAmount(current.balance))),
            h('div',null,h('dt',null,label('Period result','תוצאת התקופה')),h('dd',{dir:'ltr'},formatAmount(results[current.uid]))),
            h('div',null,h('dt',null,label('Agent','סוכן')),h('dd',null,members[current.agentUid]?.username || '—')),
            h('div',null,h('dt',null,label('Phone','טלפון')),h('dd',{dir:'ltr'},current.phone || '—'))),
          h('h3',null,label('Game activity · ','פעילות משחק · '),period),
          h('p',{className:'club-explainer'},label('Current balance and game results measure different things. Recent game entries below do not include deposits or withdrawals.','היתרה הנוכחית ותוצאות המשחק הן נתונים שונים. הרשומות כאן הן פעילות משחק ואינן כוללות הפקדות ומשיכות.')),
          logs.filter(e=>e.uid===current.uid).sort((a,b)=>(b.at||0)-(a.at||0)).slice(0,20).map((e,i)=>h('div',{className:'club-game-entry',key:i},
            h('span',null,e.game || e.type || label('Game','משחק'),h('small',null,new Date(e.at || 0).toLocaleString(he?'he-IL':'en-GB',{timeZone:'Asia/Jerusalem'}))),
            h('b',{className:(e.profit || 0)<0?'club-negative':'club-positive',dir:'ltr'},formatAmount(e.profit)))),
          !logs.some(e=>e.uid===current.uid) && h('p',{className:'club-empty'},label('No game activity recorded in this period.','אין פעילות משחק רשומה בתקופה הזו.')),
          h('small',null,label('Showing up to 20 recent entries for the selected period.','מוצגות עד 20 הרשומות האחרונות בתקופה שנבחרה.')))),w.document.body));
  }
  w.ClubUI={LobbyOverview,SettlementPlayerCards};
})(window);
