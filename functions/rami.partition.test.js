/**
 * Regression tests for the Rami partition solver (bestPartition / goOutTile).
 * These check CORRECTNESS of completeness detection — not bot strength — because
 * a solver that misses a valid go-out silently blocks a real player's win.
 * Run: node rami.partition.test.js
 */
"use strict";
const assert = require("assert");
const B = require("./ramiBrain");
const C = B.COLORS; // [red, blue, orange, black]
const [R, BL, O, K] = C;
let id = 0;
const mk = (v, c) => ({ id: "t" + (id++), val: v, color: c });
const J = () => ({ id: "j" + (id++), val: "☻", color: R });

let pass = 0;
const ok = (name, cond) => { assert.ok(cond, "FAILED: " + name); pass++; console.log("  ✓ " + name); };

// The exact live hand from the field report: two sets of three 2s (duplicate
// colors) + a 4-5-J-7 run + an 8-9-10-11 run. Prefix-only set generation used
// to strand a colour and report leftover=2 (go-out button stayed disabled).
const bug = [mk(2, R), mk(2, BL), mk(2, K), mk(4, K), mk(5, K), J(), mk(7, K), mk(2, O), mk(2, K), mk(2, R), mk(8, K), mk(9, K), mk(10, K), mk(11, K)];
const bp = B.bestPartition(bug);
ok("duplicate-colour double-set hand is complete", bp.complete && bp.leftoverPoints === 0);
ok("go-out from the 15-tile version discards the odd tile", !!B.goOutTile(bug.concat([mk(3, R)])));

// A plain complete hand: two runs + one set
ok("two runs + a set is complete", B.bestPartition([
  mk(1, R), mk(2, R), mk(3, R), mk(7, BL), mk(8, BL), mk(9, BL), mk(10, BL),
  mk(5, R), mk(5, BL), mk(5, K), mk(11, K), mk(12, K), mk(13, K), mk(1, K),
]).complete);

// An incomplete hand must NOT be reported complete
ok("incomplete hand is not complete", !B.bestPartition([
  mk(1, R), mk(2, R), mk(3, R), mk(7, BL), mk(9, BL), mk(11, BL), mk(13, BL),
  mk(5, R), mk(6, O), mk(8, K), mk(2, K), mk(12, K), mk(4, BL), mk(10, R),
]).complete);

// Two 4-sets of the same value use all four colours twice (2 copies each)
ok("two 4-sets same value", B.bestPartition([
  mk(6, R), mk(6, BL), mk(6, O), mk(6, K), mk(6, R), mk(6, BL), mk(6, O), mk(6, K),
  mk(1, R), mk(2, R), mk(3, R), mk(9, K), mk(10, K), mk(11, K),
]).complete);

// "1" as high in a run (11-12-13-1)
ok("1-high run", B.bestPartition([
  mk(11, R), mk(12, R), mk(13, R), mk(1, R), mk(5, BL), mk(5, O), mk(5, K),
  mk(7, K), mk(8, K), mk(9, K), mk(2, O), mk(3, O), mk(4, O), mk(5, O),
]).complete);

console.log("\nrami partition: ALL " + pass + " OK");
