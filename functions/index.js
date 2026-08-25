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
    const nums = regs.map((t) => Number(t.val));
    // "1" יכול לשמש כנמוך (1-2-3) או כגבוה (12-13-1) — בלי גלישה (13-1-2 פסול)
    const tryRun = (vals) => {
      if (new Set(vals).size !== vals.length) return false;
      const s = [...vals].sort((a, b) => a - b);
      let gaps = 0;
      for (let i = 0; i < s.length - 1; i++) gaps += (s[i + 1] - s[i] - 1);
      if (gaps > jokers) return false;
      const extra = jokers - gaps;
      return (14 - s[s.length - 1]) + (s[0] - 1) >= extra; // 14 = "1" כגבוה
    };
    if (tryRun(nums)) return true;
    if (nums.filter((v) => v === 1).length === 1 && tryRun(nums.map((v) => v === 1 ? 14 : v))) return true;
    return false;
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
    // אנטי-רמאות: מנצח חייב באמת "לרדת" — כל אבני-היד השמורות בשרת שלו חייבות להיות
    // מונחות על הלוח שהוגש. אחרת שחקן מפסיד יכול לקרוא ל-rummySettle עם winnerUid=עצמו
    // ולוח-דמה קטן, בעודו מחזיק יד מלאה, ולגזול את הקופה. יד לגיטימית: 0 חסרות.
    // סף 3 מונע דחייה-שגויה בגלל ג'וקר בודד שקיבל מזהה חדש.
    {
      const wRack = (((t.players[winnerUid] || {}).cards) || []).filter(Boolean);
      const placedIds = new Set();
      for (const g of (board || [])) for (const tl of ((g && g.tiles) || [])) if (tl && tl.id != null) placedIds.add(tl.id);
      const notPlaced = wRack.filter((tl) => tl && tl.id != null && !placedIds.has(tl.id)).length;
      if (notPlaced >= 3) throw new HttpsError("failed-precondition", "המנצח לא ירד — היד אינה מונחת על הלוח");
    }
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

// ═══════════════════════════════════════════════════════════════════════
//  רמי סגור (Rami / Okey-style) — רשות הכסף בשרת
//  יד פרטית של 14 אבנים, משיכה מהקופה או מהזרוק, ירידה בבת-אחת כשהיד שלמה.
//  מפסיד משלם לפי ערך האבנים שלא הצליח לסדר בקומבינציות (leftover) × ערך-נקודה.
// ═══════════════════════════════════════════════════════════════════════
const RAMI_FRESH_CAP = 8;      // תקרת מכפיל "פריש" — חוסם ניפוח כסף
const tileValR = (t) => (t.val === "☻" ? 30 : Number(t.val));

// פותר-החלוקה: מחלק יד לקומבינציות תקינות זרות שממקסמות כיסוי (מזעור leftover).
// מוחזר {leftoverPoints, complete}. זהה למנוע-הלקוח (נבדק ביחידה).
function ramiBestPartition(hand) {
  const tiles = (hand || []).filter(Boolean).slice().sort((a, b) => {
    const ja = a.val === "☻" ? 1 : 0; const jb = b.val === "☻" ? 1 : 0;
    if (ja !== jb) return ja - jb;
    if (ja) return 0;
    return Number(a.val) - Number(b.val) || RUMMY_COLORS.indexOf(a.color) - RUMMY_COLORS.indexOf(b.color);
  });
  const keyOf = (arr) => arr.map((t) => t.val === "☻" ? "J" : `${t.val}.${t.color}`).sort().join("|");
  const memo = new Map();
  function candidatesForAnchor(arr) {
    const out = []; const a = arr[0]; const jokerIdx = [];
    for (let i = 1; i < arr.length; i++) if (arr[i].val === "☻") jokerIdx.push(i);
    const J = jokerIdx.length;
    if (a.val === "☻") {
      if (arr.filter((t) => t.val === "☻").length >= 3) {
        const jall = []; for (let i = 0; i < arr.length; i++) if (arr[i].val === "☻") jall.push(i);
        for (let s = 3; s <= jall.length; s++) out.push(jall.slice(0, s));
      }
      return out;
    }
    const v = Number(a.val); const c = a.color;
    const sameVal = []; const seen = new Set([c]);
    for (let i = 1; i < arr.length; i++) { const t = arr[i]; if (t.val !== "☻" && Number(t.val) === v && !seen.has(t.color)) { sameVal.push(i); seen.add(t.color); } }
    for (let k = 0; k <= sameVal.length; k++) for (let j = 0; j <= J; j++) {
      const size = 1 + k + j; if (size < 3 || size > 4) continue;
      const idx = [0, ...sameVal.slice(0, k), ...jokerIdx.slice(0, j)];
      if (validateGroup(idx.map((i) => arr[i]))) out.push(idx);
    }
    const byVal = new Map();
    for (let i = 1; i < arr.length; i++) { const t = arr[i]; if (t.val !== "☻" && t.color === c) { const vv = Number(t.val); if (!byVal.has(vv)) byVal.set(vv, i); } }
    for (let lo = 1; lo <= v; lo++) for (let hi = v; hi <= 13; hi++) {
      const len = hi - lo + 1; if (len < 3 || len > 13) continue;
      let missing = 0; const idx = [0];
      for (let val = lo; val <= hi; val++) { if (val === v) continue; if (byVal.has(val)) idx.push(byVal.get(val)); else missing++; }
      if (missing > J) continue;
      for (let j = 0; j < missing; j++) idx.push(jokerIdx[j]);
      const meld = idx.map((i) => arr[i]);
      if (meld.length >= 3 && validateGroup(meld)) out.push(idx.slice());
    }
    // "1" כגבוה: רצפים כמו 12-13-1 (האבן 1 בקצה העליון)
    if (v === 1) {
      for (let lo = 2; lo <= 12; lo++) {
        const len = (13 - lo + 1) + 1; if (len < 3 || len > 13) continue;
        let missing = 0; const idx = [0];
        for (let val = lo; val <= 13; val++) { if (byVal.has(val)) idx.push(byVal.get(val)); else missing++; }
        if (missing > J) continue;
        for (let j = 0; j < missing; j++) idx.push(jokerIdx[j]);
        const meld = idx.map((i) => arr[i]);
        if (meld.length >= 3 && validateGroup(meld)) out.push(idx.slice());
      }
    }
    return out;
  }
  function solve(arr) {
    if (arr.length === 0) return {pts: 0};
    const key = keyOf(arr); if (memo.has(key)) return memo.get(key);
    let best = {pts: solve(arr.slice(1)).pts + tileValR(arr[0])};
    for (const idxSet of candidatesForAnchor(arr)) {
      const used = new Set(idxSet);
      const sub = solve(arr.filter((_, i) => !used.has(i)));
      if (sub.pts < best.pts) best = {pts: sub.pts};
      if (best.pts === 0) break;
    }
    memo.set(key, best); return best;
  }
  const pts = solve(tiles).pts;
  return {leftoverPoints: pts, complete: pts === 0 && tiles.length > 0};
}

// חלוקת סבב רמי: 14 אבנים לכל אחד, אבן אחת נפתחת לערימת-הזריקה.
function ramiDeal(players, bank, timeBank, timeBankUses) {
  const d = generateDeck();
  const uids = Object.keys(players).sort();
  const np = {};
  uids.forEach((uid) => { np[uid] = {...players[uid], cards: d.splice(0, 14), missed: 0, stack: (bank && bank[uid]) || 0, tb: Math.max(0, Number(timeBank) || 0), tbUses: Math.max(0, Number(timeBankUses) || 0), tbBonus: 0, tbBonusAt: 0}; });
  const discard = [d.pop()];
  return {players: np, deck: d, discard, phase: "playing", currentTurn: uids[0], turnPhase: "draw", drawnThisTurn: false, turnStartedAt: Date.now(), winner: null, lastResults: null, freshMult: 1, freshReq: null};
}

// נתח-סוכן + רייק מתוך סכום נתון (משמש גם לעמלה-קבועה בכניסה). מזיז כסף בתוך tx.
async function ramiPayHouse(tx, clubId, sitterMem, feeAmount) {
  const fee = round2(feeAmount);
  if (!(fee > 0)) return {agentCut: 0};
  const clubSnap = await tx.get(db.doc(`clubs/${clubId}`));
  const club = clubSnap.exists ? clubSnap.data() : {};
  const ownerUid = club.ownerUid || "";
  let agentCut = 0; let agentRef = null; let agentMem = null;
  if (sitterMem && sitterMem.agentUid && Number(sitterMem.agentPct) > 0 && sitterMem.agentUid !== sitterMem.uid) {
    agentRef = db.doc(`memberships/${sitterMem.agentUid}_${clubId}`);
    const s = await tx.get(agentRef); agentMem = s.exists ? s.data() : null;
    if (agentMem) agentCut = round2(fee * Math.min(100, Math.max(0, Number(sitterMem.agentPct))) / 100);
  }
  const ownerRef = ownerUid ? db.doc(`memberships/${ownerUid}_${clubId}`) : null;
  const ownerMem = ownerRef ? (await tx.get(ownerRef)).data() : null;
  if (ownerRef && ownerMem) tx.update(ownerRef, {balance: round2((Number(ownerMem.balance) || 0) + fee - agentCut), clubProfits: round2((Number(ownerMem.clubProfits) || 0) + fee)});
  if (agentRef && agentMem && agentCut > 0) tx.update(agentRef, {balance: round2((Number(agentMem.balance) || 0) + agentCut), agentProfits: round2((Number(agentMem.agentProfits) || 0) + agentCut)});
  return {agentCut};
}

// ── כניסה לשולחן רמי: גובה כניסה (+ עמלה-קבועה אם rakeMode==='flat'), מקצה bank, מחלק כשמתמלא ──
exports.ramiSit = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId} = request.data || {};
  if (!tableId) throw new HttpsError("invalid-argument", "חסר שולחן");
  const becameFull = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) throw new HttpsError("not-found", "השולחן לא קיים");
    const t = tSnap.data();
    if (t.type !== "rami") throw new HttpsError("failed-precondition", "שולחן לא נתמך");
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
    const fee = t.rakeMode === "flat" ? round2(Number(t.rakeFee) || 0) : 0;
    const total = round2(buyIn + fee);
    if (bal < total) throw new HttpsError("failed-precondition", "אין לך מספיק יתרה לכניסה");
    // כל הקריאות של ramiPayHouse קורות לפני הכתיבות שלנו למטה (סדר קריאה-לפני-כתיבה)
    if (fee > 0) await ramiPayHouse(tx, t.clubId, {...m, uid}, fee);
    const players = {...(t.players || {}), [uid]: {username: m.username || "", photo: m.photo || "", avatarSeed: m.avatarSeed || "", cards: [], stack: buyIn, isBot: false, missed: 0}};
    const bank = {...(t.bank || {}), [uid]: buyIn};
    tx.update(memRef, {balance: round2(bal - total)});
    if (Object.keys(players).length === max) { tx.update(tRef, {...ramiDeal(players, bank, t.timeBank, t.timeBankUses), bank}); return true; }
    tx.update(tRef, {players, bank});
    return false;
  });
  return {ok: true, becameFull};
});

// ── הקמת בעל-האתר אוטומטית: בכניסה ראשונה מקבל בעלות על הקבוצה + 10,000,000 ──
const SITE_OWNER_EMAILS_SRV = ["liorabrgel1991@gmail.com"];
exports.siteOwnerSetup = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = ((request.auth && request.auth.token && request.auth.token.email) || "").toLowerCase().trim();
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  if (!SITE_OWNER_EMAILS_SRV.includes(email)) throw new HttpsError("permission-denied", "לא בעל האתר");
  await db.runTransaction(async (tx) => {
    const cRef = db.doc("clubs/main");
    const mRef = db.doc(`memberships/${uid}_main`);
    const uRef = db.doc(`users/${uid}`);
    const cSnap = await tx.get(cRef);
    const mSnap = await tx.get(mRef);
    const uSnap = await tx.get(uRef);
    const uname = (uSnap.exists && uSnap.data().username) ? uSnap.data().username : "בעל האתר";
    tx.set(cRef, {name: "RUMMIKUBE", ownerUid: uid, ownerName: uname, rakePct: (cSnap.exists && cSnap.data().rakePct != null) ? cSnap.data().rakePct : DEFAULT_RAKE_PCT, ownerSeeded: true}, {merge: true});
    if (!mSnap.exists) {
      tx.set(mRef, {uid, clubId: "main", username: uname, email, role: "club_owner", status: "approved", balance: 10000000, clubProfits: 0, agentProfits: 0, isBot: false, stats: {gamesPlayed: 0, gamesWon: 0, totalProfit: 0}, joinedAt: Date.now()});
    } else {
      const d = mSnap.data();
      const upd = {role: "club_owner", status: "approved"};
      if (!(Number(d.balance) > 0)) upd.balance = 10000000; // מזרים 10M רק אם היתרה ריקה
      tx.update(mRef, upd);
    }
  });
  return {ok: true};
});

// ── מיזוג כפילות-שחקן (בעלים/GOD): מאחד שני חשבונות של אותו אדם (כניסות-אורח כפולות) ──
// מעביר את היתרה+הסטטיסטיקה מ-dropUid אל keepUid, מוחק את החשבון הכפול. הכסף נשמר (סכום).
exports.godMergePlayers = onCall(async (request) => {
  const email = ((request.auth && request.auth.token && request.auth.token.email) || "").toLowerCase().trim();
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {keepUid, dropUid, clubId} = request.data || {};
  if (!keepUid || !dropUid || keepUid === dropUid) throw new HttpsError("invalid-argument", "חסרים/שגויים מזהי-שחקן");
  const cid = clubId || "main";
  // הרשאה: GOD, בעל-האתר, או בעל-הקלאב
  let allowed = isGodEmail(email) || SITE_OWNER_EMAILS_SRV.includes(email);
  if (!allowed) { const c = await db.doc(`clubs/${cid}`).get(); if (c.exists && c.data().ownerUid === uid) allowed = true; }
  if (!allowed) throw new HttpsError("permission-denied", "אין הרשאה");
  const out = await db.runTransaction(async (tx) => {
    const keepMemRef = db.doc(`memberships/${keepUid}_${cid}`);
    const dropMemRef = db.doc(`memberships/${dropUid}_${cid}`);
    const keepUserRef = db.doc(`users/${keepUid}`);
    const dropUserRef = db.doc(`users/${dropUid}`);
    const [keepMem, dropMem, keepUser, dropUser] = await Promise.all([tx.get(keepMemRef), tx.get(dropMemRef), tx.get(keepUserRef), tx.get(dropUserRef)]);
    if (!dropUser.exists) throw new HttpsError("not-found", "החשבון הכפול לא קיים");
    const kM = keepMem.exists ? keepMem.data() : null;
    const dM = dropMem.exists ? dropMem.data() : null;
    const dBal = dM ? round2(Number(dM.balance) || 0) : 0;
    const kBal = kM ? round2(Number(kM.balance) || 0) : 0;
    const dStats = (dM && dM.stats) || (dropUser.data().stats) || {};
    const kStats = (kM && kM.stats) || (keepUser.exists ? keepUser.data().stats : {}) || {};
    const mergedStats = {
      gamesPlayed: (Number(kStats.gamesPlayed) || 0) + (Number(dStats.gamesPlayed) || 0),
      gamesWon: (Number(kStats.gamesWon) || 0) + (Number(dStats.gamesWon) || 0),
      totalProfit: round2((Number(kStats.totalProfit) || 0) + (Number(dStats.totalProfit) || 0)),
      bestStreak: Math.max(Number(kStats.bestStreak) || 0, Number(dStats.bestStreak) || 0),
      streak: Number(kStats.streak) || 0,
    };
    // כותבים ל-keep: יתרה מאוחדת + סטטיסטיקה
    if (keepMem.exists) tx.update(keepMemRef, {balance: round2(kBal + dBal), stats: mergedStats});
    else if (dM) tx.set(keepMemRef, {...dM, uid: keepUid, balance: round2(kBal + dBal), stats: mergedStats});
    if (keepUser.exists) tx.update(keepUserRef, {balance: round2((Number(keepUser.data().balance) || 0) + (Number(dropUser.data().balance) || 0)), stats: mergedStats});
    // מוחקים את החשבון הכפול
    if (dropMem.exists) tx.delete(dropMemRef);
    tx.delete(dropUserRef);
    return {keepUid, dropUid, mergedBalance: round2(kBal + dBal)};
  });
  return {ok: true, ...out};
});

// ── כניסת-אורח סמכותית לפי טלפון (מבטלת כפילויות מהשורש) ──────────────────────
// אורח = uid אנונימי חדש בכל פעם שהאחסון בדפדפן נמחק (webview של וואטסאפ, iOS פרטי).
// לכן במקום להסתמך על ה-uid, מזהים את השחקן לפי הטלפון שהוא מקליד: מאחדים אוטומטית
// את כל החשבונות עם אותו טלפון אל ה-uid הנוכחי (סוכמים יתרות, שומרים סטטוס-מאושר
// והסטטיסטיקה הטובה ביותר) ומוחקים את השאר. כך אי-אפשר ליצור כפילות, וזה גם מרפא
// לבד את הכפילויות הקיימות (עדן/חיה) בכניסה הבאה שלהן. הכסף נשמר (סכום, לא שכפול).
exports.guestEnter = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  // רק אורח (התחברות אנונימית) יכול לקרוא לזה — כדי שמשתמש-גוגל לא ישתמש בזה
  // כדי "לתפוס" חשבון של מישהו אחר לפי טלפון.
  const prov = request.auth.token && request.auth.token.firebase && request.auth.token.firebase.sign_in_provider;
  if (prov !== "anonymous") throw new HttpsError("permission-denied", "כניסת-אורח בלבד");
  const {phone, name, clubId} = request.data || {};
  const cid = clubId || "main";
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 3) throw new HttpsError("invalid-argument", "מספר מזהה לא תקין");

  // מגלים מועמדים: חברויות-אורח (בלי email) עם אותו טלפון. חשבון רשום (עם email/גוגל)
  // לעולם לא נבלע דרך טלפון — הגנה מפני השתלטות על חשבון רשום.
  const memSnap = await db.collection("memberships").where("clubId", "==", cid).get();
  const candUids = new Set([uid]);
  memSnap.forEach((d) => {
    const m = d.data();
    if (m.isBot || m.email) return;
    const mp = String(m.phone || m.playerId || "").replace(/\D/g, "");
    if (mp && mp === digits) candUids.add(m.uid || d.id.split("_")[0]);
  });

  const newMemRef = db.doc(`memberships/${uid}_${cid}`);
  const newUserRef = db.doc(`users/${uid}`);

  const out = await db.runTransaction(async (tx) => {
    // קוראים את כל המועמדים *בתוך* הטרנזקציה כדי שסכום-הכסף יהיה עקבי (בלי מרוץ)
    const uids = [...candUids];
    const memRefs = uids.map((u) => db.doc(`memberships/${u}_${cid}`));
    const userRefs = uids.map((u) => db.doc(`users/${u}`));
    const memSnaps = await Promise.all(memRefs.map((r) => tx.get(r)));
    const curUserSnap = await tx.get(newUserRef);

    const found = [];
    memSnaps.forEach((s, i) => { if (s.exists) { const m = s.data(); if (!m.isBot && !m.email) found.push({uid: uids[i], m}); } });

    const sumBal = round2(found.reduce((s, x) => s + (Number(x.m.balance) || 0), 0));
    const anyApproved = found.some((x) => x.m.status === "approved");
    const scoreOf = (x) => (x.m.status === "approved" ? 1e15 : 0) + (Number(x.m.balance) || 0);
    let best = null; for (const x of found) { if (!best || scoreOf(x) > scoreOf(best)) best = x; }
    const mergedStats = found.reduce((a, x) => {
      const st = x.m.stats || {};
      a.gamesPlayed += Number(st.gamesPlayed) || 0;
      a.gamesWon += Number(st.gamesWon) || 0;
      a.totalProfit = round2(a.totalProfit + (Number(st.totalProfit) || 0));
      a.bestStreak = Math.max(a.bestStreak, Number(st.bestStreak) || 0);
      return a;
    }, {gamesPlayed: 0, gamesWon: 0, totalProfit: 0, bestStreak: 0, streak: (best && best.m.stats && Number(best.m.stats.streak)) || 0});

    const bestUsername = (best && best.m.username) || name || "אורח";
    const bestRole = (best && best.m.role) || "player";
    const bestAgent = best && best.m.agentUid ? {agentUid: best.m.agentUid, agentPct: best.m.agentPct || 0} : {};
    const status = anyApproved ? "approved" : "pending";

    tx.set(newMemRef, {
      uid, clubId: cid, username: bestUsername, phone: digits, playerId: digits,
      role: bestRole, status, balance: sumBal, isBot: false, stats: mergedStats, ...bestAgent,
    }, {merge: true});
    const cu = curUserSnap.exists ? curUserSnap.data() : {};
    tx.set(newUserRef, {
      username: bestUsername, isGuest: true, role: bestRole, status,
      playerId: digits, phone: digits, balance: sumBal, isBot: false,
      avatarSeed: cu.avatarSeed || (best && best.m.avatarSeed) || null, stats: mergedStats,
    }, {merge: true});

    // מוחקים את הכפילויות (uid אחר) — הכסף כבר סוכם לחשבון הנוכחי
    uids.forEach((u, i) => { if (u !== uid && memSnaps[i].exists) { tx.delete(memRefs[i]); tx.delete(userRefs[i]); } });
    return {status, balance: sumBal, merged: found.filter((x) => x.uid !== uid).length};
  });

  return {ok: true, ...out};
});

// ── איפוס מלא (GOD בלבד): מאפס יתרות + היסטוריה, בעל-האתר מקבל 10,000,000 ──
// רץ ב-admin SDK (עוקף חוקים), אטומי ובבאצ'ים — כך שהאיפוס תמיד מצליח ומדווח.
exports.godFullReset = onCall(async (request) => {
  const email = ((request.auth && request.auth.token && request.auth.token.email) || "").toLowerCase().trim();
  if (!request.auth || !request.auth.uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  if (!isGodEmail(email)) throw new HttpsError("permission-denied", "GOD בלבד");
  const OWNER_EMAIL = SITE_OWNER_EMAILS_SRV[0];
  const uq = await db.collection("users").where("email", "==", OWNER_EMAIL).limit(1).get();
  const ownerUid = uq.empty ? null : uq.docs[0].id;
  const ownerName = (!uq.empty && uq.docs[0].data().username) ? uq.docs[0].data().username : "בעל האתר";

  let batch = db.batch(); let n = 0;
  const flush = async () => { if (n > 0) { await batch.commit(); batch = db.batch(); n = 0; } };
  const bump = async () => { if (++n >= 400) await flush(); };

  // 1) איפוס יתרות + סטטיסטיקה לכל החברויות (חוץ מהבעלים)
  let zeroed = 0;
  const mems = await db.collection("memberships").get();
  for (const d of mems.docs) {
    const uid = d.data().uid || d.id.split("_")[0];
    if (ownerUid && uid === ownerUid) continue;
    batch.update(d.ref, {balance: 0, clubProfits: 0, agentProfits: 0, stats: {gamesPlayed: 0, gamesWon: 0, totalProfit: 0}});
    zeroed++; await bump();
  }
  await flush();
  // יתרות לגסי ב-users
  const usrs = await db.collection("users").get();
  for (const d of usrs.docs) {
    if (ownerUid && d.id === ownerUid) continue;
    batch.update(d.ref, {balance: 0, stats: {gamesPlayed: 0, gamesWon: 0, totalProfit: 0}});
    await bump();
  }
  await flush();

  // 2) בעל-האתר: בעלים מאושר עם 10,000,000
  if (ownerUid) {
    await db.doc(`memberships/${ownerUid}_main`).set({uid: ownerUid, clubId: "main", username: ownerName, email: OWNER_EMAIL, role: "club_owner", status: "approved", balance: 10000000, clubProfits: 0, agentProfits: 0, isBot: false, stats: {gamesPlayed: 0, gamesWon: 0, totalProfit: 0}, joinedAt: Date.now()}, {merge: true});
    await db.doc("clubs/main").set({name: "RUMMIKUBE", ownerUid, ownerName, rakePct: DEFAULT_RAKE_PCT, ownerSeeded: true}, {merge: true});
  }

  // 3) מחיקת היסטוריה ומצב-משחקים
  let deleted = 0;
  for (const col of ["gameLog", "agentLog", "broadcasts", "tables", "tournaments", "securityAlerts"]) {
    const s = await db.collection(col).get();
    let b = db.batch(); let c = 0;
    for (const d of s.docs) { b.delete(d.ref); deleted++; if (++c >= 400) { await b.commit(); b = db.batch(); c = 0; } }
    if (c > 0) await b.commit();
  }
  return {ok: true, ownerFound: !!ownerUid, zeroed, deleted};
});

// ── הוספת בוט ידנית (בעל האתר / GOD בלבד) — כתיבת bank מותרת רק לשרת ──
const BOT_ADMIN_EMAILS = ["liorabrgel1991@gmail.com", "aaci.yoni@gmail.com"];
exports.ramiAddBot = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = ((request.auth && request.auth.token && request.auth.token.email) || "").toLowerCase().trim();
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId, name} = request.data || {};
  if (!tableId) throw new HttpsError("invalid-argument", "חסר שולחן");
  let allowed = BOT_ADMIN_EMAILS.includes(email);
  const tRef0 = db.doc(`tables/${tableId}`);
  const t0 = await tRef0.get();
  if (!t0.exists) throw new HttpsError("not-found", "השולחן לא קיים");
  if (!allowed) {
    const clubSnap = await db.doc(`clubs/${t0.data().clubId}`).get();
    if (clubSnap.exists && clubSnap.data().ownerUid === uid) allowed = true;
  }
  if (!allowed) throw new HttpsError("permission-denied", "אין הרשאה להוסיף בוט");
  const botsSnap = await db.collection("users").where("isBot", "==", true).get();
  const cur0 = t0.data();
  const avail = botsSnap.docs.map((d) => ({id: d.id, ...d.data()})).filter((b) => b.id !== "bot_bank" && !(cur0.players || {})[b.id]);
  if (!avail.length) throw new HttpsError("failed-precondition", "אין בוט פנוי");
  const bot = avail[Math.floor(Math.random() * avail.length)];
  const botName = (typeof name === "string" && name.trim()) ? name.trim().slice(0, 40) : (bot.username || "בוט");
  const becameFull = await db.runTransaction(async (tx) => {
    const tSnap = await tx.get(tRef0);
    if (!tSnap.exists) throw new HttpsError("not-found", "השולחן לא קיים");
    const t = tSnap.data();
    if (t.type !== "rami") throw new HttpsError("failed-precondition", "שולחן לא נתמך");
    if (t.phase !== "waiting") throw new HttpsError("failed-precondition", "המשחק כבר התחיל");
    const max = Number(t.maxPlayers) || 0;
    if (Object.keys(t.players || {}).length >= max) throw new HttpsError("failed-precondition", "השולחן מלא");
    if ((t.players || {})[bot.id]) throw new HttpsError("failed-precondition", "הבוט כבר בשולחן");
    const buyIn = round2(Number(t.minBuyIn) || 0);
    // מלאי צ'יפים נדיב לבוט (פיקטיבי — הבית סופג את רווח/הפסד הבוטים פר-יד), כדי שמשחקים
    // ימשיכו סבבים רבים בלי שהבוט "יתרוקן" אחרי הפסד אחד ויחסום "משחק חדש".
    const botStack = round2(Math.max(buyIn * 25, 2500));
    const players = {...(t.players || {}), [bot.id]: {username: botName, cards: [], stack: botStack, isBot: true, missed: 0}};
    const bank = {...(t.bank || {}), [bot.id]: botStack};
    if (Object.keys(players).length === max) { tx.update(tRef0, {...ramiDeal(players, bank, t.timeBank, t.timeBankUses), bank}); return true; }
    tx.update(tRef0, {players, bank});
    return false;
  });
  try { await db.doc(`users/${bot.id}`).update({username: botName}); } catch (e) { /* לוג */ }
  return {ok: true, becameFull};
});

// ── הוספת בוט ידנית לשולחן רמיקוב (פתוח) — זהה ל-ramiAddBot אך עם dealFields ──
exports.rummyAddBot = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = ((request.auth && request.auth.token && request.auth.token.email) || "").toLowerCase().trim();
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId, name} = request.data || {};
  if (!tableId) throw new HttpsError("invalid-argument", "חסר שולחן");
  let allowed = BOT_ADMIN_EMAILS.includes(email);
  const tRef0 = db.doc(`tables/${tableId}`);
  const t0 = await tRef0.get();
  if (!t0.exists) throw new HttpsError("not-found", "השולחן לא קיים");
  if (!allowed) {
    const clubSnap = await db.doc(`clubs/${t0.data().clubId}`).get();
    if (clubSnap.exists && clubSnap.data().ownerUid === uid) allowed = true;
  }
  if (!allowed) throw new HttpsError("permission-denied", "אין הרשאה להוסיף בוט");
  const botsSnap = await db.collection("users").where("isBot", "==", true).get();
  const cur0 = t0.data();
  const avail = botsSnap.docs.map((d) => ({id: d.id, ...d.data()})).filter((b) => b.id !== "bot_bank" && !(cur0.players || {})[b.id]);
  if (!avail.length) throw new HttpsError("failed-precondition", "אין בוט פנוי");
  const bot = avail[Math.floor(Math.random() * avail.length)];
  const botName = (typeof name === "string" && name.trim()) ? name.trim().slice(0, 40) : (bot.username || "בוט");
  const becameFull = await db.runTransaction(async (tx) => {
    const tSnap = await tx.get(tRef0);
    if (!tSnap.exists) throw new HttpsError("not-found", "השולחן לא קיים");
    const t = tSnap.data();
    if (t.type !== "rummikub") throw new HttpsError("failed-precondition", "שולחן לא נתמך");
    if (t.phase !== "waiting") throw new HttpsError("failed-precondition", "המשחק כבר התחיל");
    const max = Number(t.maxPlayers) || 0;
    if (Object.keys(t.players || {}).length >= max) throw new HttpsError("failed-precondition", "השולחן מלא");
    if ((t.players || {})[bot.id]) throw new HttpsError("failed-precondition", "הבוט כבר בשולחן");
    const buyIn = round2(Number(t.minBuyIn) || 0);
    const players = {...(t.players || {}), [bot.id]: {username: botName, cards: [], hasDropped: false, missed: 0, stack: buyIn, isBot: true}};
    const bank = {...(t.bank || {}), [bot.id]: buyIn};
    if (Object.keys(players).length === max) { tx.update(tRef0, {...dealFields(players, bank), bank}); return true; }
    tx.update(tRef0, {players, bank});
    return false;
  });
  try { await db.doc(`users/${bot.id}`).update({username: botName}); } catch (e) { /* לוג */ }
  return {ok: true, becameFull};
});

// ── ליבת-סליקה משותפת: מקבלת מסמך-שולחן שכבר נקרא + tRef, מסלקת את היד ומחזירה out.
// משמשת גם את ramiSettle (שחקן שיורד) וגם את botTick (בוט שיורד). הכל בתוך טרנזקציה אחת. ──
async function settleRamiTx(tx, tRef, t, winnerUid) {
  {
    if (!t.players || !t.players[winnerUid]) throw new HttpsError("failed-precondition", "המנצח עזב");
    const wCheck = ramiBestPartition((t.players[winnerUid].cards || []).filter(Boolean));
    if (!wCheck.complete) throw new HttpsError("failed-precondition", "היד של המנצח אינה שלמה");
    const clubId = t.clubId;
    // מודל הכסף: הפסד קבוע. מי שלא ירד מפסיד את סכום השולחן (=הכניסה), כפול פריש.
    const stake = round2(Number(t.minBuyIn) || 0);
    const freshMult = Math.max(1, Math.min(RAMI_FRESH_CAP, Number(t.freshMult) || 1));
    const rakeMode = t.rakeMode === "flat" ? "flat" : "pct";
    const bank = {...(t.bank || {})};
    // קריאות לפני כתיבות
    const clubSnap = await tx.get(db.doc(`clubs/${clubId}`));
    const club = clubSnap.exists ? clubSnap.data() : {};
    const ownerUid = club.ownerUid || "";
    const rakeFrac = rakeMode === "pct" ? ((t.rakePct != null ? Number(t.rakePct) : (Number(club.rakePct) || DEFAULT_RAKE_PCT)) / 100) : 0;
    const players = JSON.parse(JSON.stringify(t.players));
    const memRefs = {}; const memData = {};
    for (const [u, p] of Object.entries(players)) { if (p.isBot) continue; memRefs[u] = db.doc(`memberships/${u}_${clubId}`); const s = await tx.get(memRefs[u]); memData[u] = s.exists ? s.data() : null; }
    const ownerRef = ownerUid ? db.doc(`memberships/${ownerUid}_${clubId}`) : null;
    const ownerData = ownerRef ? (memData[ownerUid] || (await tx.get(ownerRef)).data()) : null;
    const bankRef = db.doc(`memberships/bot_bank_${clubId}`);
    const bankSnap = await tx.get(bankRef);
    const agentRefs = {}; const agentData = {};
    for (const [u, d] of Object.entries(memData)) { if (d && d.agentUid && Number(d.agentPct) > 0 && d.agentUid !== u && !agentRefs[d.agentUid]) { agentRefs[d.agentUid] = db.doc(`memberships/${d.agentUid}_${clubId}`); const s = await tx.get(agentRefs[d.agentUid]); agentData[d.agentUid] = s.exists ? s.data() : null; } }

    let totalPot = 0; const details = {};
    for (const [u, p] of Object.entries(players)) {
      if (u === winnerUid) continue;
      const pay = Math.min(round2(stake * freshMult), round2(bank[u] || 0));
      bank[u] = round2((bank[u] || 0) - pay);
      players[u].stack = bank[u];
      totalPot = round2(totalPot + pay);
      details[u] = {username: p.username, pay};
    }
    const rake = round2(totalPot * rakeFrac);
    const winnerProfit = round2(totalPot - rake);
    bank[winnerUid] = round2((bank[winnerUid] || 0) + winnerProfit);
    players[winnerUid].stack = bank[winnerUid];
    let botDelta = 0;
    for (const [duid, d] of Object.entries(details)) if (players[duid] && players[duid].isBot) botDelta = round2(botDelta - d.pay);
    if (players[winnerUid].isBot) botDelta = round2(botDelta + winnerProfit);
    const realPlayers = Object.keys(players).filter((u) => !players[u].isBot);
    const cutShare = realPlayers.length ? rake / realPlayers.length : 0;
    const agentCuts = {}; let totalCuts = 0;
    for (const u of realPlayers) {
      const d = memData[u];
      if (d && d.agentUid && d.agentUid !== u) { const pct = Math.min(100, Math.max(0, Number(d.agentPct) || 0)); const cut = round2(cutShare * pct / 100); if (cut > 0 && agentData[d.agentUid]) { agentCuts[d.agentUid] = round2((agentCuts[d.agentUid] || 0) + cut); totalCuts = round2(totalCuts + cut); } }
    }
    // כתיבות
    tx.update(tRef, {players, bank, phase: "showdown", winner: winnerUid, currentTurn: null, turnPhase: null,
      lastResults: {winnerName: players[winnerUid].username, totalPot, rake, winnerProfit, details, endedAt: Date.now()}});
    for (const [u, d] of Object.entries(memData)) {
      if (!d) continue;
      const st = d.stats || {gamesPlayed: 0, gamesWon: 0, totalProfit: 0};
      const isW = u === winnerUid;
      const delta = isW ? winnerProfit : -((details[u] && details[u].pay) || 0);
      const streak = isW ? ((Number(st.streak) || 0) + 1) : 0;          // רצף נצחונות נוכחי
      const bestStreak = Math.max(Number(st.bestStreak) || 0, streak);   // שיא רצף נצחונות
      tx.update(memRefs[u], {"stats.gamesPlayed": (st.gamesPlayed || 0) + 1, "stats.gamesWon": (st.gamesWon || 0) + (isW ? 1 : 0), "stats.totalProfit": round2((st.totalProfit || 0) + delta), "stats.streak": streak, "stats.bestStreak": bestStreak});
    }
    // בעל הקלאב מממן את הבוטים (כמו בית): מקבל את הרייק (פחות נתחי סוכנים) + הרווח/ההפסד הנקי של הבוטים
    if (ownerRef && ownerData) { const ownerGain = round2((rake - totalCuts) + botDelta); if (ownerGain !== 0 || rake > 0) tx.update(ownerRef, {balance: round2((Number(ownerData.balance) || 0) + ownerGain), clubProfits: round2((Number(ownerData.clubProfits) || 0) + rake)}); }
    for (const [aUid, amt] of Object.entries(agentCuts)) { const ad = agentData[aUid]; if (ad) tx.update(agentRefs[aUid], {balance: round2((Number(ad.balance) || 0) + amt), agentProfits: round2((Number(ad.agentProfits) || 0) + amt)}); }
    return {rake, winnerProfit, details, agentCuts, winnerName: players[winnerUid].username, winnerIsBot: !!players[winnerUid].isBot, clubId, winHand: (players[winnerUid].cards || []).filter(Boolean)};
  }
}
// רישום תוצאות-יד ל-gameLog/agentLog (מחוץ לטרנזקציה). משותף לשחקן ולבוט.
async function logRamiSettle(out, winnerUid, tableId) {
  try {
    const rows = [];
    if (!out.winnerIsBot) rows.push({uid: winnerUid, username: out.winnerName, profit: out.winnerProfit, rake: out.rake});
    for (const [duid, d] of Object.entries(out.details)) rows.push({uid: duid, username: d.username, profit: -d.pay});
    for (const r of rows) { if (!r.uid) continue; await db.collection("gameLog").add({uid: r.uid, username: r.username || "", game: "rami", clubId: out.clubId, profit: round2(r.profit || 0), rake: round2(r.rake || 0), tableId, at: Date.now(), winnerName: out.winnerName || "", winHand: out.winHand || []}); }
    if (out.rake > 0) await db.collection("agentLog").add({clubId: out.clubId, agentUid: "club", kind: "club", amount: round2(out.rake), at: Date.now()});
    for (const [aUid, amt] of Object.entries(out.agentCuts)) await db.collection("agentLog").add({agentUid: aUid, clubId: out.clubId, amount: round2(amt), at: Date.now()});
  } catch (e) { /* לוג בלבד */ }
}
// ── סיום יד רמי (קריאת שחקן): המנצח ירד; מפסידים משלמים סכום-המשחק×פריש ──
exports.ramiSettle = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = request.auth && request.auth.token && request.auth.token.email;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId, winnerUid} = request.data || {};
  if (!tableId || !winnerUid) throw new HttpsError("invalid-argument", "חסרים פרטים");
  const out = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) throw new HttpsError("not-found", "השולחן לא קיים");
    const t = tSnap.data();
    if (t.type !== "rami") throw new HttpsError("failed-precondition", "שולחן לא נתמך");
    if (t.phase !== "playing") throw new HttpsError("failed-precondition", "כבר הסתיים");
    assertParticipant(t, uid, email);
    return await settleRamiTx(tx, tRef, t, winnerUid);
  });
  await logRamiSettle(out, winnerUid, tableId);
  return {ok: true};
});

// ════════ מנוע-בוטים בצד-שרת: שולחני-בוטים שרצים לבד + חדרי-המתנה + סיבוב-בוטים ════════
const BOT_ROTATE_MS = 6 * 60 * 1000;
// כינויים עבריים במילה אחת לבוטים (בלי שמות פרטיים) — לפעמים עם מספר אחרי
const BOT_NICKS_HE = [
  "נשר", "פנתר", "אריה", "נמר", "ברק", "סופה", "רעם", "זאב", "שועל", "עיט",
  "בז", "קוברה", "פיניקס", "דרקון", "טיטאן", "ספרטן", "נינגה", "סמוראי", "אלוף", "מלך",
  "קיסר", "קוסם", "מכשף", "גאון", "שד", "מלאך", "בוס", "צל", "רוח", "להבה",
  "ברזל", "סלע", "כריש", "עקרב", "צפע", "פרא", "גלדיאטור", "טורנדו", "מטאור", "נובה",
  "לוחם", "צלף", "שוגון", "ליש", "גור", "בזק", "חץ", "פטיש", "סער", "וולקן",
];
const pickBotNames = (n, taken) => {
  const usedBase = new Set((taken || []).map((x) => String(x).replace(/\d+$/, "")));
  const pool = BOT_NICKS_HE.filter((x) => !usedBase.has(x)).sort(() => Math.random() - 0.5);
  return pool.slice(0, n).map((base) => (Math.random() < 0.5 ? base + (2 + Math.floor(Math.random() * 97)) : base));
};
// בחירת אבן-זריקה זולה (בלי partition): זורקים את הכי "בודדת" ובעלת-ערך גבוה; לא זורקים ג'וקר
function botPickDiscard(hand) {
  let worst = null; let worstScore = Infinity;
  for (const t of hand) {
    if (t.val === "☻") continue;
    let conn = 0;
    for (const o of hand) {
      if (o === t || o.val === "☻") continue;
      if (Number(o.val) === Number(t.val) && o.color !== t.color) conn += 3;
      if (o.color === t.color && Math.abs(Number(o.val) - Number(t.val)) <= 2) conn += 2;
    }
    const score = conn * 10 - tileValR(t);
    if (score < worstScore) { worstScore = score; worst = t; }
  }
  return worst || hand[0];
}
// יד של 15: אם קיים תא שהסרתו נותנת יד-שלמה — מחזיר את אבן-הזריקה לירידה, אחרת null
function botGoOutTile(hand15) {
  const bp = ramiBestPartition(hand15);
  if (bp.leftoverPoints > 13) return null;
  for (const t of hand15) { if (ramiBestPartition(hand15.filter((x) => x.id !== t.id)).complete) return t; }
  return null;
}
// מקדם את תור-הבוט הנוכחי ביד אחת: משיכה + (ירידה או זריקה). בטרנזקציה.
async function botStepTx(tableId) {
  let settleOut = null; let winnerUid = null;
  await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const snap = await tx.get(tRef);
    if (!snap.exists) return;
    const t = snap.data();
    if (t.type !== "rami" || t.phase !== "playing") return;
    const cur = t.currentTurn; const p = (t.players || {})[cur];
    if (!p || !p.isBot) return;
    const deck = [...(t.deck || [])]; const discard = [...(t.discard || [])];
    if (!deck.length && discard.length > 1) { const top = discard.pop(); const rest = discard.splice(0, discard.length); for (let i = rest.length - 1; i > 0; i--) { const j = (i * 2654435761 + 12345) % (i + 1); const tmp = rest[i]; rest[i] = rest[j]; rest[j] = tmp; } deck.push(...rest); if (top) discard.push(top); }
    let hand = [...(p.cards || [])].filter(Boolean);
    const drawn = deck.pop(); if (drawn) hand.push(drawn);
    const goTile = botGoOutTile(hand);
    if (goTile) {
      const final = hand.filter((x) => x.id !== goTile.id); discard.push(goTile);
      t.players = {...t.players, [cur]: {...p, cards: final}}; t.deck = deck; t.discard = discard;
      settleOut = await settleRamiTx(tx, tRef, t, cur); winnerUid = cur; return;
    }
    const drop = botPickDiscard(hand); const final = hand.filter((x) => x.id !== drop.id); discard.push(drop);
    const uids = Object.keys(t.players).sort(); const next = uids[(uids.indexOf(cur) + 1) % uids.length];
    tx.update(tRef, {[`players.${cur}.cards`]: final, [`players.${cur}.missed`]: 0, [`players.${cur}.threw`]: [...((p.threw) || []), drop].slice(-6), deck, discard, currentTurn: next, turnPhase: "draw", drawnThisTurn: false, turnStartedAt: Date.now()});
  });
  if (settleOut && winnerUid) { try { await logRamiSettle(settleOut, winnerUid, tableId); } catch (e) { /* */ } }
}
// חלוקה מחדש לשולחן-בוטים שהסתיים (המשכיות)
async function botRedealTx(tableId) {
  await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const snap = await tx.get(tRef);
    if (!snap.exists) return;
    const t = snap.data();
    if (!t.botTable || t.phase !== "showdown") return;
    const buyIn = round2(Number(t.minBuyIn) || 0);
    const players = {}; const bank = {};
    for (const [u, p] of Object.entries(t.players || {})) { if (!p.isBot) continue; let stack = round2((t.bank || {})[u] || 0); if (stack < buyIn) stack = round2(Math.max(buyIn * 25, 2500)); players[u] = {...p, cards: []}; bank[u] = stack; }
    if (Object.keys(players).length < 2) return;
    tx.update(tRef, {...ramiDeal(players, bank, 0, 0), bank});
  });
}
// החלפת בוט אחד בשולחן-המתנה (אמינות של "אנשים באים והולכים")
async function botRotateTx(tableId, allBots) {
  await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const snap = await tx.get(tRef);
    if (!snap.exists) return;
    const t = snap.data();
    if (!t.botTable || t.phase !== "waiting") return;
    const players = {...(t.players || {})}; const bank = {...(t.bank || {})};
    const botUids = Object.keys(players).filter((u) => players[u].isBot);
    const seed = Number(t.botRotateSeed) || 0;
    const free = allBots.filter((b) => !players[b.id]);
    if (!botUids.length || !free.length) { tx.update(tRef, {botRotateAt: Date.now() + BOT_ROTATE_MS, botRotateSeed: seed + 1}); return; }
    const outUid = botUids[seed % botUids.length]; const inBot = free[seed % free.length];
    const stack = round2(bank[outUid] || Math.max((Number(t.minBuyIn) || 0) * 25, 2500));
    delete players[outUid]; delete bank[outUid];
    const taken = Object.values(players).map((p) => p.username);
    const nm = pickBotNames(1, taken)[0] || inBot.username || "בוט";
    players[inBot.id] = {username: nm, cards: [], stack, isBot: true, missed: 0}; bank[inBot.id] = stack;
    tx.update(tRef, {players, bank, botRotateAt: Date.now() + BOT_ROTATE_MS, botRotateSeed: seed + 1});
  });
}
// חדר-המתנה לשולחן 'full'/'half': כשלא נשאר אף אדם (עזב/סיים), מחזירים ל-'ממתין' במקום
// שהבוטים ימשיכו לשחק לבד לנצח — אחרת שחקן חדש שנכנס תקוע כצופה (ramiSit דורש 'waiting').
async function botResetWaitingTx(tableId) {
  await db.runTransaction(async (tx) => {
    const ref = db.doc(`tables/${tableId}`);
    const s = await tx.get(ref); if (!s.exists) return;
    const t = s.data();
    if (!t.botTable || t.botKind === "bots") return; // 'bots' = אוטונומי, ממשיך לבד
    if (t.phase === "waiting") return;
    const hasHuman = Object.values(t.players || {}).some((p) => !p.isBot);
    if (hasHuman) return;
    const players = {}; const bank = {...(t.bank || {})};
    for (const [u, p] of Object.entries(t.players || {})) { if (p.isBot) players[u] = {...p, cards: [], missed: 0}; else delete bank[u]; }
    tx.update(ref, {players, bank, phase: "waiting", deck: [], discard: [], currentTurn: null, turnPhase: "draw", drawnThisTurn: false, winner: null, lastResults: null, freshMult: 1, freshReq: null, botRotateAt: Date.now() + BOT_ROTATE_MS});
  });
}
// פתיחת שולחן-בוטים (GOD/בעלים): 'bots'=4 בוטים ורץ לבד · 'full'=3 בוטים ממתין · 'half'=2 בוטים ממתין
exports.ramiOpenBotTable = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  const email = ((request.auth && request.auth.token && request.auth.token.email) || "").toLowerCase().trim();
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const kind = ((request.data && request.data.kind) || "full");
  const buyIn = round2(Math.max(1, Number(request.data && request.data.buyIn) || 100));
  let allowed = BOT_ADMIN_EMAILS.includes(email);
  if (!allowed) { const c = await db.doc("clubs/main").get(); if (c.exists && c.data().ownerUid === uid) allowed = true; }
  if (!allowed) throw new HttpsError("permission-denied", "אין הרשאה");
  const maxPlayers = 4;
  const botCount = kind === "bots" ? 4 : kind === "half" ? 2 : 3;
  const botsSnap = await db.collection("users").where("isBot", "==", true).get();
  const pool = botsSnap.docs.map((d) => ({id: d.id, ...d.data()})).filter((b) => b.id !== "bot_bank");
  if (pool.length < botCount) throw new HttpsError("failed-precondition", "אין מספיק בוטים במאגר");
  const chosen = pool.slice().sort(() => Math.random() - 0.5).slice(0, botCount);
  const botStack = round2(Math.max(buyIn * 25, 2500));
  const names = pickBotNames(botCount, []);
  const players = {}; const bank = {};
  chosen.forEach((b, i) => { const nm = names[i] || b.username || "בוט"; players[b.id] = {username: nm, cards: [], stack: botStack, isBot: true, missed: 0}; bank[b.id] = botStack; });
  // מעדכנים גם את שם-המשתמש של הבוט (כדי שגם בלוח-המובילים יופיע עברית)
  try { await Promise.all(chosen.map((b, i) => names[i] ? db.doc(`users/${b.id}`).update({username: names[i]}).catch(() => {}) : null)); } catch (e) { /* */ }
  const base = {type: "rami", clubId: "main", maxPlayers, minBuyIn: buyIn, stakes: buyIn, turnSeconds: 40, timeBank: 0, timeBankUses: 0, rakeMode: "pct", rakePct: null, rakeFee: 0, freshMult: 1, freshReq: null, winner: null, lastResults: null, chat: [], createdAt: Date.now(), botTable: true, botKind: kind, botRotateAt: Date.now() + BOT_ROTATE_MS, botRotateSeed: 0, players, bank};
  const doc = kind === "bots" ? {...base, ...ramiDeal(players, bank, 0, 0), bank, botRun: true} : {...base, deck: [], discard: [], phase: "waiting", currentTurn: null, turnPhase: "draw", drawnThisTurn: false};
  const ref = await db.collection("tables").add(doc);
  return {ok: true, tableId: ref.id, kind, bots: botCount};
});
// טיק-בוטים (נקרא ע"י כל לקוח מחובר, כמו tourTick): מריץ שולחני-בוטים, מסובב בוטים בהמתנה
exports.botTick = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) return {ok: false};
  const now = Date.now();
  const snap = await db.collection("tables").where("type", "==", "rami").get();
  const tables = snap.docs.map((d) => ({id: d.id, ...d.data()})).filter((t) => t.botTable);
  let allBots = null; let acted = 0;
  for (const t of tables) {
    try {
      const hasHuman = Object.values(t.players || {}).some((p) => !p.isBot);
      if (t.phase === "waiting") { if ((Number(t.botRotateAt) || 0) <= now) { if (!allBots) { const bs = await db.collection("users").where("isBot", "==", true).get(); allBots = bs.docs.map((d) => ({id: d.id, ...d.data()})).filter((b) => b.id !== "bot_bank"); } await botRotateTx(t.id, allBots); acted++; } continue; }
      // שולחן 'full'/'half' שנשאר בלי אף אדם → חוזר ל'ממתין' (שחקן חדש יוכל לשבת ולהתחיל)
      if (!hasHuman && (t.botKind === "full" || t.botKind === "half")) { await botResetWaitingTx(t.id); acted++; continue; }
      if (t.phase === "playing" && !hasHuman) { const p = (t.players || {})[t.currentTurn]; if (p && p.isBot && (now - (Number(t.turnStartedAt) || 0) > 2500)) { await botStepTx(t.id); acted++; } continue; }
      if (t.phase === "showdown" && !hasHuman) { const endedAt = (t.lastResults && t.lastResults.endedAt) || 0; if (now - endedAt > 4000) { await botRedealTx(t.id); acted++; } }
    } catch (e) { /* */ }
  }
  return {ok: true, acted, tables: tables.length};
});

// ── סיבוב חדש ברמי: מחלק מחדש רק לשחקנים עם צ'יפים; מאפס פריש ──
exports.ramiNewRound = onCall(async (request) => {
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
    if (t.type !== "rami") throw new HttpsError("failed-precondition", "שולחן לא נתמך");
    if (t.phase !== "showdown") throw new HttpsError("failed-precondition", "אין סיבוב לפתוח");
    assertParticipant(t, uid, email);
    const buyIn = round2(Number(t.minBuyIn) || 0);
    const bank = t.bank || {};
    const players = t.players || {};
    // קריאות לפני כתיבות: חברויות השחקנים האנושיים (לצורך רי-באי מהארנק)
    const memRefs = {}; const memData = {};
    for (const [u, p] of Object.entries(players)) { if (p.isBot) continue; const r = db.doc(`memberships/${u}_${t.clubId}`); memRefs[u] = r; const s = await tx.get(r); memData[u] = s.exists ? s.data() : null; }
    // רי-באי אוטומטי: משלימים כל שחקן חוזר לסכום-המשחק. בוט — חינם (פיקטיבי). אנושי —
    // מהארנק אם יש. כך "סבב חדש" ממשיך עם כולם ולא זורק אף אחד לצפייה בגלל 0 צ'יפים.
    const eligible = {}; const eBank = {}; const walletDebits = {};
    for (const [u, p] of Object.entries(players)) {
      let stack = round2(bank[u] || 0);
      if (p.isBot) { if (stack < buyIn) stack = round2(Math.max(buyIn * 25, 2500)); eligible[u] = p; eBank[u] = stack; continue; }
      if (buyIn <= 0 || stack >= buyIn) { eligible[u] = p; eBank[u] = stack; continue; }
      const wallet = memData[u] ? round2(Number(memData[u].balance) || 0) : 0;
      const need = round2(buyIn - stack);
      if (wallet >= need) { walletDebits[u] = need; eligible[u] = p; eBank[u] = buyIn; }
      else if (stack > 0) { eligible[u] = p; eBank[u] = stack; }
      // אין צ'יפים ואין ארנק → יוצא מהסבב (צופה)
    }
    if (Object.keys(eligible).length < 2) throw new HttpsError("failed-precondition", "אין מספיק שחקנים עם צ'יפים");
    for (const [u, amt] of Object.entries(walletDebits)) { const d = memData[u]; if (d) tx.update(memRefs[u], {balance: round2((Number(d.balance) || 0) - amt)}); }
    tx.update(tRef, {...ramiDeal(eligible, eBank, t.timeBank, t.timeBankUses), bank: eBank});
  });
  return {ok: true};
});

// ── עזיבת שולחן רמי: המתנה=החזר לארנק; באמצע יד=כניעה, הצ'יפים לנשארים ──
exports.ramiLeave = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const {tableId} = request.data || {};
  if (!tableId) throw new HttpsError("invalid-argument", "חסר שולחן");
  const out = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tables/${tableId}`);
    const tSnap = await tx.get(tRef);
    if (!tSnap.exists) return {gone: true};
    const t = tSnap.data();
    if (t.type !== "rami" || !t.players || !t.players[uid]) return {gone: true};
    const clubId = t.clubId;
    const bank = {...(t.bank || {})};
    const playing = t.phase === "playing";
    const myStack = round2(bank[uid] || 0);
    const memRef = db.doc(`memberships/${uid}_${clubId}`);
    const memSnap = await tx.get(memRef);
    const mem = memSnap.exists ? memSnap.data() : {};
    const newP = {...t.players}; delete newP[uid]; delete bank[uid];
    const rest = Object.keys(newP);
    if (!playing) { tx.update(memRef, {balance: round2((Number(mem.balance) || 0) + myStack)}); tx.update(tRef, {players: newP, bank}); return {cashout: true, clubId, myStack}; }
    const lastMan = rest.length === 1;
    const isBotMap = {}; rest.forEach((u) => isBotMap[u] = !!newP[u].isBot);
    const clubSnap = await tx.get(db.doc(`clubs/${clubId}`));
    const club = clubSnap.exists ? clubSnap.data() : {};
    const ownerUid = club.ownerUid || "";
    const rakeFrac = t.rakeMode === "flat" ? 0 : ((t.rakePct != null ? Number(t.rakePct) : (Number(club.rakePct) || DEFAULT_RAKE_PCT)) / 100);
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
      upd.phase = "showdown"; upd.winner = winUid; upd.currentTurn = null; upd.turnPhase = null;
      upd.lastResults = {winnerName: newP[winUid].username, totalPot: myStack, rake, winnerProfit, details: {[uid]: {username: mem.username || "", penalty: 0, pay: myStack}}, endedAt: Date.now()};
      if (winMemRef && winMem) { const ws = winMem.stats || {}; tx.update(winMemRef, {"stats.gamesPlayed": (ws.gamesPlayed || 0) + 1, "stats.gamesWon": (ws.gamesWon || 0) + 1, "stats.totalProfit": round2((ws.totalProfit || 0) + winnerProfit)}); }
      if (ownRef && ownMem && rake > 0) tx.update(ownRef, {balance: round2((Number(ownMem.balance) || 0) + rake), clubProfits: round2((Number(ownMem.clubProfits) || 0) + rake)});
    } else if (rest.length >= 2) {
      const sp = conserveSplit(myStack, rest, isBotMap);
      rest.forEach((u) => { bank[u] = round2((bank[u] || 0) + sp.per[u]); newP[u].stack = bank[u]; });
      botDelta = sp.botDelta;
      if (t.currentTurn === uid) { const s = [...rest].sort(); upd.currentTurn = s[0]; upd.turnPhase = "draw"; upd.drawnThisTurn = false; upd.turnStartedAt = Date.now(); }
    }
    upd.bank = bank;
    if (bankSnap.exists && botDelta !== 0) tx.update(bankRef, {balance: round2((Number(bankSnap.data().balance) || 0) + botDelta)});
    tx.update(tRef, upd);
    return {surrender: true, clubId, myStack, username: mem.username || ""};
  });
  try { if (out && out.surrender) await db.collection("gameLog").add({uid, username: out.username, game: "rami", clubId: out.clubId, profit: -round2(out.myStack), rake: 0, tableId, at: Date.now()}); } catch (e) { /* לוג */ }
  return {ok: true, ...out};
});

// ══════════════ מנוע טורניר-רמי בשרת (בלי תלות בבעל-האתר המחובר) ══════════════
// שמירת-כסף: פרסים לזוכים לפי האחוזים, רייק (feeTotal) לבעלים; בוטים לא מקבלים
// פרס; העודף לאלוף (אם אנושי) אחרת לבעלים. אידמפוטנטי (תובע 'done').
async function ramiPayoutSrv(tournamentId, championUid) {
  const logs = [];
  const done = await db.runTransaction(async (tx) => {
    const tRef = db.doc(`tournaments/${tournamentId}`);
    const s = await tx.get(tRef);
    if (!s.exists) return false;
    const t = s.data();
    if (t.game !== "rami") return false;
    if (t.status === "done" || t.status === "paying") return false;
    const clubId = t.clubId || "main";
    const pl = {...(t.players || {})};
    if (championUid && pl[championUid]) pl[championUid] = {...pl[championUid], rank: 1, out: false};
    const entrants = Object.values(pl);
    const net = round2(t.prizePool || 0);
    const rake = round2(t.feeTotal || 0);
    const custom = Array.isArray(t.payouts) && t.payouts.length ? t.payouts.map((x) => (Number(x) || 0) / 100) : null;
    const n = entrants.length;
    const scheme = custom || (n >= 5 ? [0.5, 0.3, 0.2] : n >= 3 ? [0.7, 0.3] : [1]);
    const ranked = entrants.filter((p) => p.rank).sort((a, b) => a.rank - b.rank);
    const clubSnap = await tx.get(db.doc(`clubs/${clubId}`));
    const ownerUid = clubSnap.exists ? (clubSnap.data().ownerUid || "") : "";
    const results = []; const credits = {}; const netLog = {}; let paidOut = 0;
    for (let i = 0; i < ranked.length; i++) {
      const p = ranked[i];
      const prize = i < scheme.length ? round2(Math.floor(net * scheme[i] * 100) / 100) : 0;
      results.push({name: p.name, rank: p.rank, prize, bounties: p.bounties || 0});
      if (prize > 0 && !p.isBot) { credits[p.uid] = round2((credits[p.uid] || 0) + prize); paidOut = round2(paidOut + prize); }
      if (!p.isBot) netLog[p.uid] = round2((netLog[p.uid] || 0) + (prize - (Number(p.paid) || 0)));
    }
    const champ = ranked[0]; const dust = round2(net - paidOut);
    if (dust > 0) {
      if (champ && !champ.isBot) { credits[champ.uid] = round2((credits[champ.uid] || 0) + dust); netLog[champ.uid] = round2((netLog[champ.uid] || 0) + dust); if (results[0]) results[0].prize = round2((results[0].prize || 0) + dust); }
      else if (ownerUid) { credits[ownerUid] = round2((credits[ownerUid] || 0) + dust); netLog[ownerUid] = round2((netLog[ownerUid] || 0) + dust); }
    }
    if (rake > 0 && ownerUid) { credits[ownerUid] = round2((credits[ownerUid] || 0) + rake); netLog[ownerUid] = round2((netLog[ownerUid] || 0) + rake); }
    const targets = Object.keys(credits); const snaps = {};
    for (const u of targets) snaps[u] = await tx.get(db.doc(`memberships/${u}_${clubId}`));
    for (const u of targets) { const sn = snaps[u]; if (sn && sn.exists) tx.update(sn.ref, {balance: round2((Number(sn.data().balance) || 0) + credits[u])}); }
    for (const u of Object.keys(netLog)) { const p = pl[u] || {}; logs.push({uid: u, username: p.name || "", clubId, profit: round2(netLog[u])}); }
    tx.update(tRef, {status: "done", players: pl, results, finishedAt: Date.now()});
    return true;
  });
  if (done) { for (const l of logs) { try { await db.collection("gameLog").add({uid: l.uid, username: l.username, game: "tournament", clubId: l.clubId, profit: l.profit, rake: 0, tableId: "tournament:" + tournamentId, at: Date.now()}); } catch (e) { /* לוג */ } } }
  return done;
}

// זריעת סבב רמי בשרת: מפצל לשולחנות (עד 4), מחלק ומאתחל חיים
async function ramiSeedSrv(tor, uids, round) {
  const lives = Math.max(1, Number(tor.lives) || 3);
  const shuffled = [...uids];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; }
  const size = 4; const nTables = Math.max(1, Math.ceil(shuffled.length / size));
  const groups = Array(nTables).fill(0).map(() => []);
  shuffled.forEach((uid, i) => groups[i % nTables].push(uid));
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi]; const pm = {};
    g.forEach((uid) => { const p = (tor.players || {})[uid] || {}; pm[uid] = {username: p.name || "", photo: p.photo || "", avatarSeed: p.avatarSeed || "", isBot: !!p.isBot, lives, out: false}; });
    const meta = {name: tor.name, round, finished: g.length < 2, tableWinner: g.length < 2 ? (g[0] || null) : null};
    const dealt = g.length >= 2 ? ramiDeal(pm, {}, 0, 0) : {players: pm, phase: "showdown", deck: [], discard: [], currentTurn: null, turnPhase: "draw", drawnThisTurn: false, winner: g[0] || null, lastResults: null, freshMult: 1, freshReq: null};
    await db.collection("tables").add(Object.assign({type: "rami", clubId: tor.clubId || "main", createdAt: Date.now(), tournamentId: tor.id, tournament: meta, maxPlayers: g.length, minBuyIn: 0, stakes: 0, turnSeconds: 60, timeBank: 0, timeBankUses: 0, rakeMode: "pct", rakePct: 0, rakeFee: 0, bank: {}, chat: [], elimOrder: []}, dealt));
  }
}

// טיק טורניר-רמי: זינוק, קידום-יד בשולחן, מיזוג סבבים וסיום — הכל בשרת
exports.tourTick = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const clubId = (request.data && request.data.clubId) || "main";
  const now = Date.now();
  const tSnap = await db.collection("tournaments").where("clubId", "==", clubId).where("game", "==", "rami").get();
  for (const d of tSnap.docs) {
    const tor = {id: d.id, ...d.data()};
    try {
      // (1) זינוק בזמן — תביעה אטומית
      if (tor.status === "reg" && tor.startAt && now >= tor.startAt) {
        const claim = await db.runTransaction(async (tx) => {
          const s = await tx.get(d.ref); if (!s.exists) return null;
          const t = s.data(); if (t.status !== "reg") return null;
          tx.update(d.ref, {status: "running", startedAt: now, round: 1});
          return t;
        });
        if (claim) {
          const entrants = Object.values(claim.players || {}).filter((p) => !p.out);
          if (entrants.length < 2) {
            for (const p of entrants) { if (!p.isBot && (Number(p.paid) || 0) > 0) { try { const mr = db.doc(`memberships/${p.uid}_${tor.clubId || "main"}`); await db.runTransaction(async (tx) => { const ms = await tx.get(mr); if (ms.exists) tx.update(mr, {balance: round2((Number(ms.data().balance) || 0) + (Number(p.paid) || 0))}); }); } catch (e) { /* */ } } }
            await d.ref.update({status: "cancelled"});
          } else { await ramiSeedSrv({...claim, id: tor.id}, entrants.map((p) => p.uid), 1); }
        }
        continue;
      }
      if (tor.status !== "running") continue;
      const tablesSnap = await db.collection("tables").where("tournamentId", "==", tor.id).get();
      const myTables = tablesSnap.docs.map((x) => ({docId: x.id, ...x.data()}));
      if (!myTables.length) continue;
      // (2) קידום-יד: שולחן ב-showdown שלא הסתיים → יד חדשה לחיים שנותרו / מנצח-שולחן
      for (const tb of myTables) {
        if (tb.phase !== "showdown" || (tb.tournament && tb.tournament.finished)) continue;
        await db.runTransaction(async (tx) => {
          const ref = db.doc(`tables/${tb.docId}`);
          const s = await tx.get(ref); if (!s.exists) return;
          const cur = s.data();
          if (cur.phase !== "showdown" || (cur.tournament && cur.tournament.finished)) return;
          const players = cur.players || {};
          const alive = Object.keys(players).filter((u) => !players[u].out && (Number(players[u].lives) || 0) > 0);
          if (alive.length <= 1) { tx.update(ref, {"tournament.finished": true, "tournament.tableWinner": alive[0] || null, phase: "showdown"}); return; }
          const pm = {};
          alive.forEach((u) => { const p = players[u] || {}; pm[u] = {username: p.username || "", photo: p.photo || "", avatarSeed: p.avatarSeed || "", isBot: !!p.isBot, lives: Number(p.lives) || 0, out: false}; });
          const dealt = ramiDeal(pm, {}, 0, 0);
          tx.update(ref, Object.assign({elimOrder: cur.elimOrder || []}, dealt));
        });
      }
      // (3) מיזוג סבבים / סיום — כשכל השולחנות הסתיימו
      const fresh = (await db.collection("tables").where("tournamentId", "==", tor.id).get()).docs.map((x) => ({docId: x.id, ...x.data()}));
      if (fresh.length && fresh.every((tb) => tb.tournament && tb.tournament.finished)) {
        const winners = fresh.map((tb) => tb.tournament.tableWinner).filter(Boolean);
        for (const tb of fresh) { try { await db.doc(`tables/${tb.docId}`).delete(); } catch (e) { /* */ } }
        if (winners.length <= 1) { await ramiPayoutSrv(tor.id, winners[0] || null); }
        else {
          const nr = (Number(tor.round) || 1) + 1;
          await d.ref.update({round: nr});
          const cur = (await d.ref.get()).data();
          await ramiSeedSrv({...cur, id: tor.id}, winners, nr);
        }
      }
    } catch (e) { /* לוג */ }
  }
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
