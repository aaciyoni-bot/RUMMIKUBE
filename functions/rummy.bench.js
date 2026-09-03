/**
 * Rummikub (open game) solver benchmark — random positions, deterministic.
 *   node rummy.bench.js [positions=300] [seed=1]
 * For each position (a valid table + a 14-tile rack) compares tiles placed by:
 *   heuristic — the current bot plan (partition of the rack → new melds, then
 *               single-tile extensions, then repeated "steals"), i.e. what the
 *               bot does today after its first meld
 *   solver    — full table re-arrangement (rummySolver.js)
 * Every solver result is checked: all groups valid, every table tile still on
 * the table, placed tiles came from the rack.
 */
"use strict";
const B = require("./ramiBrain");
const S = require("./rummySolver");
const args = process.argv.slice(2);
const N = Number(args[0]) || 300;
const SEED = Number(args[1]) || 1;
const COLORS = S.COLORS;
const isJ = (t) => t && t.val === "☻";
const mulberry = (seed) => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
let idc = 0;
const deck = (rng) => {
  const d = [];
  for (let s = 0; s < 2; s++) for (let c = 0; c < 4; c++) for (let v = 1; v <= 13; v++) d.push({ id: "t" + (idc++), val: v, color: COLORS[c] });
  d.push({ id: "j" + (idc++), val: "☻", color: "#ef4444" }); d.push({ id: "j" + (idc++), val: "☻", color: "#0c1322" });
  for (let i = d.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
};
/* heuristic plan (port of botPlanMove after the first meld, with repeated steals) */
function heuristic(rack, board) {
  const tiles = rack.slice();
  const bp = B.bestPartition(tiles);
  const melds = bp.melds || [];
  const used = new Set(melds.flat().map((t) => t.id));
  let pool = tiles.filter((t) => !used.has(t.id) && !isJ(t));
  const groups = board.map((g) => g.slice());
  let moved = true;
  while (moved) { moved = false; for (const t of pool) { for (const g of groups) { if (g.length >= 13) continue; if (B.validateGroup(g.concat([t]))) { g.push(t); pool = pool.filter((x) => x !== t); moved = true; break; } } if (moved) break; } }
  melds.forEach((m) => groups.push(m.slice()));
  // steals
  for (let sN = 0; sN < 5; sN++) {
    let done = false;
    const wants = [];
    for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
      const a = pool[i], b = pool[j], av = Number(a.val), bv = Number(b.val);
      if (av === bv && a.color !== b.color) wants.push({ a, b, type: "set", val: av, not: [a.color, b.color] });
      else if (a.color === b.color && av !== bv) { const lo = Math.min(av, bv), hi = Math.max(av, bv); if (hi - lo === 1) { if (lo > 1) wants.push({ a, b, type: "run", val: lo - 1, color: a.color }); if (hi < 13) wants.push({ a, b, type: "run", val: hi + 1, color: a.color }); } else if (hi - lo === 2) wants.push({ a, b, type: "run", val: lo + 1, color: a.color }); }
    }
    for (const w of wants) { for (const g of groups) { for (let k = 0; k < g.length; k++) { const t = g[k]; if (isJ(t) || Number(t.val) !== w.val) continue; if (w.type === "set" ? w.not.includes(t.color) : t.color !== w.color) continue; const rest = g.slice(); rest.splice(k, 1); if (rest.length < 3 || !B.validateGroup(rest)) continue; const meld = [w.a, w.b, t]; if (!B.validateGroup(meld)) continue; g.length = 0; g.push(...rest); groups.push(meld); pool = pool.filter((x) => x !== w.a && x !== w.b); done = true; break; } if (done) break; } if (done) break; }
    if (!done) break;
  }
  const placed = rack.length - pool.length - tiles.filter((t) => isJ(t) && !used.has(t.id)).length;
  return { placed, groups };
}
function check(board, rack, res) {
  if (!res) return "null";
  for (const g of res.groups) if (!B.validateGroup(g)) return "invalid group " + g.map((t) => t.val).join(",");
  const onTable = new Set(res.groups.flat().map((t) => t.id));
  for (const t of board.flat()) if (!onTable.has(t.id)) return "table tile lost";
  const rackIds = new Set(rack.map((t) => t.id));
  for (const t of res.placed) if (!rackIds.has(t.id)) return "placed a non-rack tile";
  const cnt = {}; res.groups.flat().forEach((t) => { cnt[t.id] = (cnt[t.id] || 0) + 1; if (cnt[t.id] > 1) throw new Error("dup"); });
  return null;
}
let sumH = 0, sumS = 0, better = 0, worse = 0, bad = 0, ms = 0, worst = 0;
const rng = mulberry(SEED);
for (let p = 0; p < N; p++) {
  const d = deck(rng);
  // table: melds from a random 24-30 tile draw; rack: 14 tiles
  const tbl = d.splice(0, 24 + Math.floor(rng() * 7));
  const board = B.bestPartition(tbl).melds;
  const rack = d.splice(0, 14);
  const h = heuristic(rack, board);
  const t0 = Date.now();
  const s = S.solve(board.flat(), rack);
  const dt = Date.now() - t0; ms += dt; if (dt > worst) worst = dt;
  const err = check(board, rack, s);
  if (err) { bad++; if (bad <= 3) console.log("  ✗ position", p, err); continue; }
  sumH += h.placed; sumS += s.placed.length;
  if (s.placed.length > h.placed) better++; else if (s.placed.length < h.placed) worse++;
}
console.log(`rummy solver bench — ${N} positions (seed ${SEED})`);
console.log(`  heuristic (current bot): ${(sumH / (N - bad)).toFixed(2)} rack tiles placed / turn`);
console.log(`  solver (full re-arrangement): ${(sumS / (N - bad)).toFixed(2)} rack tiles placed / turn`);
console.log(`  solver better in ${better}, worse in ${worse}, invalid ${bad} · avg ${(ms / N).toFixed(1)}ms, worst ${worst}ms`);
