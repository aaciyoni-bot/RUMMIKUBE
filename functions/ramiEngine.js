/**
 * ramiEngine.js — מנוע רמי-סגור אֶפֶס-אֵמון (server-authoritative), מודול טהור.
 *
 * המצב (state) זהה במבנה למסמך-השולחן:
 *   { players:{uid:{cards:[...] , ...}}, deck:[...], discard:[...],
 *     currentTurn, turnPhase:'draw'|'discard', drawnThisTurn:bool,
 *     phase:'playing'|'showdown', winner }
 *
 * כל פונקציית-מהלך מאמתת חוקיות וזורקת EngineError עם code כשהמהלך פסול, אחרת
 * מחזירה את ה-state (ממקום). כך אותה לוגיקה משמשת גם את ה-Cloud Functions (בתוך
 * טרנזקציה) וגם את מבחן-הסימולציה (self-play) שמוכיח שימור-אבנים ואי-קיפאון.
 *
 * הכסף (עונשין/רייק) לא כאן — הוא נשאר ב-settleRamiTx. המנוע מטפל רק במצב-המשחק.
 */
"use strict";
const B = require("./ramiBrain");
const COLORS = B.COLORS; // ['#ef4444','#3b82f6','#f59e0b','#0c1322']

class EngineError extends Error {
  constructor(code, msg) { super(msg || code); this.code = code; }
}

// חפיסה חוקית: 2 עותקים לכל (ערך,צבע) + 2 ג'וקרים = 106 אבנים. id ייחודי לכל אבן.
function newDeck() {
  const d = [];
  let n = 0;
  for (let s = 0; s < 2; s++) for (let c = 0; c < 4; c++) for (let v = 1; v <= 13; v++) d.push({id: `t_${s}_${c}_${v}_${n++}`, val: v, color: COLORS[c]});
  d.push({id: `j1_${n++}`, val: "☻", color: COLORS[0]});
  d.push({id: `j2_${n++}`, val: "☻", color: COLORS[3]});
  return d;
}

// ערבוב Fisher–Yates עם rng מוזרק (ברירת-מחדל Math.random) — דטרמיניסטי במבחן.
function shuffle(arr, rng) {
  const r = rng || Math.random;
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  return arr;
}

// חלוקת סבב חדש: 14 אבנים לכל שחקן, אבן אחת פתוחה לערמת-ההשלכה.
function deal(uids, rng) {
  const d = shuffle(newDeck(), rng);
  const players = {};
  const order = [...uids].sort();
  for (const uid of order) players[uid] = {cards: d.splice(0, 14)};
  const discard = [d.pop()];
  return {players, deck: d, discard, currentTurn: order[0], turnPhase: "draw", drawnThisTurn: false, phase: "playing", winner: null};
}

function nextUid(state, uid) {
  const uids = Object.keys(state.players).sort();
  return uids[(uids.indexOf(uid) + 1) % uids.length];
}

// כמה מחזורי-חפיסה מלאים ללא מנצח נחשבים תיקו (מונע קיפאון-נצח כשאיש לא יורד).
const MAX_RESHUFFLES = 3;

// אם הקופה ריקה — מחזירים את ערמת-ההשלכה (חוץ מהאבן העליונה) לקופה, מעורבבת.
// סופרים ערבובים: אחרי MAX_RESHUFFLES מחזורים בלי מנצח — הסבב תיקו (isStalemate).
function reshuffleIfNeeded(state, rng) {
  if (state.deck.length === 0 && state.discard.length > 1) {
    const top = state.discard.pop();
    const rest = state.discard.splice(0, state.discard.length);
    shuffle(rest, rng);
    state.deck = rest;
    state.discard = [top];
    state.reshuffles = (state.reshuffles || 0) + 1;
  }
}
// תיקו-קופה: עברנו את מכסת-המחזורים ואיש לא ירד → הסבב נגמר בלי מנצח (מחזירים הימור).
function isStalemate(state) { return (state.reshuffles || 0) >= MAX_RESHUFFLES; }

// ── משיכה: source 'deck' | 'discard' ──────────────────────────────────
function applyDraw(state, uid, source, rng) {
  if (state.phase !== "playing") throw new EngineError("not_playing", "המשחק לא פעיל");
  if (state.currentTurn !== uid) throw new EngineError("not_your_turn", "לא תורך");
  if (state.turnPhase !== "draw" || state.drawnThisTurn) throw new EngineError("already_drew", "כבר משכת בתור הזה");
  const p = state.players[uid];
  if (!p) throw new EngineError("not_seated", "אינך בשולחן");
  let drawn = null;
  if (source === "discard") {
    if (!state.discard.length) throw new EngineError("empty_discard", "ערמת-ההשלכה ריקה");
    drawn = state.discard.pop();
  } else {
    reshuffleIfNeeded(state, rng);
    if (!state.deck.length) throw new EngineError("empty_deck", "אין אבנים למשיכה");
    drawn = state.deck.pop();
  }
  p.cards = [...(p.cards || []), drawn];
  state.turnPhase = "discard";
  state.drawnThisTurn = true;
  // תיקו-קופה: אם חצינו את מכסת-המחזורים בלי מנצח — הסבב נגמר ללא זוכה.
  if (isStalemate(state)) { state.phase = "showdown"; state.winner = null; state.currentTurn = null; state.turnPhase = null; }
  return state;
}

// ── השלכה: מסיים את התור ומעביר לשחקן הבא ─────────────────────────────
function applyDiscard(state, uid, tileId) {
  if (state.phase !== "playing") throw new EngineError("not_playing", "המשחק לא פעיל");
  if (state.currentTurn !== uid) throw new EngineError("not_your_turn", "לא תורך");
  if (state.turnPhase !== "discard" || !state.drawnThisTurn) throw new EngineError("must_draw_first", "חובה למשוך לפני השלכה");
  const p = state.players[uid];
  const idx = (p.cards || []).findIndex((t) => t && t.id === tileId);
  if (idx < 0) throw new EngineError("no_such_tile", "האבן אינה בידך");
  const tile = p.cards[idx];
  p.cards = p.cards.filter((_, i) => i !== idx);
  state.discard = [...state.discard, tile];
  state.currentTurn = nextUid(state, uid);
  state.turnPhase = "draw";
  state.drawnThisTurn = false;
  return state;
}

// האם הסרת tileId מהיד מותירה יד שלמה (ירידה חוקית)?
function canGoOut(hand, tileId) {
  const rest = (hand || []).filter((t) => t && t.id !== tileId);
  return B.bestPartition(rest).complete;
}

// ── ירידה (go-out): משליכים את tileId, שאר היד חייבת להיות שלמה ────────
function applyGoOut(state, uid, tileId) {
  if (state.phase !== "playing") throw new EngineError("not_playing", "המשחק לא פעיל");
  if (state.currentTurn !== uid) throw new EngineError("not_your_turn", "לא תורך");
  if (state.turnPhase !== "discard" || !state.drawnThisTurn) throw new EngineError("must_draw_first", "חובה למשוך לפני ירידה");
  const p = state.players[uid];
  const idx = (p.cards || []).findIndex((t) => t && t.id === tileId);
  if (idx < 0) throw new EngineError("no_such_tile", "האבן אינה בידך");
  if (!canGoOut(p.cards, tileId)) throw new EngineError("not_complete", "היד אינה שלמה אחרי ההשלכה");
  const tile = p.cards[idx];
  p.cards = p.cards.filter((_, i) => i !== idx);
  state.discard = [...state.discard, tile];
  state.phase = "showdown";
  state.winner = uid;
  state.currentTurn = null;
  state.turnPhase = null;
  return state;
}

// ── תפוגת-תור (שומר-מפני-קיפאון): מזיז את השחקן הנוכחי בכפייה ──────────
// אם טרם משך — מושך מהקופה; ואז זורק את האבן בעלת-הערך-הגבוה-ביותר (לא ג'וקר אם
// אפשר) ומעביר תור. משמש את ramiForceMoveSrv כשתור פג ובעל-התור לא זמין. פונקציה
// טהורה — נבדקת בסימולציה. מחזירה {moved, uid} או {moved:false} אם אין את מי להזיז.
function applyTimeout(state, rng) {
  if (state.phase !== "playing" || !state.currentTurn) return {moved: false};
  const uid = state.currentTurn;
  const p = state.players[uid];
  if (!p) return {moved: false};
  if (state.turnPhase === "draw" || !state.drawnThisTurn) {
    reshuffleIfNeeded(state, rng);
    if (isStalemate(state)) { state.phase = "showdown"; state.winner = null; state.currentTurn = null; state.turnPhase = null; return {moved: true, uid, draw: true}; }
    if (state.deck.length) { p.cards = [...(p.cards || []), state.deck.pop()]; }
    state.turnPhase = "discard"; state.drawnThisTurn = true;
  }
  const hand = (p.cards || []).filter(Boolean);
  if (!hand.length) { state.currentTurn = nextUid(state, uid); state.turnPhase = "draw"; state.drawnThisTurn = false; return {moved: true, uid}; }
  // זריקת האבן היקרה ביותר; מעדיפים לא לזרוק ג'וקר אם יש חלופה
  const nonJoker = hand.filter((t) => t.val !== "☻");
  const pool = nonJoker.length ? nonJoker : hand;
  let drop = pool[0]; for (const t of pool) if ((t.val === "☻" ? 30 : Number(t.val)) > (drop.val === "☻" ? 30 : Number(drop.val))) drop = t;
  p.cards = hand.filter((t) => t.id !== drop.id);
  state.discard = [...state.discard, drop];
  state.currentTurn = nextUid(state, uid); state.turnPhase = "draw"; state.drawnThisTurn = false;
  return {moved: true, uid, dropped: drop};
}

// שימור-אבנים: כל האבנים (ידיים + קופה + ערמה) = בדיוק 2 לכל (ערך,צבע) + 2 ג'וקרים.
// מחזיר {ok, total, excess} — excess=מפתח שחרג (סימן לזיוף). used by tests + callables.
function tileCensus(state) {
  const cnt = new Map();
  const bump = (t) => { if (!t || t.val == null) return; const k = t.val === "☻" ? "J" : `${t.val}.${t.color}`; cnt.set(k, (cnt.get(k) || 0) + 1); };
  for (const p of Object.values(state.players || {})) for (const t of (p.cards || [])) bump(t);
  for (const t of (state.deck || [])) bump(t);
  for (const t of (state.discard || [])) bump(t);
  let total = 0; let excess = null;
  for (const [k, n] of cnt) { total += n; if (n > 2) excess = excess || `${k}=${n}`; }
  return {ok: !excess, total, excess};
}

module.exports = {EngineError, newDeck, shuffle, deal, nextUid, reshuffleIfNeeded, isStalemate, MAX_RESHUFFLES, applyDraw, applyDiscard, canGoOut, applyGoOut, applyTimeout, tileCensus, COLORS};
