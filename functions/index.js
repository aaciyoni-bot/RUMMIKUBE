/**
 * Rummikube Clubs — Cloud Functions (money authority)
 *
 * Phase 2, function #1: spinDailyBonus
 * The SERVER decides the prize and moves the chips. The client only triggers
 * the spin and animates the wheel — so a player can no longer fake the prize
 * or edit their own balance through the bonus wheel.
 */
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const BONUS_COOLDOWN_MS = 22 * 3600 * 1000;          // כמו בלקוח
const BONUS_WEIGHTS = [800, 100, 35, 25, 18, 12, 5, 5];
const DEFAULT_PRIZES = [5, 10, 20, 30, 50, 75, 100, 200];
const SCR_COOLDOWN_MS = 7 * 24 * 3600 * 1000;        // גירוד שבועי
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// ── הרשאות בצד השרת (זהה ללקוח) ──────────────────────────────────────
const GOD_EMAILS = ["aaci.yoni@gmail.com", "info.bagso@gmail.com"];
const STAFF_ROLES = ["super_admin", "club_owner", "manager"];
const isGodEmail = (email) => GOD_EMAILS.includes(String(email || "").toLowerCase());
// מחזיר את מסמך החברות של הקורא בקלאב, או null. משמש לאימות תפקיד בשרת.
async function callerMem(tx, uid, clubId) {
  const snap = await tx.get(db.doc(`memberships/${uid}_${clubId}`));
  return snap.exists ? snap.data() : null;
}
function assertStaff(mem, email) {
  if (isGodEmail(email)) return;
  if (mem && STAFF_ROLES.includes(mem.role)) return;
  throw new HttpsError("permission-denied", "פעולה זו מותרת לצוות הניהול בלבד");
}

/**
 * walletAdjust — קופה מאומתת-שרת: הפקדה/משיכה בין קופת הבעלים לשחקן.
 * רק צוות (super_admin/club_owner/manager) או GOD יכול לקרוא. הסכום מעוגל
 * ומאומת, הכסף זז אטומית, והתנועה נרשמת ל-gameLog. הלקוח כבר לא "רשות הכסף".
 */
exports.walletAdjust = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {clubId, targetUid, dir} = request.data || {};
  const amount = round2(request.data && request.data.amount);
  if (!clubId || !targetUid) throw new HttpsError("invalid-argument", "חסרים פרטים");
  if (!(amount >= 0.01)) throw new HttpsError("invalid-argument", "סכום לא תקין");
  if (dir !== "in" && dir !== "out") throw new HttpsError("invalid-argument", "כיוון לא תקין");
  if (targetUid === uid) throw new HttpsError("invalid-argument", "לא ניתן להפקיד/למשוך לעצמך");

  const result = await db.runTransaction(async (tx) => {
    const mem = await callerMem(tx, uid, clubId);
    assertStaff(mem, email);
    const ownerRef = db.doc(`memberships/${uid}_${clubId}`);
    const targetRef = db.doc(`memberships/${targetUid}_${clubId}`);
    const [ownerSnap, targetSnap] = [await tx.get(ownerRef), await tx.get(targetRef)];
    if (!ownerSnap.exists || !targetSnap.exists) throw new HttpsError("not-found", "חבר לא נמצא");
    const ownerBal = Number(ownerSnap.data().balance) || 0;
    const targetBal = Number(targetSnap.data().balance) || 0;
    const deposit = dir === "in";
    if (deposit && ownerBal < amount) throw new HttpsError("failed-precondition", "אין מספיק יתרה בקופה");
    if (!deposit && targetBal < amount) throw new HttpsError("failed-precondition", "לשחקן אין מספיק יתרה");
    tx.update(ownerRef, {balance: round2(ownerBal + (deposit ? -amount : amount))});
    tx.update(targetRef, {balance: round2(targetBal + (deposit ? amount : -amount))});
    return {targetName: targetSnap.data().username || "", newTargetBal: round2(targetBal + (deposit ? amount : -amount))};
  });
  // תיעוד ליומן (מחוץ לטרנזקציה - לא קריטי לאטומיות)
  try {
    await db.collection("gameLog").add({
      uid: targetUid, username: result.targetName, game: "cashier", clubId,
      profit: dir === "in" ? amount : -amount, rake: 0, tableId: "", by: uid, at: Date.now(),
    });
  } catch (e) { /* לוג בלבד */ }
  return {ok: true, ...result};
});

// ═══════════════════════════════════════════════════════════════════════
//  רמי — מנוע כסף בצד השרת. הסטאקים נשמרים ב-tables/{id}.bank (מפה
//  {uid:number}) שרק פונקציות כותבות. players[uid].stack הוא מראה תצוגתי
//  בלבד. balance נכתב אך ורק כאן. כך אי-אפשר להמציא/לגנוב כסף מהדפדפן.
// ═══════════════════════════════════════════════════════════════════════
const DEFAULT_RAKE_PCT = 6;
const RUMMY_COLORS = ["#ef4444", "#3b82f6", "#f59e0b", "#0c1322"];
const rid = (p) => p + Math.random().toString(36).slice(2, 8);
function generateDeck() {
  const d = [];
  for (let s = 0; s < 2; s++) for (let c = 0; c < 4; c++) for (let v = 1; v <= 13; v++) d.push({id: rid(`t_${s}_${c}_${v}_`), val: v, color: RUMMY_COLORS[c]});
  d.push({id: rid("j1_"), val: "☻", color: "#ef4444"});
  d.push({id: rid("j2_"), val: "☻", color: "#0c1322"});
  return d.sort(() => Math.random() - 0.5);
}
function validateGroup(group) {
  if (!group || group.length < 3) return false;
  const jokers = group.filter((t) => t.val === "☻").length;
  const regs = group.filter((t) => t.val !== "☻");
  if (regs.length === 0) return group.length >= 3;
  if (group.length > 13) return false;
  const isSet = () => group.length <= 4 && regs.every((t) => t.val === regs[0].val) && new Set(regs.map((t) => t.color)).size === regs.length;
  const isRun = () => {
    if (!regs.every((t) => t.color === regs[0].color)) return false;
    if (new Set(regs.map((t) => Number(t.val))).size !== regs.length) return false;
    const s = [...regs].sort((a, b) => Number(a.val) - Number(b.val));
    let gaps = 0;
    for (let i = 0; i < s.length - 1; i++) gaps += (Number(s[i + 1].val) - Number(s[i].val) - 1);
    if (gaps > jokers) return false;
    const extra = jokers - gaps;
    const lo = Number(s[0].val); const hi = Number(s[s.length - 1].val);
    return (13 - hi) + (lo - 1) >= extra;
  };
  return isSet() || isRun();
}
const rackPenalty = (cards) => (cards || []).filter((c) => c).reduce((s, c) => s + (c.val === "☻" ? 30 : Number(c.val)), 0);
// חלוקת סבב: מקבל את מפת השחקנים (שומר bank/stack), מחזיר שדות שולחן חדשים
function dealFields(players, bank) {
  const d = generateDeck();
  const uids = Object.keys(players).sort();
  const np = {};
  uids.forEach((uid) => {
    const hand = d.splice(0, 14);
    while (hand.length < 28) hand.push(null);
    np[uid] = {...players[uid], cards: hand, hasDropped: false, missed: 0, stack: (bank && bank[uid]) || 0};
  });
  return {players: np, deck: d, board: [], phase: "playing", currentTurn: uids[0], turnStartedAt: Date.now(), winner: null, lastResults: null, turnSnapBoard: [], turnSnapRack: [...np[uids[0]].cards]};
}
// אימות שהקורא רשאי לגעת בשולחן: משתתף יושב, או GOD (מוח-הבוטים).
function assertParticipant(t, uid, email) {
  if (isGodEmail(email)) return;
  if (t.players && t.players[uid]) return;
  throw new HttpsError("permission-denied", "אינך משתתף בשולחן זה");
}

// ── כניסה לשולחן: גובה מהיתרה, מקצה bank, ומחלק כשמתמלא ──────────────
exports.rummyBuyIn = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId} = request.data || {};
  if (!tableId) throw new HttpsError("invalid-argument", "חסר שולחן");
  const becameFull = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) throw new HttpsError("not-found", "השולחן לא קיים");
    const t = tSnap.data();
    if (t.type !== "rummikub") throw new HttpsError("failed-precondition", "שולחן לא נתמך");
    if (t.phase !== "waiting") throw new HttpsError("failed-precondition", "המשחק כבר התחיל");
    if (t.players && t.players[uid]) throw new HttpsError("failed-precondition", "אתה כבר יושב בשולחן זה");
    const max = Number(t.maxPlayers) || 0;
    if (Object.keys(t.players || {}).length >= max) throw new HttpsError("failed-precondition", "השולחן מלא");
    const memRef = db.doc(`memberships/${uid}_${t.clubId}`);
    const memSnap = await tx.get(memRef);
    if (!memSnap.exists) throw new HttpsError("failed-precondition", "אינך חבר בקלאב הזה");
    const m = memSnap.data();
    const bal = Number(m.balance) || 0;
    const buyIn = round2(Number(t.minBuyIn) || 0);
    if (bal < buyIn) throw new HttpsError("failed-precondition", "אין לך מספיק יתרה לכניסה");
    const players = {...(t.players || {}), [uid]: {username: m.username || "", photo: m.photo || "", avatarSeed: m.avatarSeed || "", cards: [], hasDropped: false, missed: 0, stack: buyIn, isBot: false}};
    const bank = {...(t.bank || {}), [uid]: buyIn};
    tx.update(memRef, {balance: round2(bal - buyIn)});
    if (Object.keys(players).length === max) {
      tx.update(tRef, {...dealFields(players, bank), bank});
      return true;
    }
    tx.update(tRef, {players, bank});
    return false;
  });
  return {ok: true, becameFull};
});

// ── סיום משחק: השרת מחשב עונשין/קופה/רייק/נתחי-סוכן ומזיז את הכסף ─────
exports.rummySettle = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId, winnerUid, finalBoard} = request.data || {};
  if (!tableId || !winnerUid) throw new HttpsError("invalid-argument", "חסרים פרטים");
  const board = Array.isArray(finalBoard) ? finalBoard : [];
  // הלוח המנצח חייב להיות חוקי - חוסם סגירה עם לוח זבל
  for (const g of board) {
    if (!g || !Array.isArray(g.tiles) || !validateGroup(g.tiles)) {
      throw new HttpsError("failed-precondition", "הלוח לא תקין");
    }
  }
  const out = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) throw new HttpsError("not-found", "השולחן לא קיים");
    const t = tSnap.data();
    if (t.phase !== "playing") throw new HttpsError("failed-precondition", "כבר הסתיים");
    if (!t.players || !t.players[winnerUid]) throw new HttpsError("failed-precondition", "המנצח עזב");
    assertParticipant(t, uid, email);
    const clubId = t.clubId;
    const stakes = Number(t.stakes) || 0.1;
    const bank = {...(t.bank || {})};
    // --- כל הקריאות לפני כל הכתיבות ---
    const clubSnap = await tx.get(db.doc(`clubs/${clubId}`));
    const club = clubSnap.exists ? clubSnap.data() : {};
    const ownerUid = club.ownerUid || "";
    const rakeFrac = (Number(club.rakePct) || DEFAULT_RAKE_PCT) / 100;
    const players = JSON.parse(JSON.stringify(t.players));
    // קריאת חברויות של כל השחקנים האמיתיים (לסטטיסטיקה + שיוך-סוכן)
    const memRefs = {}; const memData = {};
    for (const [u, p] of Object.entries(players)) {
      if (p.isBot) continue;
      memRefs[u] = db.doc(`memberships/${u}_${clubId}`);
      const s = await tx.get(memRefs[u]);
      memData[u] = s.exists ? s.data() : null;
    }
    const ownerRef = ownerUid ? db.doc(`memberships/${ownerUid}_${clubId}`) : null;
    const ownerData = ownerRef ? (memData[ownerUid] || (await tx.get(ownerRef)).data()) : null;
    const bankRef = db.doc(`memberships/bot_bank_${clubId}`);
    const bankSnap = await tx.get(bankRef);
    // חברויות סוכנים שאליהם משויכים שחקנים
    const agentRefs = {}; const agentData = {};
    for (const [u, d] of Object.entries(memData)) {
      if (d && d.agentUid && Number(d.agentPct) > 0 && d.agentUid !== u && !agentRefs[d.agentUid]) {
        agentRefs[d.agentUid] = db.doc(`memberships/${d.agentUid}_${clubId}`);
        const s = await tx.get(agentRefs[d.agentUid]);
        agentData[d.agentUid] = s.exists ? s.data() : null;
      }
    }

    // --- חישוב ---
    players[winnerUid].cards = [];
    let totalPot = 0; const details = {};
    for (const [u, p] of Object.entries(players)) {
      if (u === winnerUid) continue;
      const penalty = rackPenalty(p.cards);
      const pay = Math.min(round2(penalty * stakes), bank[u] || 0);
      bank[u] = round2((bank[u] || 0) - pay);
      players[u].stack = bank[u];
      totalPot = round2(totalPot + pay);
      details[u] = {username: p.username, penalty, pay};
    }
    const rake = round2(totalPot * rakeFrac);
    const winnerProfit = round2(totalPot - rake);
    bank[winnerUid] = round2((bank[winnerUid] || 0) + winnerProfit);
    players[winnerUid].stack = bank[winnerUid];
    // קופת הבוטים: סופגת תוצאה נטו של כל בוט
    let botDelta = 0;
    for (const [duid, d] of Object.entries(details)) if (players[duid] && players[duid].isBot) botDelta = round2(botDelta - d.pay);
    if (players[winnerUid].isBot) botDelta = round2(botDelta + winnerProfit);
    // נתחי סוכן: מתוך הרייק, חלק שווה לכל שחקן אמיתי, לפי אחוז הסוכן שלו
    const realPlayers = Object.keys(players).filter((u) => !players[u].isBot);
    const cutShare = realPlayers.length ? rake / realPlayers.length : 0;
    const agentCuts = {}; let totalCuts = 0;
    for (const u of realPlayers) {
      const d = memData[u];
      if (d && d.agentUid && d.agentUid !== u) {
        const pct = Math.min(100, Math.max(0, Number(d.agentPct) || 0));
        const cut = round2(cutShare * pct / 100);
        if (cut > 0 && agentData[d.agentUid]) { agentCuts[d.agentUid] = round2((agentCuts[d.agentUid] || 0) + cut); totalCuts = round2(totalCuts + cut); }
      }
    }

    // --- כתיבות ---
    tx.update(tRef, {players, bank, phase: "showdown", winner: winnerUid, currentTurn: null,
      lastResults: {winnerName: players[winnerUid].username, totalPot, rake, winnerProfit, details, endedAt: Date.now()}});
    if (bankSnap.exists && botDelta !== 0) tx.update(bankRef, {balance: round2((Number(bankSnap.data().balance) || 0) + botDelta)});
    // סטטיסטיקה לכל שחקן אמיתי
    for (const [u, d] of Object.entries(memData)) {
      if (!d) continue;
      const st = d.stats || {gamesPlayed: 0, gamesWon: 0, totalProfit: 0};
      const isW = u === winnerUid;
      const delta = isW ? winnerProfit : -((details[u] && details[u].pay) || 0);
      const upd = {"stats.gamesPlayed": (st.gamesPlayed || 0) + 1, "stats.gamesWon": (st.gamesWon || 0) + (isW ? 1 : 0), "stats.totalProfit": round2((st.totalProfit || 0) + delta)};
      tx.update(memRefs[u], upd);
    }
    // רייק לבעלים (בניכוי נתחי הסוכנים), ונתחי-סוכן
    if (ownerRef && ownerData) {
      tx.update(ownerRef, {balance: round2((Number(ownerData.balance) || 0) + rake - totalCuts), clubProfits: round2((Number(ownerData.clubProfits) || 0) + rake)});
    }
    for (const [aUid, amt] of Object.entries(agentCuts)) {
      const ad = agentData[aUid];
      if (ad) tx.update(agentRefs[aUid], {balance: round2((Number(ad.balance) || 0) + amt), agentProfits: round2((Number(ad.agentProfits) || 0) + amt)});
    }
    return {rake, winnerProfit, totalCuts, details, agentCuts, winnerName: players[winnerUid].username, winnerIsBot: !!players[winnerUid].isBot, clubId};
  });
  // יומנים (מחוץ לטרנזקציה)
  try {
    const rows = [];
    if (!out.winnerIsBot) rows.push({uid: winnerUid, username: out.winnerName, game: "rummikub", profit: out.winnerProfit, rake: out.rake});
    for (const [duid, d] of Object.entries(out.details)) rows.push({uid: duid, username: d.username, game: "rummikub", profit: -d.pay});
    for (const r of rows) {
      if (!r.uid) continue;
      await db.collection("gameLog").add({uid: r.uid, username: r.username || "", game: r.game, clubId: out.clubId, profit: round2(r.profit || 0), rake: round2(r.rake || 0), tableId, at: Date.now()});
    }
    if (out.rake > 0) await db.collection("agentLog").add({clubId: out.clubId, agentUid: "club", kind: "club", amount: round2(out.rake), at: Date.now()});
    for (const [aUid, amt] of Object.entries(out.agentCuts)) await db.collection("agentLog").add({agentUid: aUid, clubId: out.clubId, amount: round2(amt), at: Date.now()});
  } catch (e) { /* לוג בלבד */ }
  return {ok: true};
});

// חלוקה שווה עם שמירת אגורות: השארית לאחרון. מחזיר {perUid, botDelta}
function conserveSplit(amount, uids, isBotMap) {
  const share = round2(amount / uids.length);
  let left = amount; let botDelta = 0; const per = {};
  uids.forEach((u, i) => {
    const amt = (i === uids.length - 1) ? round2(left) : share;
    per[u] = amt; if (isBotMap[u]) botDelta = round2(botDelta + amt);
    left = round2(left - amt);
  });
  return {per, botDelta};
}

// ── הרחקת שחקן אנושי שפספס 2 תורות: הצ'יפים שלו עוברים לנשארים ─────────
exports.rummyKick = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId, kickUid} = request.data || {};
  if (!tableId || !kickUid) throw new HttpsError("invalid-argument", "חסרים פרטים");
  const out = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) return null;
    const t = tSnap.data();
    if (t.phase !== "playing" || !t.players || !t.players[kickUid]) return null;
    assertParticipant(t, uid, email);
    const kicked = t.players[kickUid];
    if (kicked.isBot) throw new HttpsError("failed-precondition", "בוט לא מוסר על היעדרות");
    if ((kicked.missed || 0) < 1) return null; // כבר טופל
    if (t.tournamentId) return null; // טורניר מטופל אחרת
    const clubId = t.clubId;
    const bank = {...(t.bank || {})};
    const stack = round2(bank[kickUid] || 0);
    const newP = {...t.players}; delete newP[kickUid];
    delete bank[kickUid];
    const rest = Object.keys(newP);
    if (!rest.length) { tx.update(tRef, {players: newP, bank, phase: "showdown", currentTurn: null}); return null; }
    const lastMan = rest.length === 1;
    const isBotMap = {}; rest.forEach((u) => isBotMap[u] = !!newP[u].isBot);
    // reads
    const clubSnap = await tx.get(db.doc(`clubs/${clubId}`));
    const club = clubSnap.exists ? clubSnap.data() : {};
    const ownerUid = club.ownerUid || "";
    const rakeFrac = (Number(club.rakePct) || DEFAULT_RAKE_PCT) / 100;
    const kickedMemRef = db.doc(`memberships/${kickUid}_${clubId}`);
    const kickedMem = (await tx.get(kickedMemRef)).data();
    const bankRef = db.doc(`memberships/bot_bank_${clubId}`);
    const bankSnap = await tx.get(bankRef);
    let winMemRef = null; let winMem = null; let ownRef = null; let ownMem = null;
    if (lastMan && !newP[rest[0]].isBot) { winMemRef = db.doc(`memberships/${rest[0]}_${clubId}`); winMem = (await tx.get(winMemRef)).data(); }
    if (lastMan && ownerUid) { ownRef = db.doc(`memberships/${ownerUid}_${clubId}`); ownMem = (await tx.get(ownRef)).data(); }

    let botDelta = 0; let rake = 0; let winnerProfit = 0; const upd = {players: newP};
    if (lastMan) {
      const winUid = rest[0];
      rake = round2(stack * rakeFrac);
      winnerProfit = round2(stack - rake);
      bank[winUid] = round2((bank[winUid] || 0) + winnerProfit);
      newP[winUid].stack = bank[winUid];
      if (newP[winUid].isBot) botDelta = round2(botDelta + winnerProfit);
      upd.phase = "showdown"; upd.winner = winUid; upd.currentTurn = null;
      upd.lastResults = {winnerName: newP[winUid].username, totalPot: stack, rake, winnerProfit, details: {[kickUid]: {username: kicked.username, penalty: 0, pay: stack}}, endedAt: Date.now(), absent: kicked.username};
      if (winMemRef && winMem) { const ws = winMem.stats || {}; tx.update(winMemRef, {"stats.gamesPlayed": (ws.gamesPlayed || 0) + 1, "stats.gamesWon": (ws.gamesWon || 0) + 1, "stats.totalProfit": round2((ws.totalProfit || 0) + winnerProfit)}); }
      if (ownRef && ownMem) tx.update(ownRef, {balance: round2((Number(ownMem.balance) || 0) + rake), clubProfits: round2((Number(ownMem.clubProfits) || 0) + rake)});
    } else {
      const sp = conserveSplit(stack, rest, isBotMap);
      rest.forEach((u) => { bank[u] = round2((bank[u] || 0) + sp.per[u]); newP[u].stack = bank[u]; });
      botDelta = sp.botDelta;
      if (t.currentTurn === kickUid) { const s = [...rest].sort(); upd.currentTurn = s[0]; upd.turnStartedAt = Date.now(); upd.turnSnapBoard = t.board || []; upd.turnSnapRack = [...((newP[s[0]] || {}).cards || [])]; }
    }
    upd.bank = bank;
    if (kickedMem) { const ks = kickedMem.stats || {}; tx.update(kickedMemRef, {"stats.gamesPlayed": (ks.gamesPlayed || 0) + 1, "stats.totalProfit": round2((ks.totalProfit || 0) - stack)}); }
    if (bankSnap.exists && botDelta !== 0) tx.update(bankRef, {balance: round2((Number(bankSnap.data().balance) || 0) + botDelta)});
    tx.update(tRef, upd);
    return {clubId, kicked: kicked.username, stack, lastMan, winUid: lastMan ? rest[0] : null, winName: lastMan ? newP[rest[0]].username : null, winnerProfit, rake, winnerIsBot: lastMan ? !!newP[rest[0]].isBot : false, kickedIsBot: false};
  });
  try {
    if (out) {
      const rows = [{uid: kickUid, username: out.kicked, game: "rummikub", profit: -out.stack}];
      if (out.lastMan && !out.winnerIsBot) rows.push({uid: out.winUid, username: out.winName, game: "rummikub", profit: out.winnerProfit, rake: out.rake});
      for (const r of rows) await db.collection("gameLog").add({uid: r.uid, username: r.username || "", game: "rummikub", clubId: out.clubId, profit: round2(r.profit || 0), rake: round2(r.rake || 0), tableId, at: Date.now()});
      if (out.rake > 0) await db.collection("agentLog").add({clubId: out.clubId, agentUid: "club", kind: "club", amount: round2(out.rake), at: Date.now()});
    }
  } catch (e) { /* לוג בלבד */ }
  return {ok: true};
});

// ── עזיבת שולחן: פדיון bank->balance (המתנה) או כניעה (חלוקת bank) ─────
exports.rummyLeave = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId} = request.data || {};
  if (!tableId) throw new HttpsError("invalid-argument", "חסר שולחן");
  const out = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) return {gone: true};
    const t = tSnap.data();
    if (!t.players || !t.players[uid]) return {gone: true};
    if (t.tournamentId) { // טורניר: הסרה בלבד, בלי כסף
      const pl = {...t.players}; delete pl[uid]; const rest = Object.keys(pl); const upd = {players: pl};
      if (rest.length === 1 && t.phase === "playing") { upd.phase = "showdown"; upd.winner = rest[0]; }
      else if (t.currentTurn === uid && rest.length) { const s = [...rest].sort(); upd.currentTurn = s[0]; upd.turnStartedAt = Date.now(); }
      tx.update(tRef, upd); return {gone: true};
    }
    const clubId = t.clubId;
    const bank = {...(t.bank || {})};
    const playing = t.phase === "playing";
    const myStack = round2(bank[uid] || 0);
    const memRef = db.doc(`memberships/${uid}_${clubId}`);
    const memSnap = await tx.get(memRef);
    const mem = memSnap.exists ? memSnap.data() : {};
    const newP = {...t.players}; delete newP[uid]; delete bank[uid];
    const rest = Object.keys(newP);

    if (!playing) { // המתנה: הצ'יפים חוזרים לארנק
      tx.update(memRef, {balance: round2((Number(mem.balance) || 0) + myStack)});
      tx.update(tRef, {players: newP, bank});
      return {cashout: true, clubId, myStack};
    }
    // כניעה באמצע: הצ'יפים מתחלקים בין הנשארים
    const lastMan = rest.length === 1;
    const isBotMap = {}; rest.forEach((u) => isBotMap[u] = !!newP[u].isBot);
    const clubSnap = await tx.get(db.doc(`clubs/${clubId}`));
    const club = clubSnap.exists ? clubSnap.data() : {};
    const ownerUid = club.ownerUid || "";
    const rakeFrac = (Number(club.rakePct) || DEFAULT_RAKE_PCT) / 100;
    const bankRef = db.doc(`memberships/bot_bank_${clubId}`);
    const bankSnap = await tx.get(bankRef);
    let winMemRef = null; let winMem = null; let ownRef = null; let ownMem = null;
    if (lastMan && rest.length && !newP[rest[0]].isBot) { winMemRef = db.doc(`memberships/${rest[0]}_${clubId}`); winMem = (await tx.get(winMemRef)).data(); }
    if (lastMan && ownerUid) { ownRef = db.doc(`memberships/${ownerUid}_${clubId}`); ownMem = (await tx.get(ownRef)).data(); }

    const upd = {players: newP}; let botDelta = 0; let rake = 0; let winnerProfit = 0;
    tx.update(memRef, {"stats.gamesPlayed": ((mem.stats || {}).gamesPlayed || 0) + 1, "stats.totalProfit": round2(((mem.stats || {}).totalProfit || 0) - myStack)});
    if (lastMan) {
      const winUid = rest[0];
      rake = round2(myStack * rakeFrac); winnerProfit = round2(myStack - rake);
      bank[winUid] = round2((bank[winUid] || 0) + winnerProfit); newP[winUid].stack = bank[winUid];
      if (newP[winUid].isBot) botDelta = round2(botDelta + winnerProfit);
      upd.phase = "showdown"; upd.winner = winUid; upd.currentTurn = null;
      upd.lastResults = {winnerName: newP[winUid].username, totalPot: myStack, rake, winnerProfit, details: {[uid]: {username: mem.username || "", penalty: 0, pay: myStack}}, endedAt: Date.now()};
      if (winMemRef && winMem) { const ws = winMem.stats || {}; tx.update(winMemRef, {"stats.gamesPlayed": (ws.gamesPlayed || 0) + 1, "stats.gamesWon": (ws.gamesWon || 0) + 1, "stats.totalProfit": round2((ws.totalProfit || 0) + winnerProfit)}); }
      if (ownRef && ownMem) tx.update(ownRef, {balance: round2((Number(ownMem.balance) || 0) + rake), clubProfits: round2((Number(ownMem.clubProfits) || 0) + rake)});
    } else if (rest.length >= 2) {
      const sp = conserveSplit(myStack, rest, isBotMap);
      rest.forEach((u) => { bank[u] = round2((bank[u] || 0) + sp.per[u]); newP[u].stack = bank[u]; });
      botDelta = sp.botDelta;
      if (t.currentTurn === uid) { const s = [...rest].sort(); upd.currentTurn = s[0]; upd.turnStartedAt = Date.now(); }
    }
    upd.bank = bank;
    if (bankSnap.exists && botDelta !== 0) tx.update(bankRef, {balance: round2((Number(bankSnap.data().balance) || 0) + botDelta)});
    tx.update(tRef, upd);
    return {surrender: true, clubId, myStack, username: mem.username || ""};
  });
  try {
    if (out && out.surrender) await db.collection("gameLog").add({uid, username: out.username, game: "rummikub", clubId: out.clubId, profit: -round2(out.myStack), rake: 0, tableId, at: Date.now()});
  } catch (e) { /* לוג בלבד */ }
  return {ok: true, ...out};
});

// ── סיבוב חדש: מחלק מחדש רק לשחקנים עם צ'יפים ─────────────────────────
exports.rummyNewRound = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId} = request.data || {};
  if (!tableId) throw new HttpsError("invalid-argument", "חסר שולחן");
  await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) throw new HttpsError("not-found", "השולחן לא קיים");
    const t = tSnap.data();
    if (t.phase !== "showdown") throw new HttpsError("failed-precondition", "אין סיבוב לפתוח");
    assertParticipant(t, uid, email);
    const bank = t.bank || {};
    const eligible = {}; const eBank = {};
    for (const [u, p] of Object.entries(t.players || {})) if ((bank[u] || 0) > 0) { eligible[u] = p; eBank[u] = round2(bank[u]); }
    if (Object.keys(eligible).length < 2) throw new HttpsError("failed-precondition", "אין מספיק שחקנים עם צ'יפים");
    tx.update(tRef, {...dealFields(eligible, eBank), bank: eBank});
  });
  return {ok: true};
});

// תחילת המחזור השבועי (יום שני 00:01 שעון ישראל) - זהה ללקוח
function cycleStartIL() {
  const now = new Date();
  const il = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Jerusalem"}));
  const back = (il.getDay() + 6) % 7;
  const monday = new Date(il);
  monday.setDate(il.getDate() - back);
  monday.setHours(0, 1, 0, 0);
  return Math.round((monday.getTime() + (now.getTime() - il.getTime())) / 60000) * 60000;
}

exports.spinDailyBonus = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const clubId = request.data && request.data.clubId;
  if (!clubId) throw new HttpsError("invalid-argument", "חסר מזהה קלאב");

  const memRef = db.doc(`memberships/${uid}_${clubId}`);
  const clubRef = db.doc(`clubs/${clubId}`);

  return await db.runTransaction(async (tx) => {
    // --- כל הקריאות לפני כל הכתיבות ---
    const memSnap = await tx.get(memRef);
    if (!memSnap.exists) throw new HttpsError("permission-denied", "אינך חבר בקלאב הזה");
    const mem = memSnap.data();

    const clubSnap = await tx.get(clubRef);
    const club = clubSnap.exists ? clubSnap.data() : {};
    const bw = club.bonusWheel || {};
    if (bw.enabled === false) throw new HttpsError("failed-precondition", "גלגל הבונוס כבוי");

    const now = Date.now();
    const last = Number(mem.lastBonusAt) || 0;
    if (now - last < BONUS_COOLDOWN_MS) {
      const hrs = Math.ceil((BONUS_COOLDOWN_MS - (now - last)) / 3600000);
      throw new HttpsError("failed-precondition", `הבונוס הבא בעוד ${hrs} שעות`);
    }

    // הגרלה משוקללת — בצד השרת, לא ניתן לזיוף.
    // תקרת ביטחון: גם אם מסמך הקלאב נכתב עם פרסים ענקיים, השרת חוסם ל-500
    // (הגנת עומק - חוקי ה-Firestore כבר מגבילים כתיבת clubs לבעלים בלבד).
    const PRIZE_CAP = 500;
    const prizes = (Array.isArray(bw.prizes) && bw.prizes.length === 8) ?
      bw.prizes.map((x) => Math.min(Math.max(0, Number(x) || 0), PRIZE_CAP)) : DEFAULT_PRIZES;
    const total = BONUS_WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < BONUS_WEIGHTS.length; i++) {
      r -= BONUS_WEIGHTS[i];
      if (r <= 0) { idx = i; break; }
    }
    const prize = prizes[idx];

    const ownerUid = club.ownerUid || "";
    if (ownerUid && ownerUid !== uid) {
      // שימור צ'יפים: הפרס עובר מקופת בעל הקלאב לשחקן
      const ownRef = db.doc(`memberships/${ownerUid}_${clubId}`);
      const ownSnap = await tx.get(ownRef);
      const ownBal = ownSnap.exists ? (Number(ownSnap.data().balance) || 0) : 0;
      if (!ownSnap.exists || ownBal < prize) {
        throw new HttpsError("resource-exhausted", "קופת הקלאב ריקה כרגע - נסה מאוחר יותר");
      }
      tx.update(ownRef, {
        balance: round2(ownBal - prize),
        bonusPaid: round2((Number(ownSnap.data().bonusPaid) || 0) + prize),
      });
      tx.update(memRef, {
        balance: round2((Number(mem.balance) || 0) + prize),
        lastBonusAt: now,
      });
      return {prize, idx, fromBank: true};
    }

    // הבעלים מסובב על עצמו — הכסף נשאר בקופה שלו, רק מעדכנים זמן
    tx.update(memRef, {lastBonusAt: now});
    return {prize, idx, fromBank: false};
  });
});

/**
 * Phase 2, function #2: claimWeeklyScratch
 * גירוד שבועי — השרת מגריל את הפרס, אוכף את מגבלת הפרסים הגדולים (400/200 פעם
 * בשבוע לכל הקלאב) ומזיז את הצ'יפים. הלקוח רק בונה את הרשת הוויזואלית.
 */
exports.claimWeeklyScratch = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const clubId = request.data && request.data.clubId;
  if (!clubId) throw new HttpsError("invalid-argument", "חסר מזהה קלאב");

  const memRef = db.doc(`memberships/${uid}_${clubId}`);
  const clubRef = db.doc(`clubs/${clubId}`);

  return await db.runTransaction(async (tx) => {
    const memSnap = await tx.get(memRef);
    if (!memSnap.exists) throw new HttpsError("permission-denied", "אינך חבר בקלאב הזה");
    const mem = memSnap.data();

    const clubSnap = await tx.get(clubRef);
    const club = clubSnap.exists ? clubSnap.data() : {};
    const bw = club.bonusWheel || {};
    if (bw.enabled === false) throw new HttpsError("failed-precondition", "התכונה כבויה");

    const now = Date.now();
    const lastS = Number(mem.lastScratchAt) || 0;
    if (now - lastS < SCR_COOLDOWN_MS) throw new HttpsError("failed-precondition", "כבר גירדת השבוע");

    // מעקב מגבלת פרסים לפי מחזור שבועי (זהה ללקוח)
    const cycleKey = String(cycleStartIL());
    let sc = club.scratch || {};
    if (sc.key !== cycleKey) sc = {key: cycleKey, won400: false, won200: false};

    const r = Math.random() * 1000;
    let prize;
    if (r < 800) prize = 10;
    else if (r < 950) prize = 15;
    else if (r < 955) prize = !sc.won400 ? 400 : 10;
    else if (r < 965) prize = !sc.won200 ? 200 : 10;
    else prize = 10;
    if (prize === 400) sc = {...sc, won400: true};
    if (prize === 200) sc = {...sc, won200: true};

    const ownerUid = club.ownerUid || "";
    if (ownerUid && ownerUid !== uid) {
      const ownRef = db.doc(`memberships/${ownerUid}_${clubId}`);
      const ownSnap = await tx.get(ownRef);
      const ownBal = ownSnap.exists ? (Number(ownSnap.data().balance) || 0) : 0;
      if (!ownSnap.exists || ownBal < prize) {
        throw new HttpsError("resource-exhausted", "קופת הקלאב ריקה כרגע - נסה מאוחר יותר");
      }
      tx.update(ownRef, {
        balance: round2(ownBal - prize),
        bonusPaid: round2((Number(ownSnap.data().bonusPaid) || 0) + prize),
      });
      tx.update(memRef, {
        balance: round2((Number(mem.balance) || 0) + prize),
        lastScratchAt: now,
      });
      tx.update(clubRef, {scratch: sc});
      return {prize, fromBank: true};
    }

    tx.update(memRef, {lastScratchAt: now});
    tx.update(clubRef, {scratch: sc});
    return {prize, fromBank: false};
  });
});
