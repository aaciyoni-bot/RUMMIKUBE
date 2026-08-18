/**
 * Rummikub bot tests — runs the REAL functions out of index.html (extracted
 * between the BOT-BRAIN markers plus the rule helpers they lean on), so there
 * is one source of truth and the tests cannot drift from the app.
 *
 * Run: node bot.test.js
 */
"use strict";
const fs = require("fs");
const assert = require("assert");

const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const cut = (from, to) => {
  const a = html.indexOf(from);
  const b = html.indexOf(to, a);
  assert.ok(a >= 0 && b > a, `could not find ${from}`);
  return html.slice(a, b);
};
// the rule helpers the brain calls
const rules = cut("        const validateGroup = (group)", "        const buildDeal =") +
  cut("        // מיון אוטומטי בתוך קבוצה", "        /* ===== BOT-BRAIN-START");
const brain = cut("        /* ===== BOT-BRAIN-START", "        /* ===== BOT-BRAIN-END");
const API = new Function("FIRST_MELD_MIN", rules + brain +
  "\nreturn {validateGroup, groupPoints, rkChooseMelds, rkLayOff, rkBotTurn, rkRunsFrom, rkSetsFrom};")(30);

const J = "☻";
const RED = "#ef4444"; const BLU = "#3b82f6"; const ORA = "#f59e0b"; const BLK = "#0c1322";
let n = 0;
const T = (color, val, tag) => ({id: `${tag || "t"}${n++}`, val, color});
const rack = (...tiles) => { const r = tiles.slice(); while (r.length < 28) r.push(null); return r; };
const show = (g) => g.map((t) => (t.val === J ? "J" : t.val) + t.color.slice(1, 2)).join(",");

let pass = 0; let fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log("PASS  " + name); } else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
};

// ---- 1. opening hand worth well over 30 must be played -------------------
{
  const r = rack(T(RED, 10), T(BLU, 10), T(ORA, 10), T(BLK, 3), T(RED, 7));
  const out = API.rkBotTurn(r, [], false);
  check("opens with a 30-point set (10-10-10)", !!out && out.board.length === 1 && out.played === 3,
    out ? "played " + out.played : "returned null");
  if (out) check("  the meld it laid is legal", API.validateGroup(out.board[0].tiles), show(out.board[0].tiles));
  if (out) check("  the played tiles left the rack", out.rack.filter(Boolean).length === 2);
}

// ---- 2. a hand that cannot reach 30 must NOT open ------------------------
{
  const r = rack(T(RED, 1), T(BLU, 1), T(ORA, 1), T(BLK, 5));
  const out = API.rkBotTurn(r, [], false);
  check("refuses to open on 3 points (1-1-1)", out === null, out ? "played anyway: " + out.played : "");
}

// ---- 3. a run of three tens+ is a legal opening --------------------------
{
  const r = rack(T(RED, 11), T(RED, 12), T(RED, 13), T(BLU, 2));
  const out = API.rkBotTurn(r, [], false);
  check("opens with a run 11-12-13", !!out && out.played === 3, out ? "" : "returned null");
  if (out) check("  the run is legal", API.validateGroup(out.board[0].tiles), show(out.board[0].tiles));
}

// ---- 4. joker bridges a gap ---------------------------------------------
{
  const r = rack(T(RED, 9), T(RED, 11), T(RED, 12), T(RED, J, "j"));
  const out = API.rkBotTurn(r, [], false);
  check("uses the joker to bridge 9_11-12", !!out && out.played >= 3, out ? show(out.board[0].tiles) : "returned null");
  if (out) check("  joker run is legal", API.validateGroup(out.board[0].tiles), show(out.board[0].tiles));
}

// ---- 5. after opening, lay a single tile onto a meld on the table --------
{
  const board = [{id: "g1", x: 30, y: 30, tiles: [T(BLU, 5), T(BLU, 6), T(BLU, 7)]}];
  const r = rack(T(BLU, 8), T(RED, 2));
  const out = API.rkBotTurn(r, board, true);
  check("lays 8 onto an existing 5-6-7 run", !!out && out.board[0].tiles.length === 4,
    out ? show(out.board[0].tiles) : "returned null");
  if (out) check("  the extended run is legal", API.validateGroup(out.board[0].tiles));
}

// ---- 6. never breaks a meld on the table ---------------------------------
{
  const board = [{id: "g1", x: 30, y: 30, tiles: [T(BLU, 5), T(BLU, 6), T(BLU, 7)]}];
  const before = board[0].tiles.length;
  const out = API.rkBotTurn(rack(T(RED, 2)), board, true);
  const after = out ? out.board[0].tiles.length : before;
  check("leaves a meld it cannot use alone", after >= before, `was ${before}, now ${after}`);
}

// ---- 7. nothing playable at all -> draw ---------------------------------
{
  const out = API.rkBotTurn(rack(T(RED, 2), T(BLU, 5), T(ORA, 9)), [], true);
  check("draws when it has nothing", out === null, out ? "played " + out.played : "");
}

// ---- 8. every meld the bot ever creates must be legal --------------------
{
  const COLORS = [RED, BLU, ORA, BLK];
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  let illegal = 0; let turnsPlayed = 0; let hands = 0;
  for (let i = 0; i < 400; i++) {
    const deck = [];
    for (let s = 0; s < 2; s++) for (const c of COLORS) for (let v = 1; v <= 13; v++) deck.push(T(c, v));
    deck.push(T(RED, J, "j"), T(BLK, J, "j"));
    for (let k = deck.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [deck[k], deck[j]] = [deck[j], deck[k]]; }
    const r = rack(...deck.slice(0, 14));
    hands++;
    const out = API.rkBotTurn(r, [], rnd() < 0.5);
    if (!out) continue;
    turnsPlayed++;
    out.board.forEach((g) => { if (!API.validateGroup(g.tiles)) { illegal++; console.log("    illegal: " + show(g.tiles)); } });
    // tiles must be conserved: what left the rack is exactly what reached the board
    const boardIds = new Set(out.board.flatMap((g) => g.tiles.map((t) => t.id)));
    const goneFromRack = r.filter(Boolean).filter((t) => !out.rack.some((x) => x && x.id === t.id));
    if (goneFromRack.some((t) => !boardIds.has(t.id))) illegal++;
  }
  check(`400 random hands: every meld legal, no tile lost (played ${turnsPlayed}/${hands})`, illegal === 0, `${illegal} faults`);
  check("  the bot actually plays a reasonable share of hands", turnsPlayed > hands * 0.25,
    `only ${turnsPlayed}/${hands}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
