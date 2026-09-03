/**
 * Rami (closed rummy) bot benchmark — DUPLICATE games, no Firestore.
 *   node rami.bench.js [pairs=60] [budgetMs=40] [matchups=all|self|v2old|v2human|peek]
 *
 * Duplicate protocol: one seeded randomness stream per pair. Every pair plays
 * the SAME shuffled deck twice with the seats swapped, and each seat owns its
 * own seeded RNG stream, so a brain playing itself must read exactly 0.00.
 * Reported: mean paired score for the first policy (+1 = won both games,
 * 0 = split, −1 = lost both) ± 95% CI, plus raw win %.
 *
 * Policies: v2 (ramiBrain.js) · old (v161 client brain, ported 1:1) ·
 *           human (solid greedy player) · v2peek (v2 seeing the opponents' hands —
 *           the production default).
 */
"use strict";
const B = require("./ramiBrain");
const args = process.argv.slice(2);
const PAIRS = Number(args[0]) || 60;
const BUDGET = Number(args[1]) || 40;
const ONLY = args[2] || "all";
const COLORS = B.COLORS;
const isJ = (t) => t && t.val === "☻";
const bestPartition = B.bestPartition;

/* ---------- seeded RNG (mulberry32) ---------- */
const mulberry = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
let R = Math.random; // the CURRENT seat's stream — every policy draws randomness from here
// Virtual clock: the brain's search is time-boxed, so a real clock would make the
// amount of search (and RNG consumed) nondeterministic. Each clock read = 1 tick;
// BUDGET is therefore "ticks of search", identical in both games of a pair.
let tick = 0;
// BUDGET = rollouts per candidate (maxRounds); the virtual clock never expires.
const brain = B.create({ rnd: () => R(), now: () => (tick += 1), maxRounds: BUDGET });

let idc = 0;
const mkDeck = (rng) => {
  const d = [];
  for (let s = 0; s < 2; s++) for (let c = 0; c < 4; c++) for (let v = 1; v <= 13; v++) d.push({ id: "t" + (idc++), val: v, color: COLORS[c] });
  d.push({ id: "j" + (idc++), val: "☻", color: "#ef4444" }); d.push({ id: "j" + (idc++), val: "☻", color: "#0c1322" });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
};
const reshuffle = (S) => { if (S.deck.length) return; const top = S.discard.pop(); const rest = S.discard.splice(0); for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(S.rng() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; } S.deck.push(...rest); if (top) S.discard.push(top); };
const tval = (t) => (isJ(t) ? 30 : Number(t.val));

/* ---------- old client brain (v161), ported ---------- */
function oldStep(S, uid, hand15) {
  const hand = hand15 || S.players[uid].cards;
  const jVal = isJ, idKey = (t) => (t && !jVal(t)) ? `${t.val}.${t.color}` : null;
  const gone = {}; const addGone = (t) => { const k = idKey(t); if (k) gone[k] = (gone[k] || 0) + 1; };
  for (const t of S.players[uid].cards) addGone(t); for (const d of S.discard) addGone(d);
  const unseenPool = Math.max(1, 106 - S.players[uid].cards.length - S.discard.length);
  const availProb = (k) => { if (!k) return 0; const left = Math.max(0, 2 - (gone[k] || 0)); return Math.min(1, (left / unseenPool) * 10); };
  const prog = Math.min(1, S.discard.length / 55);
  const hot = {}; const bump = (v, c, w) => { if (v >= 1 && v <= 13) hot[`${v}.${c}`] = (hot[`${v}.${c}`] || 0) + w; };
  const bumpSet = (v, c, w) => { for (const cc of COLORS) if (cc !== c) bump(v, cc, 3 * w); bump(v - 1, c, 4 * w); bump(v + 1, c, 4 * w); bump(v - 2, c, 2 * w); bump(v + 2, c, 2 * w); bump(v, c, 2 * w); };
  let threat = 0;
  for (const [u, p] of Object.entries(S.players)) { if (u === uid) continue; const picks = p.picked || []; const closeness = Math.min(1, 0.16 * picks.length + prog * 0.6); threat = Math.max(threat, closeness); const base = 0.5 + closeness * 1.2; picks.forEach((t, i) => { if (jVal(t)) return; bumpSet(Number(t.val), t.color, base * (i >= picks.length - 3 ? 1.6 : 1)); }); }
  for (const [u, p] of Object.entries(S.players)) { if (u === uid) continue; for (const t of (p.passed || [])) { if (jVal(t)) continue; const k = `${t.val}.${t.color}`; if (hot[k]) hot[k] = Math.max(0, hot[k] - 3); } }
  const completionDist = (leftover) => {
    const L = (leftover || []).filter((t) => t && !jVal(t)); const jok = (leftover || []).filter((t) => t && jVal(t)).length;
    const used = new Array(L.length).fill(false); let dist = 0;
    for (let i = 0; i < L.length; i++) { if (used[i]) continue; let bestJ = -1, bestProb = -1;
      for (let j = i + 1; j < L.length; j++) { if (used[j]) continue; const a = L[i], b = L[j], va = Number(a.val), vb = Number(b.val); let prob = null;
        if (va === vb && a.color !== b.color) { for (const cc of COLORS) if (cc !== a.color && cc !== b.color) prob = Math.max(prob || 0, availProb(`${va}.${cc}`)); }
        else if (a.color === b.color) { const d = Math.abs(va - vb); if (d === 1) { const lo = Math.min(va, vb), hi = Math.max(va, vb); prob = Math.max(availProb(`${lo - 1}.${a.color}`), availProb(`${hi + 1}.${a.color}`)); } else if (d === 2) prob = availProb(`${(va + vb) / 2}.${a.color}`); }
        if (prob != null && prob > bestProb) { bestProb = prob; bestJ = j; } }
      if (bestJ >= 0) { used[i] = used[bestJ] = true; dist += 1 + (1 - Math.max(0, bestProb)) * 1.2; } }
    let singles = 0; for (let i = 0; i < L.length; i++) if (!used[i]) singles++;
    dist += singles * 2; return Math.max(0, dist - jok * 1.5);
  };
  const scoreHand = (h) => { const p = bestPartition(h); return { score: completionDist(p.leftover), complete: p.complete }; };
  const defCap = 1.5 + threat * threat * 8;
  const dangerOf = (tile) => { if (!tile) return 0; if (jVal(tile)) return 40; const k = idKey(tile); if ((2 - (gone[k] || 0)) <= 0) return -1.5; let dg = (hot[k] || 0) * (0.25 + 0.6 * threat); dg = Math.min(defCap, dg); const v = Number(tile.val); if (v === 1 || v === 13) dg -= 0.4; return dg; };
  const bestAfter = (cards15) => { let best = { fin: Infinity, drop: null, rest: null, complete: false, raw: Infinity };
    for (let i = 0; i < cards15.length; i++) { const rest = cards15.slice(0, i).concat(cards15.slice(i + 1)); const s = scoreHand(rest); if (s.complete) return { fin: -1, drop: cards15[i], rest, complete: true, raw: 0 }; const fin = s.score + dangerOf(cards15[i]); if (fin < best.fin) best = { fin, drop: cards15[i], rest, complete: false, raw: s.score }; }
    return best; };
  const unseenBag = []; for (let v = 1; v <= 13; v++) for (const c of COLORS) { const r = 2 - (gone[`${v}.${c}`] || 0); for (let k = 0; k < r; k++) unseenBag.push({ val: v, color: c }); }
  { let js = 0; for (const t of S.players[uid].cards) if (jVal(t)) js++; for (const d of S.discard) if (d && jVal(d)) js++; for (let k = 0; k < Math.max(0, 2 - js); k++) unseenBag.push({ val: "☻", color: "#ef4444" }); }
  const simStep = (cards15) => { const p0 = bestPartition(cards15); const leftover = p0.leftover || []; if (!leftover.length) return { complete: false, rest: cards15.slice(1) }; let best = { dist: Infinity, rest: null }; for (const L of leftover) { const rest = cards15.filter((x) => x !== L); const pr = bestPartition(rest); if (pr.complete) return { complete: true, rest }; const d = completionDist(pr.leftover); if (d < best.dist) best = { dist: d, rest }; } return { complete: false, rest: best.rest || cards15.filter((x) => x !== leftover[0]) }; };
  const ROLL_R = 4, ROLL_D = 2;
  const rollout = (hand14) => { if (unseenBag.length < 2) return completionDist(bestPartition(hand14).leftover); let total = 0; for (let s = 0; s < ROLL_R; s++) { let h = hand14, turns = ROLL_D + 1; for (let d = 1; d <= ROLL_D; d++) { const t = unseenBag[(R() * unseenBag.length) | 0]; const st = simStep([...h, t]); if (st.complete) { turns = d; break; } h = st.rest; } total += turns; } return total / ROLL_R; };
  const refineDiscard = (cards15) => { const cands = []; for (let i = 0; i < cards15.length; i++) { const rest = cards15.slice(0, i).concat(cards15.slice(i + 1)); const p = bestPartition(rest); if (p.complete) return { complete: true, drop: cards15[i], rest }; cands.push({ drop: cards15[i], rest, dist: completionDist(p.leftover) }); } cands.sort((a, b) => a.dist - b.dist); let best = null, bestV = Infinity; for (let i = 0; i < Math.min(3, cands.length); i++) { const c = cands[i]; const v = rollout(c.rest) + dangerOf(c.drop) * 0.6; if (v < bestV) { bestV = v; best = { complete: false, drop: c.drop, rest: c.rest }; } } return best; };
  if (!hand15) { const top = S.discard[S.discard.length - 1]; const base = scoreHand(hand); const takeB = top ? bestAfter([...hand, top]) : null; return { take: takeB && (takeB.complete || takeB.raw < base.score - 0.5) ? "discard" : "deck" }; }
  const chosen = bestAfter(hand15);
  if (chosen.complete) return { drop: chosen.drop };
  const ref = refineDiscard(hand15);
  return { drop: ref && ref.drop ? ref.drop : chosen.drop };
}

/* ---------- policies ---------- */
const POL = {
  v2: {
    draw: (S, uid) => brain.decideDraw({ hand: S.players[uid].cards, discard: S.discard, players: S.players, me: uid, budgetMs: 1e9 }).take,
    discard: (S, uid, h15) => brain.decideDiscard({ discard: S.discard, players: S.players, me: uid, budgetMs: 1e9 }, h15).drop,
  },
  v2peek: {
    draw: (S, uid) => brain.decideDraw({ hand: S.players[uid].cards, discard: S.discard, players: S.players, me: uid, budgetMs: 1e9, peek: peekOf(S, uid) }).take,
    discard: (S, uid, h15) => brain.decideDiscard({ discard: S.discard, players: S.players, me: uid, budgetMs: 1e9, peek: peekOf(S, uid) }, h15).drop,
  },
  old: { draw: (S, uid) => oldStep(S, uid, null).take, discard: (S, uid, h15) => oldStep(S, uid, h15).drop },
  human: {
    draw(S, uid) {
      const hand = S.players[uid].cards, top = S.discard[S.discard.length - 1];
      if (!top) return "deck";
      const h15 = hand.concat([top]);
      if (B.goOutTile(h15)) return "discard";
      const before = bestPartition(hand), after = bestPartition(h15);
      if (after.leftoverPoints + tval(top) < before.leftoverPoints) return "discard";
      const lonely = before.leftover.filter((t) => !isJ(t));
      if (!isJ(top) && lonely.some((t) => (Number(t.val) === Number(top.val) && t.color !== top.color) || (t.color === top.color && Math.abs(Number(t.val) - Number(top.val)) <= 2))) return R() < 0.7 ? "discard" : "deck";
      return "deck";
    },
    discard(S, uid, h15) {
      const go = B.goOutTile(h15); if (go) return go;
      const p = bestPartition(h15);
      const L = p.leftover.filter((t) => !isJ(t));
      if (!L.length) return h15.find((t) => !isJ(t)) || h15[0];
      let best = null, bestS = -Infinity;
      for (const t of L) { let conn = 0; for (const o of h15) { if (o === t || isJ(o)) continue; if (Number(o.val) === Number(t.val) && o.color !== t.color) conn += 3; if (o.color === t.color && Math.abs(Number(o.val) - Number(t.val)) <= 2) conn += 2; } const s = -conn * 10 + Number(t.val); if (s > bestS) { bestS = s; best = t; } }
      return best;
    },
  },
};
const peekOf = (S, uid) => { const o = {}; for (const u of Object.keys(S.players)) if (u !== uid) o[u] = S.players[u].cards; return o; };

/* ---------- one game on a given deck with per-seat RNG streams ---------- */
function playGame(seatPolicies, seed) {
  const d = mkDeck(mulberry(seed * 7919 + 1));
  const seatRng = seatPolicies.map((_, i) => mulberry(seed * 7919 + 100 + i));
  const S = { deck: d, discard: [], players: {}, rng: mulberry(seed * 7919 + 50) };
  const uids = seatPolicies.map((_, i) => "s" + i);
  uids.forEach((u, i) => { S.players[u] = { cards: d.splice(0, 14), policy: seatPolicies[i], picked: [], passed: [], threw: [] }; });
  S.discard.push(d.pop());
  let turn = 0, n = 0;
  while (n++ < 400) {
    const i = turn, uid = uids[i]; const P = POL[S.players[uid].policy]; const me = S.players[uid];
    R = seatRng[i];
    const top = S.discard[S.discard.length - 1];
    const take = P.draw(S, uid);
    let tile;
    if (take === "discard" && top) { tile = S.discard.pop(); me.picked.push(tile); me.picked = me.picked.slice(-8); }
    else { reshuffle(S); tile = S.deck.pop(); if (top) { me.passed.push(top); me.passed = me.passed.slice(-8); } }
    if (!tile) return null;
    const h15 = me.cards.concat([tile]);
    const drop = P.discard(S, uid, h15);
    const rest = h15.filter((x) => x !== drop);
    if (rest.length !== 14) throw new Error("bad discard by " + me.policy);
    me.cards = rest; S.discard.push(drop); me.threw.push(drop); me.threw = me.threw.slice(-6);
    if (bestPartition(rest).complete) return { winnerSeat: i, turns: n };
    turn = (turn + 1) % uids.length;
  }
  return null;
}

/* ---------- duplicate matchup: A vs B ---------- */
function duplicate(label, A, Bp, pairs) {
  const t0 = Date.now(); const scores = []; let winsA = 0, games = 0, turns = 0;
  for (let p = 0; p < pairs; p++) {
    const seed = 1000 + p;
    const g1 = playGame([A, Bp], seed); // A in seat 0
    const g2 = playGame([Bp, A], seed); // A in seat 1, same deck, same seat streams
    if (!g1 || !g2) continue;
    const a1 = g1.winnerSeat === 0 ? 1 : 0, a2 = g2.winnerSeat === 1 ? 1 : 0;
    scores.push(a1 + a2 - 1); winsA += a1 + a2; games += 2; turns += g1.turns + g2.turns;
  }
  const n = scores.length; const mean = scores.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(scores.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, n - 1));
  const ci = 1.96 * sd / Math.sqrt(n);
  console.log(`${label}: paired score ${mean >= 0 ? "+" : ""}${mean.toFixed(2)} ± ${ci.toFixed(2)} (95% CI, ${n} pairs) · ${A} wins ${(winsA / games * 100).toFixed(0)}% · avg ${(turns / games).toFixed(1)} turns · ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

console.log(`rami duplicate bench — brain v${B.VERSION}, budget ${BUDGET}ms/decision, ${PAIRS} pairs\n`);
if (ONLY === "all" || ONLY === "self") duplicate("SELF v2 vs v2 (must be 0.00)", "v2", "v2", Math.min(PAIRS, 12));
if (ONLY === "all" || ONLY === "v2old") duplicate("v2 vs old", "v2", "old", PAIRS);
if (ONLY === "all" || ONLY === "v2human") duplicate("v2 vs human", "v2", "human", PAIRS);
if (ONLY === "all" || ONLY === "oldhuman") duplicate("old vs human", "old", "human", PAIRS);
if (ONLY === "all" || ONLY === "peek") duplicate("v2peek (sees hands, production default) vs human", "v2peek", "human", PAIRS);
