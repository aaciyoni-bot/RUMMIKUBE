/**
 * ramiEngine self-play harness — מוכיח שהמנוע האֶפֶס-אֵמון:
 *   1. שומר-אבנים בכל צעד (106 אבנים, אף פעם לא עודף/כפילות).
 *   2. לא נתקע: כל משחק מסתיים (ירידה או תיקו-קופה) בתוך חסם-תורים.
 *   3. מנצח יורד רק עם יד שלמה באמת.
 * מריץ אלפי משחקים עם RNG דטרמיניסטי (seed) כדי שכשל יהיה ניתן-לשחזור.
 * Run: node ramiEngine.test.js
 */
"use strict";
const assert = require("assert");
const E = require("./ramiEngine");
const B = require("./ramiBrain");

// RNG דטרמיניסטי (mulberry32)
function rngFrom(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// מדיניות-בוט פשוטה למבחן: אם אפשר לרדת — יורד; אחרת מושך מהקופה וזורק את
// האבן ה"הכי בודדת" (הגבוהה בערך עם הכי מעט חיבורים). לא נוגע בג'וקר.
function pickWorst(hand) {
  let worst = null; let ws = Infinity;
  for (const t of hand) {
    if (t.val === "☻") continue;
    let conn = 0;
    for (const o of hand) { if (o === t || o.val === "☻") continue; if (Number(o.val) === Number(t.val) && o.color !== t.color) conn += 3; if (o.color === t.color && Math.abs(Number(o.val) - Number(t.val)) <= 2) conn += 2; }
    const sc = conn * 10 - (t.val === "☻" ? 30 : Number(t.val));
    if (sc < ws) { ws = sc; worst = t; }
  }
  return worst || hand[0];
}
function goOutTileFor(hand) { // hand has 15 after draw
  const bp = B.bestPartition(hand);
  if (bp.leftoverPoints > 20) return null;
  for (const t of hand) if (E.canGoOut(hand, t.id)) return t;
  return null;
}

function assertConserved(state, where) {
  const c = E.tileCensus(state);
  assert.ok(!c.excess, `EXCESS at ${where}: ${c.excess}`);
  assert.strictEqual(c.total, 106, `tile count ${c.total} != 106 at ${where}`);
}

function playGame(seed, nPlayers) {
  const rng = rngFrom(seed);
  const uids = [];
  for (let i = 0; i < nPlayers; i++) uids.push("p" + i);
  let state = E.deal(uids, rng);
  assertConserved(state, "deal");
  // כל שחקן מחזיק 14
  for (const u of uids) assert.strictEqual(state.players[u].cards.length, 14, "deal hand size");
  const MAX_TURNS = 4000; // חסם-קיפאון: משחק לגיטימי מסתיים הרבה לפני
  let turns = 0;
  while (state.phase === "playing") {
    turns++;
    if (turns > MAX_TURNS) throw new Error(`FREEZE: game seed=${seed} exceeded ${MAX_TURNS} turns`);
    const uid = state.currentTurn;
    // משיכה
    const top = state.discard[state.discard.length - 1];
    // לפעמים לוקחים מההשלכה אם היא מתחברת, אחרת מהקופה
    let takeDiscard = false;
    if (top && top.val !== "☻") {
      const trial = [...state.players[uid].cards, top];
      // האם האבן מהשלכה מאפשרת ירידה מיידית?
      if (goOutTileFor(trial)) takeDiscard = true;
    }
    // אם הקופה ריקה ואי-אפשר לערבב (רק אבן אחת בהשלכה) — תיקו-קופה, מסיימים ללא מנצח
    if (!takeDiscard) {
      if (state.deck.length === 0 && state.discard.length <= 1) { state.phase = "showdown"; state.winner = null; break; }
    }
    E.applyDraw(state, uid, takeDiscard ? "discard" : "deck", rng);
    assertConserved(state, `after draw t${turns}`);
    assert.strictEqual(state.players[uid].cards.length, 15, "hand=15 after draw");
    // ירידה או השלכה
    const hand = state.players[uid].cards;
    const go = goOutTileFor(hand);
    if (go) {
      E.applyGoOut(state, uid, go.id);
      assertConserved(state, `after goout t${turns}`);
      // אימות: היד שנותרה שלמה
      assert.ok(B.bestPartition(state.players[uid].cards).complete, "winner hand complete");
      assert.strictEqual(state.players[uid].cards.length, 14, "winner holds 14");
      break;
    }
    const drop = pickWorst(hand);
    E.applyDiscard(state, uid, drop.id);
    assertConserved(state, `after discard t${turns}`);
    assert.strictEqual(state.players[uid].cards.length, 14, "hand=14 after discard");
  }
  return {turns, winner: state.winner};
}

// ── הרצה ──────────────────────────────────────────────────────────────
let games = 0; let wins = 0; let draws = 0; let maxTurns = 0; let sumTurns = 0;
const N = Number(process.env.GAMES || 3000);
for (let s = 1; s <= N; s++) {
  const nP = 2 + (s % 3); // 2..4 שחקנים
  const r = playGame(s, nP);
  games++; sumTurns += r.turns; maxTurns = Math.max(maxTurns, r.turns);
  if (r.winner) wins++; else draws++;
}
console.log(`ramiEngine self-play: ${games} games OK`);
console.log(`  wins=${wins}  pot-draws=${draws}  avgTurns=${(sumTurns / games).toFixed(1)}  maxTurns=${maxTurns}`);
console.log("  ✓ tile-conservation held every step (no excess, always 106)");
console.log("  ✓ no game exceeded the freeze bound");
console.log("  ✓ every winner went out with a genuinely complete hand");

// בדיקות-מהלך שליליות (המנוע דוחה מהלך פסול)
(function negative() {
  const st = E.deal(["a", "b"], rngFrom(42));
  const code = (c) => (e) => e && e.code === c;
  assert.throws(() => E.applyDiscard(st, "a", st.players.a.cards[0].id), code("must_draw_first"), "discard before draw rejected");
  assert.throws(() => E.applyDraw(st, "b", "deck"), code("not_your_turn"), "off-turn draw rejected");
  E.applyDraw(st, "a", "deck");
  assert.throws(() => E.applyDraw(st, "a", "deck"), code("already_drew"), "double draw rejected");
  assert.throws(() => E.applyGoOut(st, "a", st.players.a.cards[0].id), code("not_complete"), "bogus go-out rejected");
  console.log("  ✓ illegal moves rejected (off-turn / double-draw / discard-first / bogus go-out)");
})();

console.log("\nramiEngine: ALL OK");
