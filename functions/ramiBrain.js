/* RUMMIKUBE — Rami (closed rummy) bot brain v2 (SHARED MODULE)
 *
 * This exact text lives in TWO places and must stay byte-identical:
 *   • functions/ramiBrain.js              — required by the server bot engine (botStepTx)
 *   • index.html <script id="rami-brain"> — used by the client bot driver (RamiTable)
 * `node sync-rami-brain.js` regenerates the inline copy; `--check` fails if they drift.
 *
 * Information: by default (botsPeek !== false) the bot sees the opponents' hands
 * (ctx.peek) and plays a perfect-information race. With botsPeek:false on the
 * table it uses only what a human at the table can see — its own hand, the
 * discard pile, and every opponent's visible picks / refusals / discards.
 *
 * Rules (Rami): 106 tiles (2 × 13 values × 4 colours + 2 jokers), 14-tile hand.
 * A turn = draw one tile (deck or discard top) then discard one. You win by
 * having 14 tiles fully arranged in sets/runs after the discard. Payout is a
 * fixed stake per loser, so the ONLY objective is to go out first.
 *
 * Engine:
 *   1. Exact partition solver (sets/runs/jokers, "1" high or low) — memoised DP.
 *   2. Tile counting: an "unseen bag" of the identities still possibly drawable.
 *   3. Expected turns-to-go-out by FULL-LENGTH Monte-Carlo rollouts from the
 *      unseen bag (a greedy discard policy plays the hand until it completes).
 *      Common random numbers: every candidate discard — and the deck-vs-pile draw
 *      choice — is judged against the SAME draw sequences, so the comparison is
 *      paired and low-variance. Hard time budget.
 *   4. Opponent model from visible actions: tiles an opponent picked from the pile
 *      (and their neighbours) are hot; tiles they refused or threw are cold;
 *      threat = how close the closest opponent looks. Danger is priced in TURN
 *      units, weighted by threat, so the bot blocks a player who is about to go out.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RamiBotBrain = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var VERSION = 2;
  var COLORS = ['#ef4444', '#3b82f6', '#f59e0b', '#0c1322'];
  var JOK = '☻';
  var isJ = function (t) { return !!t && t.val === JOK; };
  var tv = function (t) { return isJ(t) ? 30 : Number(t.val); };
  var key = function (t) { return isJ(t) ? null : Number(t.val) + '.' + t.color; };

  /* ───────────── rules ───────────── */
  function validateGroup(group) {
    if (!group || group.length < 3) return false;
    var jokers = 0, regs = [];
    for (var i = 0; i < group.length; i++) { if (isJ(group[i])) jokers++; else regs.push(group[i]); }
    if (regs.length === 0) return group.length >= 3;
    if (group.length > 13) return false;
    var isSet = function () {
      if (group.length > 4) return false;
      var seen = {};
      for (var k = 0; k < regs.length; k++) { if (regs[k].val !== regs[0].val) return false; if (seen[regs[k].color]) return false; seen[regs[k].color] = 1; }
      return true;
    };
    var isRun = function () {
      for (var k = 0; k < regs.length; k++) if (regs[k].color !== regs[0].color) return false;
      var nums = regs.map(function (t) { return Number(t.val); });
      var tryRun = function (vals) {
        var s = vals.slice().sort(function (a, b) { return a - b; });
        for (var q = 1; q < s.length; q++) if (s[q] === s[q - 1]) return false;
        var gaps = 0;
        for (var q2 = 0; q2 < s.length - 1; q2++) gaps += (s[q2 + 1] - s[q2] - 1);
        if (gaps > jokers) return false;
        var extra = jokers - gaps;
        return (14 - s[s.length - 1]) + (s[0] - 1) >= extra;
      };
      if (tryRun(nums)) return true;
      var ones = 0; for (var q3 = 0; q3 < nums.length; q3++) if (nums[q3] === 1) ones++;
      if (ones === 1 && tryRun(nums.map(function (v) { return v === 1 ? 14 : v; }))) return true;
      return false;
    };
    return isSet() || isRun();
  }

  // Exact partition: melds that minimise the point value of what is left over.
  function bestPartition(hand) {
    var tiles = (hand || []).filter(Boolean).slice().sort(function (a, b) {
      var ja = isJ(a) ? 1 : 0, jb = isJ(b) ? 1 : 0;
      if (ja !== jb) return ja - jb;
      if (ja) return 0;
      return Number(a.val) - Number(b.val) || COLORS.indexOf(a.color) - COLORS.indexOf(b.color);
    });
    var keyOf = function (arr) { return arr.map(function (t) { return isJ(t) ? 'J' : t.val + '.' + t.color; }).sort().join('|'); };
    var memo = {};
    var cands = function (arr) {
      var out = [], a = arr[0], jokerIdx = [], i;
      for (i = 1; i < arr.length; i++) if (isJ(arr[i])) jokerIdx.push(i);
      var J = jokerIdx.length;
      if (isJ(a)) {
        var jall = []; for (i = 0; i < arr.length; i++) if (isJ(arr[i])) jall.push(i);
        if (jall.length >= 3) for (var s = 3; s <= jall.length; s++) out.push(jall.slice(0, s));
        return out;
      }
      var v = Number(a.val), c = a.color;
      var sameVal = [], seen = {}; seen[c] = 1;
      for (i = 1; i < arr.length; i++) { var t = arr[i]; if (!isJ(t) && Number(t.val) === v && !seen[t.color]) { sameVal.push(i); seen[t.color] = 1; } }
      for (var k = 0; k <= sameVal.length; k++) for (var j = 0; j <= J; j++) {
        var size = 1 + k + j; if (size < 3 || size > 4) continue;
        var idx = [0].concat(sameVal.slice(0, k), jokerIdx.slice(0, j));
        if (validateGroup(idx.map(function (q) { return arr[q]; }))) out.push(idx);
      }
      var byVal = {};
      for (i = 1; i < arr.length; i++) { var t2 = arr[i]; if (!isJ(t2) && t2.color === c) { var vv = Number(t2.val); if (byVal[vv] == null) byVal[vv] = i; } }
      var runs = function (loStart, hiEnd, top) {
        for (var lo = loStart; lo <= (top ? 12 : v); lo++) for (var hi = (top ? 13 : v); hi <= hiEnd; hi++) {
          var len = hi - lo + 1 + (top ? 1 : 0); if (len < 3 || len > 13) continue;
          var missing = 0, idx2 = [0];
          for (var val = lo; val <= hi; val++) { if (!top && val === v) continue; if (byVal[val] != null) idx2.push(byVal[val]); else missing++; }
          if (missing > J) continue;
          for (var jj = 0; jj < missing; jj++) idx2.push(jokerIdx[jj]);
          var meld = idx2.map(function (q) { return arr[q]; });
          if (meld.length >= 3 && validateGroup(meld)) out.push(idx2.slice());
        }
      };
      runs(1, 13, false);
      if (v === 1) runs(2, 13, true); // "1" high: 12-13-1
      return out;
    };
    var solve = function (arr) {
      if (arr.length === 0) return { pts: 0, melds: [], leftover: [] };
      var kk = keyOf(arr); if (memo[kk]) return memo[kk];
      var subA = solve(arr.slice(1));
      var best = { pts: subA.pts + tv(arr[0]), melds: subA.melds, leftover: [arr[0]].concat(subA.leftover) };
      var cs = cands(arr);
      for (var i = 0; i < cs.length; i++) {
        var used = {}; for (var u = 0; u < cs[i].length; u++) used[cs[i][u]] = 1;
        var meld = cs[i].map(function (q) { return arr[q]; });
        var sub = solve(arr.filter(function (_, q) { return !used[q]; }));
        if (sub.pts < best.pts) best = { pts: sub.pts, melds: [meld].concat(sub.melds), leftover: sub.leftover };
        if (best.pts === 0) break;
      }
      memo[kk] = best; return best;
    };
    var r = solve(tiles);
    return { melds: r.melds, leftover: r.leftover, leftoverPoints: r.pts, complete: r.pts === 0 && tiles.length > 0 };
  }

  // 15 tiles: which tile can be discarded to leave a complete 14? (null if none)
  function goOutTile(hand15, prefer) {
    var tiles = (hand15 || []).filter(Boolean);
    if (tiles.length < 2) return null;
    var p = bestPartition(tiles);
    if (p.leftover.length > 1) return null;
    var opts = [];
    if (p.leftover.length === 1) opts.push(p.leftover[0]);
    else for (var i = 0; i < p.melds.length; i++) {
      var m = p.melds[i];
      if (m.length >= 4) for (var k = 0; k < m.length; k++) { var rest = m.slice(0, k).concat(m.slice(k + 1)); if (validateGroup(rest)) opts.push(m[k]); }
    }
    if (!opts.length) return null;
    if (prefer) opts.sort(function (a, b) { return prefer(a) - prefer(b); });
    return opts[0];
  }

  /* ───────────── the brain ───────────── */
  function create(env) {
    env = env || {};
    var rnd = env.rnd || Math.random;
    var nowMs = env.now || function () { return Date.now(); };
    var MAX_ROUNDS = env.maxRounds || 24;   // rollouts per candidate (upper bound)
    var MAX_SIM_TURNS = env.maxSimTurns || 14;

    // Everything the bot can legally see, digested once per decision.
    // ctx.peek = { uid: tiles[] } — the opponents' hands (default); then tile
    // counting and danger are exact and the race simulation is used.
    function analyse(ctx) {
      var hand = (ctx.hand || []).filter(Boolean);
      var discard = (ctx.discard || []).filter(Boolean);
      var peek = ctx.peek || null;
      var gone = {};
      var addGone = function (t) { var k = key(t); if (k) gone[k] = (gone[k] || 0) + 1; };
      hand.forEach(addGone); discard.forEach(addGone);
      var jokSeen = hand.filter(isJ).length + discard.filter(isJ).length;
      if (peek) Object.keys(peek).forEach(function (u) { if (u === ctx.me) return; (peek[u] || []).filter(Boolean).forEach(function (t) { addGone(t); if (isJ(t)) jokSeen++; }); });
      var bag = [];
      for (var v = 1; v <= 13; v++) for (var c = 0; c < 4; c++) { var left = 2 - (gone[v + '.' + COLORS[c]] || 0); for (var k = 0; k < left; k++) bag.push({ val: v, color: COLORS[c] }); }
      for (var jj = 0; jj < Math.max(0, 2 - jokSeen); jj++) bag.push({ val: JOK, color: '#ef4444' });
      var unseen = Math.max(1, bag.length);
      var avail = function (k2) { if (!k2) return 0; var left2 = Math.max(0, 2 - (gone[k2] || 0)); return Math.min(1, (left2 / unseen) * 10); };
      // opponent model
      var hot = {}, threat = 0, nOpp = 0;
      var prog = Math.min(1, discard.length / 55);
      var bump = function (v2, c2, w) { if (v2 >= 1 && v2 <= 13) hot[v2 + '.' + c2] = (hot[v2 + '.' + c2] || 0) + w; };
      var bumpSet = function (v2, c2, w) { for (var q = 0; q < 4; q++) if (COLORS[q] !== c2) bump(v2, COLORS[q], 3 * w); bump(v2 - 1, c2, 4 * w); bump(v2 + 1, c2, 4 * w); bump(v2 - 2, c2, 2 * w); bump(v2 + 2, c2, 2 * w); bump(v2, c2, 2 * w); };
      var cool = function (v2, c2, w) { for (var q = 0; q < 4; q++) if (COLORS[q] !== c2) bump(v2, COLORS[q], -1.5 * w); bump(v2 - 1, c2, -2 * w); bump(v2 + 1, c2, -2 * w); bump(v2, c2, -3 * w); };
      var players = ctx.players || {};
      Object.keys(players).forEach(function (u) {
        var p = players[u]; if (u === ctx.me || !p) return;
        nOpp++;
        var picks = (p.picked || []).filter(Boolean);
        var closeness = Math.min(1, 0.16 * picks.length + prog * 0.6);
        if (closeness > threat) threat = closeness;
        var base = 0.5 + closeness * 1.2;
        picks.forEach(function (t, i) { if (isJ(t)) return; bumpSet(Number(t.val), t.color, base * (i >= picks.length - 3 ? 1.6 : 1)); });
        (p.passed || []).filter(Boolean).forEach(function (t) { if (!isJ(t)) cool(Number(t.val), t.color, 0.8); });
        (p.threw || []).filter(Boolean).forEach(function (t, i, arr) { if (!isJ(t)) cool(Number(t.val), t.color, i >= arr.length - 2 ? 1 : 0.6); });
      });
      Object.keys(hot).forEach(function (k3) { if (hot[k3] < 0) hot[k3] = 0; });
      var A = { hand: hand, discard: discard, gone: gone, bag: bag, avail: avail, hot: hot, threat: threat, nOpp: nOpp, prog: prog, peekHands: null };
      if (peek) {
        A.peekHands = [];
        Object.keys(peek).forEach(function (u) { if (u === ctx.me) return; var h = (peek[u] || []).filter(Boolean); if (h.length) A.peekHands.push({ uid: u, hand: h, p: bestPartition(h) }); });
        var minNeed = Infinity;
        A.peekHands.forEach(function (o) { o.need = needDist(A, o.p); if (o.need < minNeed) minNeed = o.need; });
        if (minNeed < Infinity) A.threat = Math.max(A.threat, Math.min(1, Math.max(0, 1 - minNeed / 6)));
      }
      return A;
    }

    // Danger of handing `tile` to the opponents, in TURN units.
    function dangerTurns(A, tile) {
      if (!tile) return 0;
      if (isJ(tile)) return 6;
      var k = key(tile);
      if (A.peekHands) { // hands known: exact — does this tile finish or advance an opponent?
        var worst = -0.15;
        for (var i = 0; i < A.peekHands.length; i++) {
          var o = A.peekHands[i];
          var h15 = o.hand.concat([tile]);
          if (goOutTile(h15)) { worst = Math.max(worst, 6); continue; }
          var after = needDist(A, bestPartition(h15));
          var gain = Math.max(0, o.need - after);
          var w = o.need <= 2 ? 2.2 : o.need <= 3.5 ? 1.4 : 0.8;
          worst = Math.max(worst, gain * w);
        }
        return Math.min(6, worst);
      }
      if ((2 - (A.gone[k] || 0)) <= 0) return -0.15; // dead identity: nobody can use it
      var d = (A.hot[k] || 0) * (0.06 + 0.22 * A.threat);
      var v = Number(tile.val); if (v === 1 || v === 13) d -= 0.1;
      return Math.max(-0.1, Math.min(2.5, d));
    }

    // Heuristic "tiles still needed" for a partition, availability-weighted. Fast.
    // Drives the greedy policy inside rollouts and the pre-ranking of candidates.
    function needDist(A, p) {
      var L = p.leftover.filter(function (t) { return !isJ(t); });
      var jok = p.leftover.length - L.length;
      var used = [], i, j;
      for (i = 0; i < L.length; i++) used.push(false);
      var dist = 0;
      // (a) a single that extends an existing run with ONE more tile (gap of one)
      for (i = 0; i < L.length; i++) {
        var t = L[i], v = Number(t.val), bestP = -1;
        for (var m = 0; m < p.melds.length; m++) {
          var meld = p.melds[m], regs = meld.filter(function (x) { return !isJ(x); });
          if (!regs.length || meld.length >= 13) continue;
          if (regs[0].color !== t.color) continue;
          var isSet = meld.length <= 4 && regs.every(function (x) { return x.val === regs[0].val; });
          if (isSet) continue;
          var lo = 99, hi = 0;
          for (var q = 0; q < regs.length; q++) { var rv = Number(regs[q].val); if (rv < lo) lo = rv; if (rv > hi) hi = rv; }
          if (v === hi + 2 && hi + 1 <= 13) bestP = Math.max(bestP, A.avail((hi + 1) + '.' + t.color));
          if (v === lo - 2 && lo - 1 >= 1) bestP = Math.max(bestP, A.avail((lo - 1) + '.' + t.color));
        }
        if (bestP >= 0) { used[i] = true; dist += 1 + (1 - bestP) * 1.2; }
      }
      // (b) pairs of leftovers that need one tile
      for (i = 0; i < L.length; i++) {
        if (used[i]) continue;
        var bestJ = -1, bestProb = -1;
        for (j = i + 1; j < L.length; j++) {
          if (used[j]) continue;
          var a = L[i], b = L[j], va = Number(a.val), vb = Number(b.val), prob = null;
          if (va === vb && a.color !== b.color) { for (var q2 = 0; q2 < 4; q2++) if (COLORS[q2] !== a.color && COLORS[q2] !== b.color) prob = Math.max(prob || 0, A.avail(va + '.' + COLORS[q2])); }
          else if (a.color === b.color) {
            var d = Math.abs(va - vb);
            if (d === 1) { var lo2 = Math.min(va, vb), hi2 = Math.max(va, vb); prob = Math.max(lo2 > 1 ? A.avail((lo2 - 1) + '.' + a.color) : 0, hi2 < 13 ? A.avail((hi2 + 1) + '.' + a.color) : 0); }
            else if (d === 2) prob = A.avail(((va + vb) / 2) + '.' + a.color);
          }
          if (prob != null && prob > bestProb) { bestProb = prob; bestJ = j; }
        }
        if (bestJ >= 0) { used[i] = used[bestJ] = true; dist += 1 + (1 - Math.max(0, bestProb)) * 1.2; }
      }
      // (c) singles: two tiles away, a little less when many live neighbours exist
      for (i = 0; i < L.length; i++) {
        if (used[i]) continue;
        var s = L[i], sv = Number(s.val), flex = 0;
        for (var q3 = 0; q3 < 4; q3++) if (COLORS[q3] !== s.color) flex += A.avail(sv + '.' + COLORS[q3]) * 0.5;
        flex += A.avail((sv - 1) + '.' + s.color) * 0.6 + A.avail((sv + 1) + '.' + s.color) * 0.6;
        dist += 2 - 0.4 * Math.min(1, flex / 2);
      }
      return Math.max(0, dist - jok * 1.5);
    }

    // Discard candidates for a 15-hand: every leftover tile, plus removable ends
    // of long melds (they keep the hand complete). Returns [{drop, rest}].
    function candidates(hand15) {
      var p = bestPartition(hand15);
      var out = [];
      var push = function (t) { out.push({ drop: t, rest: hand15.filter(function (x) { return x !== t; }) }); };
      p.leftover.forEach(push);
      for (var i = 0; i < p.melds.length; i++) {
        var m = p.melds[i];
        if (m.length < 4) continue;
        for (var k = 0; k < m.length; k++) { var r = m.slice(0, k).concat(m.slice(k + 1)); if (validateGroup(r)) push(m[k]); }
      }
      if (!out.length) hand15.forEach(push);
      return { p15: p, cands: out };
    }

    // Greedy discard for a simulated 15-hand: ONE solve, then the partition after
    // discarding a leftover tile is the same melds minus that tile; after
    // discarding a meld end it is the shortened meld. Returns the 14-hand.
    function greedyDiscard(A, h15, p) {
      var best = null, bestD = Infinity, i, k;
      for (i = 0; i < p.leftover.length; i++) {
        var L = p.leftover[i];
        var d = needDist(A, { melds: p.melds, leftover: p.leftover.filter(function (x) { return x !== L; }) });
        if (d < bestD) { bestD = d; best = L; }
      }
      for (i = 0; i < p.melds.length; i++) {
        var m = p.melds[i];
        if (m.length < 4) continue;
        for (k = 0; k < m.length; k++) {
          var r = m.slice(0, k).concat(m.slice(k + 1));
          if (!validateGroup(r)) continue;
          var melds2 = p.melds.slice(); melds2[i] = r;
          var d2 = needDist(A, { melds: melds2, leftover: p.leftover });
          if (d2 < bestD) { bestD = d2; best = m[k]; }
        }
      }
      if (!best) best = h15[0];
      return h15.filter(function (x) { return x !== best; });
    }

    // A full-length rollout: play the 14-hand with the given draw sequence until it
    // goes out. Returns the number of draws needed (capped, with a distance tail).
    function rollout(A, hand14, seq) {
      var h = hand14, p = bestPartition(h);
      if (p.complete) return 0;
      var lim = Math.min(MAX_SIM_TURNS, seq.length);
      for (var d = 1; d <= lim; d++) {
        var h15 = h.concat([seq[d - 1]]);
        var p15 = bestPartition(h15);
        if (p15.leftover.length <= 1 && goOutTile(h15)) return d;
        h = greedyDiscard(A, h15, p15);
        p = p15;
      }
      return lim + 1 + needDist(A, bestPartition(h)) * 0.35;
    }
    var shuffledBag = function (A) {
      var b = A.bag.slice();
      for (var i = b.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = b[i]; b[i] = b[j]; b[j] = t; }
      return b;
    };

    // Expected turns for several 14-hands at once, under common random numbers.
    // Returns the mean per hand. Time-boxed: at least one round, at most MAX_ROUNDS.
    function evalHands(A, hands, budgetMs, t0) {
      var sums = hands.map(function () { return 0; }), n = 0;
      while (n < MAX_ROUNDS && (n === 0 || nowMs() - t0 < budgetMs)) {
        var seq = shuffledBag(A);
        for (var i = 0; i < hands.length; i++) sums[i] += rollout(A, hands[i], seq);
        n++;
      }
      return sums.map(function (s) { return s / n; });
    }

    /* ── Perfect-information RACE (botsPeek): simulate every player to the end ──
     * With the opponents' real hands known, the right objective is not "my speed
     * minus a danger guess" but P(I go out first). Each candidate move is played
     * out against the same draw sequences (CRN): opponents take the pile tile when
     * it fits their hand, otherwise draw; everyone discards greedily and goes out
     * as soon as possible. Returns the bot's win rate. */
    var usefulForHand = function (A, hand14, p14, tile) {
      var h15 = hand14.concat([tile]);
      var p15 = bestPartition(h15);
      if (p15.leftover.length <= 1 && goOutTile(h15)) return { useful: true, p15: p15, h15: h15, win: true };
      var inLeft = p15.leftover.indexOf(tile) >= 0;
      if (!inLeft) return { useful: true, p15: p15, h15: h15 };
      if (isJ(tile)) return { useful: true, p15: p15, h15: h15 };
      var tv2 = Number(tile.val), ok = false;
      for (var i = 0; i < p15.leftover.length && !ok; i++) {
        var o = p15.leftover[i]; if (o === tile || isJ(o)) continue;
        var ov = Number(o.val);
        if ((ov === tv2 && o.color !== tile.color) || (o.color === tile.color && Math.abs(ov - tv2) <= 2)) ok = true;
      }
      return { useful: ok, p15: p15, h15: h15 };
    };
    // one simulated turn for `pl` = {hand, p}; mutates pile/bag; returns true if it went out
    var simPlayerTurn = function (A, pl, pile, bag) {
      var top = pile.length ? pile[pile.length - 1] : null;
      var u = top ? usefulForHand(A, pl.hand, pl.p, top) : null;
      var h15, p15;
      if (u && u.useful) { pile.pop(); if (u.win) return true; h15 = u.h15; p15 = u.p15; }
      else {
        if (!bag.length) return false;
        h15 = pl.hand.concat([bag.pop()]);
        p15 = bestPartition(h15);
        if (p15.leftover.length <= 1 && goOutTile(h15)) return true;
      }
      var rest = greedyDiscard(A, h15, p15);
      for (var i = 0; i < h15.length; i++) if (rest.indexOf(h15[i]) < 0) { pile.push(h15[i]); break; }
      pl.hand = rest; pl.p = bestPartition(rest);
      return false;
    };
    // race from "I just discarded `drop` leaving `rest14`": opponents move next, in
    // table order. Returns the MARGIN (first opponent's finishing round minus mine):
    // positive = I finish first. A smooth signal — a 0/1 win flag needs far more
    // rollouts than a turn budget allows to separate six candidate discards.
    var RACE_CAP = 22;
    function raceFrom(A, rest14, drop, pile0, seq) {
      var pile = pile0.slice(); pile.push(drop);
      var bag = seq.slice();
      var me = { hand: rest14, p: bestPartition(rest14), done: false };
      var opps = A.peekHands.map(function (o) { return { hand: o.hand, p: o.p, done: false }; });
      var myFin = RACE_CAP + 2, oppFin = RACE_CAP + 2;
      for (var round = 1; round <= RACE_CAP; round++) {
        for (var i = 0; i < opps.length; i++) {
          if (opps[i].done) continue;
          if (simPlayerTurn(A, opps[i], pile, bag)) { opps[i].done = true; if (round < oppFin) oppFin = round; }
        }
        if (!bag.length) break;
        if (!me.done && simPlayerTurn(A, me, pile, bag)) { me.done = true; myFin = round; }
        if (me.done && oppFin <= RACE_CAP) break;
        if (me.done && round >= myFin + 6) break; // opponents clearly slower — enough
      }
      return oppFin - myFin;
    }
    function raceScoreDiscards(A, hand15, budgetMs) {
      var t0 = nowMs();
      var cs = candidates(hand15);
      var ranked = cs.cands.map(function (c) { var p14 = bestPartition(c.rest); return { c: c, nd: needDist(A, p14) + dangerTurns(A, c.drop) * 0.5 }; });
      ranked.sort(function (a, b) { return a.nd - b.nd; });
      var top = ranked.slice(0, Math.min(6, ranked.length));
      var pile0 = A.discard;
      var sums = top.map(function () { return 0; }), n = 0;
      while (n < MAX_ROUNDS && (n === 0 || nowMs() - t0 < budgetMs)) {
        var seq = shuffledBag(A);
        for (var i = 0; i < top.length; i++) sums[i] += raceFrom(A, top[i].c.rest, top[i].c.drop, pile0, seq);
        n++;
      }
      var best = 0;
      for (var k = 1; k < top.length; k++) if (sums[k] > sums[best]) best = k;
      return { goOut: false, drop: top[best].c.drop, rest: top[best].c.rest, value: sums[best] / n, means: sums.map(function (s) { return s / n; }), top: top, n: n };
    }
    // draw decision under peek: take the pile tile (then best discard) vs. a blind deck draw
    function raceDecideDraw(A, top, budgetMs) {
      var t0 = nowMs();
      var h15 = A.hand.concat([top]);
      var cs = candidates(h15);
      var ranked = cs.cands.map(function (c) { var p14 = bestPartition(c.rest); return { c: c, nd: needDist(A, p14) + dangerTurns(A, c.drop) * 0.5 }; });
      ranked.sort(function (a, b) { return a.nd - b.nd; });
      var tops = ranked.slice(0, Math.min(4, ranked.length));
      var pileTaken = A.discard.slice(0, A.discard.length - 1);
      var sums = tops.map(function () { return 0; }), deckSum = 0, n = 0;
      while (n < MAX_ROUNDS && (n === 0 || nowMs() - t0 < budgetMs)) {
        var seq = shuffledBag(A);
        for (var i = 0; i < tops.length; i++) sums[i] += raceFrom(A, tops[i].c.rest, tops[i].c.drop, pileTaken, seq);
        // deck option: draw seq's last tile now, discard greedily, then race (pile keeps the top tile)
        var seq2 = seq.slice(); var drawn = seq2.pop();
        var hd = A.hand.concat([drawn]); var pd = bestPartition(hd);
        if (pd.leftover.length <= 1 && goOutTile(hd)) deckSum += RACE_CAP; // went out right now
        else { var restD = greedyDiscard(A, hd, pd); var dropD = null; for (var q = 0; q < hd.length; q++) if (restD.indexOf(hd[q]) < 0) { dropD = hd[q]; break; } deckSum += raceFrom(A, restD, dropD, A.discard, seq2); }
        n++;
      }
      var bestTake = -Infinity;
      for (var k = 0; k < tops.length; k++) if (sums[k] > bestTake) bestTake = sums[k];
      return { take: bestTake > deckSum + 0.15 * n ? 'discard' : 'deck' };
    }

    // Score every discard from a 15-hand: expected turns + danger. Time-boxed.
    function scoreDiscards(A, hand15, budgetMs) {
      var t0 = nowMs();
      var cs = candidates(hand15);
      var go = goOutTile(hand15, function (t) { return dangerTurns(A, t); });
      if (go) return { goOut: true, drop: go, rest: hand15.filter(function (x) { return x !== go; }), value: 0 };
      // NOTE: the perfect-information race (raceScoreDiscards) measured WORSE than
      // turns+danger in duplicate play (−0.14 ± 0.35 vs +0.21 ± 0.37, 14 pairs) —
      // it over-blocks. Kept for experiments; enable with env.race.
      if (env.race && A.peekHands && A.peekHands.length) return raceScoreDiscards(A, hand15, budgetMs);
      // cheap pre-ranking, then paired rollouts on the top few
      var ranked = cs.cands.map(function (c) { var p14 = bestPartition(c.rest); return { c: c, nd: needDist(A, p14) + dangerTurns(A, c.drop) * 0.5 }; });
      ranked.sort(function (a, b) { return a.nd - b.nd; });
      var top = ranked.slice(0, Math.min(6, ranked.length));
      var means = evalHands(A, top.map(function (x) { return x.c.rest; }), budgetMs, t0);
      var best = null, bestV = Infinity;
      for (var k = 0; k < top.length; k++) {
        var v = means[k] + dangerTurns(A, top[k].c.drop) * (0.35 + 0.65 * A.threat);
        if (v < bestV) { bestV = v; best = top[k]; }
      }
      return { goOut: false, drop: best.c.drop, rest: best.c.rest, value: bestV };
    }

    /* Public API.
     * decideDraw(ctx)  → { take: 'discard' | 'deck', goOut?: tile }
     * decideDiscard(ctx, hand15) → { drop, rest, goOut }
     * ctx = { hand, discard, players, me, budgetMs, peek? }
     */
    function decideDraw(ctx) {
      var A = analyse(ctx);
      var top = A.discard[A.discard.length - 1];
      if (!top) return { take: 'deck' };
      var budget = Math.max(40, Number(ctx.budgetMs) || 500);
      var h15 = A.hand.concat([top]);
      var go = goOutTile(h15, function (t) { return dangerTurns(A, t); });
      if (go) return { take: 'discard', goOut: go };
      if (env.race && A.peekHands && A.peekHands.length) return raceDecideDraw(A, top, budget);
      var t0 = nowMs();
      // Candidates after taking: the best few discards from the 15. Evaluate them
      // TOGETHER with the current 14-hand (= a blind deck draw) under the same
      // draw sequences, so deck-vs-pile is a paired comparison.
      var cs = candidates(h15);
      var ranked = cs.cands.map(function (c) { var p14 = bestPartition(c.rest); return { c: c, nd: needDist(A, p14) + dangerTurns(A, c.drop) * 0.5 }; });
      ranked.sort(function (a, b) { return a.nd - b.nd; });
      var tops = ranked.slice(0, Math.min(4, ranked.length));
      var hands = [A.hand].concat(tops.map(function (x) { return x.c.rest; }));
      var means = evalHands(A, hands, budget, t0);
      var deckV = means[0];
      var takeV = Infinity;
      for (var k = 0; k < tops.length; k++) {
        var v = 1 + means[k + 1] + dangerTurns(A, tops[k].c.drop) * (0.35 + 0.65 * A.threat);
        if (v < takeV) takeV = v;
      }
      // Taking the pile tile also DENIES it to an opponent who wants it, but tells
      // the table what we need. Net: require a small edge unless the tile is hot.
      var deny = dangerTurns(A, top) * 0.5;
      var margin = 0.1 - deny;
      return { take: takeV + margin < deckV ? 'discard' : 'deck' };
    }
    function decideDiscard(ctx, hand15) {
      var A = analyse({ hand: hand15, discard: ctx.discard, players: ctx.players, me: ctx.me, peek: ctx.peek });
      var res = scoreDiscards(A, (hand15 || []).filter(Boolean), Math.max(40, Number(ctx.budgetMs) || 500));
      return { drop: res.drop, rest: res.rest, goOut: !!res.goOut };
    }
    return { decideDraw: decideDraw, decideDiscard: decideDiscard, bestPartition: bestPartition, validateGroup: validateGroup, goOutTile: goOutTile, VERSION: VERSION };
  }

  return { create: create, bestPartition: bestPartition, validateGroup: validateGroup, goOutTile: goOutTile, COLORS: COLORS, VERSION: VERSION };
});
