/**
 * priv-split simulation — מאמת את מודל-האחסון של מצב שרת-מלא (phase 2):
 * ידי-אנוש ב"תא פרטי" (priv), ידי-בוט + handCount במסמך הציבורי. מחקה בדיוק את מה
 * שה-Cloud Functions עושים (dealSplit / readHands / writeHand + engine) ומוודא:
 *   • שימור-אבנים על פני האחסון המפוצל (priv + public + deck + discard) = 106 תמיד.
 *   • handCount הציבורי תמיד תואם למספר האבנים ב-priv (אין דליפה/סטייה).
 *   • שום אבן-אנוש לא נשמרת בציבורי בזמן משחק (אי-אפשר לקרוא יד של יריב).
 *   • המשחק מסתיים (מנצח או תיקו-קופה), בלי קיפאון.
 * Run: node ramiEngine.priv.test.js
 */
"use strict";
const assert = require("assert");
const E = require("./ramiEngine");
const B = require("./ramiBrain");

function rngFrom(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ── מחקה dealSplit של השרת ─────────────────────────────────────────────
function dealSplit(dealt, isBotMap, priv) {
  const pub = {...dealt, players: {}};
  for (const [u, p] of Object.entries(dealt.players)) {
    if (isBotMap[u]) { pub.players[u] = {isBot: true, cards: p.cards}; }
    else { priv[u] = p.cards; pub.players[u] = {isBot: false, handCount: p.cards.length}; }
  }
  return pub;
}
// מחקה readHands: אנוש מ-priv, בוט מהציבורי
function readHands(pub, priv) {
  const out = {};
  for (const [u, p] of Object.entries(pub.players)) out[u] = p.isBot ? (p.cards || []) : (priv[u] || []);
  return out;
}
// census על פני האחסון המפוצל
function censusSplit(pub, priv) {
  const cnt = new Map();
  const bump = (t) => { if (!t || t.val == null) return; const k = t.val === "☻" ? "J" : `${t.val}.${t.color}`; cnt.set(k, (cnt.get(k) || 0) + 1); };
  for (const p of Object.values(pub.players)) if (p.isBot) for (const t of (p.cards || [])) bump(t);
  for (const c of Object.values(priv)) for (const t of c) bump(t);
  for (const t of (pub.deck || [])) bump(t);
  for (const t of (pub.discard || [])) bump(t);
  let total = 0, excess = null;
  for (const [k, n] of cnt) { total += n; if (n > 2) excess = excess || `${k}=${n}`; }
  return {total, excess};
}
function checkInvariants(pub, priv, where) {
  const c = censusSplit(pub, priv);
  assert.ok(!c.excess, `EXCESS at ${where}: ${c.excess}`);
  assert.strictEqual(c.total, 106, `count ${c.total}!=106 at ${where}`);
  for (const [u, p] of Object.entries(pub.players)) {
    if (p.isBot) continue;
    // בזמן משחק: אין קלפי-אנוש בציבורי (רק handCount)
    if (pub.phase === "playing") assert.ok(!p.cards || p.cards.length === 0, `human ${u} has PUBLIC cards during play at ${where}`);
    // handCount תואם ל-priv
    if (pub.phase === "playing") assert.strictEqual(Number(p.handCount) || 0, (priv[u] || []).length, `handCount mismatch ${u} at ${where}`);
  }
}

function pickWorst(hand) {
  let worst = null, ws = Infinity;
  for (const t of hand) { if (t.val === "☻") continue; let conn = 0; for (const o of hand) { if (o === t || o.val === "☻") continue; if (Number(o.val) === Number(t.val) && o.color !== t.color) conn += 3; if (o.color === t.color && Math.abs(Number(o.val) - Number(t.val)) <= 2) conn += 2; } const sc = conn * 10 - Number(t.val); if (sc < ws) { ws = sc; worst = t; } }
  return worst || hand[0];
}
function goOutTileFor(hand) { const bp = B.bestPartition(hand); if (bp.leftoverPoints > 20) return null; for (const t of hand) if (E.canGoOut(hand, t.id)) return t; return null; }

// מחקה תור מלא כפי שהשרת מבצע: קורא יד → engine → כותב חזרה (priv/public + handCount)
function serverTurn(pub, priv, rng) {
  const uid = pub.currentTurn;
  const isBot = pub.players[uid].isBot;
  const hands = readHands(pub, priv);
  const st = {players: E_hydrate(pub.players, hands), deck: pub.deck, discard: pub.discard, currentTurn: pub.currentTurn, turnPhase: pub.turnPhase, drawnThisTurn: pub.drawnThisTurn, phase: pub.phase, winner: pub.winner, reshuffles: pub.reshuffles};
  E.applyDraw(st, uid, "deck", rng);
  syncBack(pub, priv, st, uid, isBot);
  if (st.phase !== "playing") return; // תיקו-קופה
  const hand = st.players[uid].cards;
  const go = goOutTileFor(hand);
  if (go) {
    E.applyGoOut(st, uid, go.id);
    syncBack(pub, priv, st, uid, isBot);
    pub.phase = "showdown"; pub.winner = uid;
    // סיום-יד: השרת חושף את כל הידיים בציבורי (settle) — מחקים
    for (const [u, c] of Object.entries(readHands(pub, priv))) pub.players[u].cards = c;
    return;
  }
  E.applyDiscard(st, uid, pickWorst(hand).id);
  syncBack(pub, priv, st, uid, isBot);
}
function E_hydrate(players, hands) { const np = {}; for (const [u, p] of Object.entries(players)) np[u] = {...p, cards: hands[u] || []}; return np; }
function syncBack(pub, priv, st, uid, isBot) {
  pub.deck = st.deck; pub.discard = st.discard; pub.currentTurn = st.currentTurn; pub.turnPhase = st.turnPhase; pub.drawnThisTurn = st.drawnThisTurn; pub.phase = st.phase; pub.winner = st.winner; pub.reshuffles = st.reshuffles;
  const cards = st.players[uid].cards;
  if (isBot) { pub.players[uid].cards = cards; }
  else { priv[uid] = cards; pub.players[uid].handCount = cards.length; }
}

let games = 0, wins = 0, draws = 0;
const N = Number(process.env.PGAMES || 400);
for (let s = 1; s <= N; s++) {
  const rng = rngFrom(7000 + s);
  // הרכב מעורב: 1–2 אנושיים + 1–2 בוטים
  const uids = ["h0", (s % 2 ? "h1" : "b1"), "b0"];
  const isBotMap = {h0: false, h1: false, b1: true, b0: true};
  const dealt = E.deal(uids, rng);
  const priv = {};
  const pub = dealSplit(dealt, isBotMap, priv);
  checkInvariants(pub, priv, "deal");
  let turns = 0;
  while (pub.phase === "playing") {
    if (++turns > 4000) throw new Error(`FREEZE priv sim seed=${s}`);
    serverTurn(pub, priv, rng);
    checkInvariants(pub, priv, `seed${s} t${turns}`);
  }
  games++; if (pub.winner) wins++; else draws++;
}
console.log(`priv-split sim: ${games} games OK  (wins=${wins}, pot-draws=${draws})`);
console.log("  ✓ conservation held across priv+public+deck+discard (106, no excess)");
console.log("  ✓ no human cards ever sat in the public doc during play");
console.log("  ✓ public handCount always matched the private hand");
console.log("  ✓ every game terminated (no freeze)");
console.log("\nramiEngine.priv: ALL OK");
