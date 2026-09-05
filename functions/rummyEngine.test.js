/**
 * rummyEngine move-validation tests — מוודא שאימות-המהלך חוסם רמאות ומאשר מהלך חוקי.
 * Run: node rummyEngine.test.js
 */
"use strict";
const assert = require("assert");
const E = require("./rummyEngine");

let n = 0; const ok = (name, cond) => { assert.ok(cond, "FAILED: " + name); n++; console.log("  ✓ " + name); };
let id = 0;
const mk = (v, c) => ({id: "t" + (id++), val: v, color: c});
const grp = (tiles) => ({id: "g" + (id++), tiles});
// groupPoints פשוט למבחן (בלי ג'וקר): סכום ערכים
const gp = (tiles) => tiles.reduce((s, t) => s + (t.val === "☻" ? 0 : Number(t.val)), 0);

// יד פתיחה: מגש עם 3 אבנים שמרכיבות סדרה חדשה בשווי 30 (10+10+10)
const a = mk(10, "r"), b = mk(10, "b"), c = mk(10, "k");
const oldRack = [a, b, c, mk(5, "r"), mk(6, "r")];
const snapBoard = []; // לוח ריק בתחילת התור

// מהלך חוקי: הורדה-ראשונה של הסדרה 10-10-10 (30 נק')
{
  const newBoard = [grp([a, b, c])];
  const newRack = [null, null, null, oldRack[3], oldRack[4]];
  const r = E.validateMove(snapBoard, oldRack, newBoard, newRack, {hasDropped: false, firstMeldMin: 30, groupPoints: gp});
  ok("legal first meld (30) accepted", r.ok && r.placed === 3);
}
// הורדה-ראשונה מתחת לסף → נדחה
{
  const x = mk(2, "r"), y = mk(2, "b"), z = mk(2, "k");
  const or = [x, y, z];
  const r = E.validateMove([], or, [grp([x, y, z])], [], {hasDropped: false, firstMeldMin: 30, groupPoints: gp});
  ok("first meld below 30 rejected", !r.ok);
}
// המצאת אבן (id שלא היה במגש) → נדחה
{
  const fake = mk(10, "o");
  const newBoard = [grp([a, b, c, fake])];
  const newRack = [oldRack[3], oldRack[4]];
  const r = E.validateMove(snapBoard, oldRack, newBoard, newRack, {hasDropped: true, firstMeldMin: 30, groupPoints: gp});
  ok("fabricated tile on board rejected", !r.ok);
}
// שכפול אבן (אותה אבן פעמיים על הלוח) → נדחה
{
  const newBoard = [grp([a, b, c]), grp([a, mk(11, "r"), mk(12, "r")])];
  const r = E.validateMove(snapBoard, oldRack, newBoard, [oldRack[3], oldRack[4]], {hasDropped: true, firstMeldMin: 30, groupPoints: gp});
  ok("duplicated tile rejected", !r.ok);
}
// לקיחת אבן מהלוח למגש → נדחה
{
  const sb = [grp([mk(7, "r"), mk(8, "r"), mk(9, "r")])];
  const boardTile = sb[0].tiles[0];
  const or = [mk(4, "b")];
  // מנסים להזיז אבן-לוח למגש
  const newBoard = [grp([sb[0].tiles[1], sb[0].tiles[2], or[0]])]; // הסרנו אבן-לוח
  const newRack = [boardTile];
  const r = E.validateMove(sb, or, newBoard, newRack, {hasDropped: true, firstMeldMin: 30, groupPoints: gp});
  ok("taking a board tile into the rack rejected", !r.ok);
}
// לא הורדת כלום → נדחה
{
  const r = E.validateMove(snapBoard, oldRack, [], [...oldRack], {hasDropped: true, firstMeldMin: 30, groupPoints: gp});
  ok("no tile placed rejected", !r.ok);
}
// הורדה-ראשונה שנוגעת בלוח קיים → נדחה
{
  const sb = [grp([mk(7, "r"), mk(8, "r"), mk(9, "r")])];
  const or = [mk(7, "b"), mk(7, "k"), mk(7, "o")];
  // מוסיפים אבן לקבוצת-לוח קיימת לפני הורדה ראשונה
  const touched = [{id: sb[0].id, tiles: [...sb[0].tiles, or[0]]}, grp([or[1], or[2]])];
  const r = E.validateMove(sb, or, touched, [], {hasDropped: false, firstMeldMin: 30, groupPoints: gp});
  ok("touching existing board before first meld rejected", !r.ok);
}
// שימור: מהלך חוקי אחרי הורדה — השאלת אבן מהלוח + הורדה מהמגש
{
  const sb = [grp([mk(3, "r"), mk(4, "r"), mk(5, "r")])];
  const t3 = sb[0].tiles[0], t4 = sb[0].tiles[1], t5 = sb[0].tiles[2];
  const or = [mk(3, "b"), mk(3, "k")]; // עם ה-3 שעל הלוח → סדרת-שלישיות 3
  // מהלך: 4-5 נשארים? לא חוקי (סדרה של 2). נעשה מהלך פשוט: מוסיפים 6r לסדרה 3-4-5
  const t6 = mk(6, "r");
  const or2 = [t6, mk(9, "k")];
  const newBoard = [{id: sb[0].id, tiles: [t3, t4, t5, t6]}];
  const newRack = [or2[1]];
  const r = E.validateMove(sb, or2, newBoard, newRack, {hasDropped: true, firstMeldMin: 30, groupPoints: gp});
  ok("legal extension after drop accepted", r.ok && r.placed === 1);
}

// census: excess detection
{
  const t = mk(1, "r");
  const racks = [[t, t, t]]; // 3 עותקים של אותה (ערך,צבע) → עודף
  const cen = E.census(racks, [], []);
  ok("census flags excess copies", !!cen.excess);
}

console.log("\nrummyEngine: ALL " + n + " OK");
