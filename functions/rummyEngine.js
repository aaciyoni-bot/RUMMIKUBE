/**
 * rummyEngine.js — אימות-מהלך אֶפֶס-אֵמון לרמיקוב הפתוח (server-authoritative).
 *
 * מהלך ברמיקוב = הגשת לוח-חדש + מגש-חדש. השרת מאמת שהמהלך חוקי לפני שהוא מחייב אותו:
 *   • כל קבוצה על הלוח חוקית (נבדק ע"י הקורא עם validateGroup).
 *   • שימור-אבנים מוחלט: אוסף-האבנים (לוח+מגש) אחרי = אוסף-האבנים לפני. אי-אפשר להמציא,
 *     לשכפל או להשמיד אבן.
 *   • אבני-לוח נשארות על הלוח (אסור לקחת אבן מהלוח למגש).
 *   • המגש-החדש הוא תת-קבוצה של המגש-הישן (אי-אפשר להמציא אבני-מגש).
 *   • הורדת לפחות אבן אחת.
 *   • הורדה-ראשונה: אסור לגעת בקבוצות-הלוח הקיימות, וסכום הקבוצות-החדשות ≥ הסף.
 *
 * פונקציה טהורה — נבדקת ב-rummyEngine.test.js. הכסף/ההתחשבנות נשארים ב-rummySettle.
 */
"use strict";

const tid = (t) => t && t.id;
const nonNull = (arr) => (arr || []).filter(Boolean);
const boardTiles = (board) => (board || []).flatMap((g) => (g && g.tiles) || []);

// ריבוי-קבוצה (multiset) של מזהי-אבנים → Map(id -> count)
function idCounts(tiles) {
  const m = new Map();
  for (const t of tiles) { const id = tid(t); if (id == null) continue; m.set(id, (m.get(id) || 0) + 1); }
  return m;
}
function sameCounts(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * מאמת מהלך. opts: { hasDropped, firstMeldMin, groupPoints(tiles)->number }.
 * validateGroup נבדק ע"י הקורא (rummyMoveSrv) לפני הקריאה — כאן בודקים שימור/חוקיות-מבנה.
 * מחזיר { ok:true, placed:number } או { ok:false, error:"..." }.
 */
function validateMove(snapBoard, oldRack, newBoard, newRack, opts) {
  opts = opts || {};
  const snapTiles = boardTiles(snapBoard);
  const oldR = nonNull(oldRack);
  const newTiles = boardTiles(newBoard);
  const newR = nonNull(newRack);

  const snapIds = idCounts(snapTiles);
  const oldRIds = idCounts(oldR);
  const newBIds = idCounts(newTiles);
  const newRIds = idCounts(newR);

  // אין כפילות-מזהה בתוך הלוח החדש או המגש החדש
  for (const [, c] of newBIds) if (c > 1) return {ok: false, error: "אבן כפולה על הלוח"};
  for (const [, c] of newRIds) if (c > 1) return {ok: false, error: "אבן כפולה במגש"};

  // שימור מוחלט: (לוח+מגש) אחרי = (לוח+מגש) לפני — אין המצאה/שכפול/השמדה
  const before = new Map(snapIds);
  for (const [k, v] of oldRIds) before.set(k, (before.get(k) || 0) + v);
  const after = new Map(newBIds);
  for (const [k, v] of newRIds) after.set(k, (after.get(k) || 0) + v);
  if (!sameCounts(before, after)) return {ok: false, error: "אבני-המשחק אינן נשמרות (המצאה/שינוי אבנים)"};

  // אבני-לוח נשארות על הלוח (אסור לקחת אבן מהלוח למגש)
  for (const id of snapIds.keys()) if (!newBIds.has(id)) return {ok: false, error: "אסור להחזיר אבן מהלוח למגש"};
  // המגש-החדש ⊆ המגש-הישן
  for (const id of newRIds.keys()) if (!oldRIds.has(id)) return {ok: false, error: "אבן שאינה שלך במגש"};

  const placed = nonNull(oldR).length - nonNull(newR).length;
  if (placed < 1) return {ok: false, error: "לא הורדת אף אבן"};

  // הורדה-ראשונה: אסור לשנות קבוצות-לוח קיימות, וסכום החדשות ≥ הסף
  if (!opts.hasDropped) {
    const snapGroupIds = new Set((snapBoard || []).map((g) => g.id));
    for (const sg of (snapBoard || [])) {
      const cur = (newBoard || []).find((g) => g.id === sg.id);
      if (!cur || cur.tiles.length !== sg.tiles.length) return {ok: false, error: "לפני הורדה ראשונה אסור לגעת בלוח הקיים"};
      const ids = new Set(cur.tiles.map(tid));
      if (!sg.tiles.every((t) => ids.has(tid(t)))) return {ok: false, error: "לפני הורדה ראשונה אסור לגעת בלוח הקיים"};
    }
    const gp = opts.groupPoints || (() => 0);
    const newGroups = (newBoard || []).filter((g) => !snapGroupIds.has(g.id));
    const dropValue = newGroups.reduce((s, g) => s + gp(g.tiles), 0);
    if (dropValue < (opts.firstMeldMin || 0)) return {ok: false, error: `הורדה ראשונה דורשת ${opts.firstMeldMin} נק' לפחות`};
  }
  return {ok: true, placed};
}

// census לשימור גלובלי (לצורך בדיקה בסיום): כל מגש + לוח + קופה = 2 לכל (ערך,צבע) + 2 ג'וקרים.
function census(racks, board, deck) {
  const cnt = new Map();
  const bump = (t) => { if (!t || t.val == null) return; const k = t.val === "☻" ? "J" : `${t.val}.${t.color}`; cnt.set(k, (cnt.get(k) || 0) + 1); };
  for (const r of racks) for (const t of nonNull(r)) bump(t);
  for (const t of boardTiles(board)) bump(t);
  for (const t of nonNull(deck)) bump(t);
  let total = 0, excess = null;
  for (const [k, n] of cnt) { total += n; if (n > 2) excess = excess || `${k}=${n}`; }
  return {total, excess};
}

module.exports = {validateMove, census, boardTiles, idCounts};
