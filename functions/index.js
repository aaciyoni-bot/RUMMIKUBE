/**
 * Rummikube Clubs — Cloud Functions (money authority)
 *
 * Phase 2, function #1: spinDailyBonus
 * The SERVER decides the prize and moves the chips. The client only triggers
 * the spin and animates the wheel — so a player can no longer fake the prize
 * or edit their own balance through the bonus wheel.
 */
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {initializeApp} = require("firebase-admin/app");
const {getFirestore} = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const BONUS_COOLDOWN_MS = 22 * 3600 * 1000;          // כמו בלקוח
const BONUS_WEIGHTS = [800, 100, 35, 25, 18, 12, 5, 5];
const DEFAULT_PRIZES = [5, 10, 20, 30, 50, 75, 100, 200];
const SCR_COOLDOWN_MS = 7 * 24 * 3600 * 1000;        // גירוד שבועי
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// תחילת המחזור השבועי (יום שני 00:01 שעון ישראל) - זהה ללקוח
function cycleStartIL() {
  const now = new Date();
  const il = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Jerusalem"}));
  const back = (il.getDay() + 6) % 7;
  const monday = new Date(il);
  monday.setDate(il.getDate() - back);
  monday.setHours(0, 1, 0, 0);
  return Math.round((monday.getTime() + (now.getTime() - il.getTime())) / 60000) * 60000;
}

exports.spinDailyBonus = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const clubId = request.data && request.data.clubId;
  if (!clubId) throw new HttpsError("invalid-argument", "חסר מזהה קלאב");

  const memRef = db.doc(`memberships/${uid}_${clubId}`);
  const clubRef = db.doc(`clubs/${clubId}`);

  return await db.runTransaction(async (tx) => {
    // --- כל הקריאות לפני כל הכתיבות ---
    const memSnap = await tx.get(memRef);
    if (!memSnap.exists) throw new HttpsError("permission-denied", "אינך חבר בקלאב הזה");
    const mem = memSnap.data();

    const clubSnap = await tx.get(clubRef);
    const club = clubSnap.exists ? clubSnap.data() : {};
    const bw = club.bonusWheel || {};
    if (bw.enabled === false) throw new HttpsError("failed-precondition", "גלגל הבונוס כבוי");

    const now = Date.now();
    const last = Number(mem.lastBonusAt) || 0;
    if (now - last < BONUS_COOLDOWN_MS) {
      const hrs = Math.ceil((BONUS_COOLDOWN_MS - (now - last)) / 3600000);
      throw new HttpsError("failed-precondition", `הבונוס הבא בעוד ${hrs} שעות`);
    }

    // הגרלה משוקללת — בצד השרת, לא ניתן לזיוף
    const prizes = (Array.isArray(bw.prizes) && bw.prizes.length === 8) ?
      bw.prizes.map((x) => Number(x) || 0) : DEFAULT_PRIZES;
    const total = BONUS_WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < BONUS_WEIGHTS.length; i++) {
      r -= BONUS_WEIGHTS[i];
      if (r <= 0) { idx = i; break; }
    }
    const prize = prizes[idx];

    const ownerUid = club.ownerUid || "";
    if (ownerUid && ownerUid !== uid) {
      // שימור צ'יפים: הפרס עובר מקופת בעל הקלאב לשחקן
      const ownRef = db.doc(`memberships/${ownerUid}_${clubId}`);
      const ownSnap = await tx.get(ownRef);
      const ownBal = ownSnap.exists ? (Number(ownSnap.data().balance) || 0) : 0;
      if (!ownSnap.exists || ownBal < prize) {
        throw new HttpsError("resource-exhausted", "קופת הקלאב ריקה כרגע - נסה מאוחר יותר");
      }
      tx.update(ownRef, {
        balance: round2(ownBal - prize),
        bonusPaid: round2((Number(ownSnap.data().bonusPaid) || 0) + prize),
      });
      tx.update(memRef, {
        balance: round2((Number(mem.balance) || 0) + prize),
        lastBonusAt: now,
      });
      return {prize, idx, fromBank: true};
    }

    // הבעלים מסובב על עצמו — הכסף נשאר בקופה שלו, רק מעדכנים זמן
    tx.update(memRef, {lastBonusAt: now});
    return {prize, idx, fromBank: false};
  });
});

/**
 * Phase 2, function #2: claimWeeklyScratch
 * גירוד שבועי — השרת מגריל את הפרס, אוכף את מגבלת הפרסים הגדולים (400/200 פעם
 * בשבוע לכל הקלאב) ומזיז את הצ'יפים. הלקוח רק בונה את הרשת הוויזואלית.
 */
exports.claimWeeklyScratch = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError("unauthenticated", "צריך להתחבר");
  const clubId = request.data && request.data.clubId;
  if (!clubId) throw new HttpsError("invalid-argument", "חסר מזהה קלאב");

  const memRef = db.doc(`memberships/${uid}_${clubId}`);
  const clubRef = db.doc(`clubs/${clubId}`);

  return await db.runTransaction(async (tx) => {
    const memSnap = await tx.get(memRef);
    if (!memSnap.exists) throw new HttpsError("permission-denied", "אינך חבר בקלאב הזה");
    const mem = memSnap.data();

    const clubSnap = await tx.get(clubRef);
    const club = clubSnap.exists ? clubSnap.data() : {};
    const bw = club.bonusWheel || {};
    if (bw.enabled === false) throw new HttpsError("failed-precondition", "התכונה כבויה");

    const now = Date.now();
    const lastS = Number(mem.lastScratchAt) || 0;
    if (now - lastS < SCR_COOLDOWN_MS) throw new HttpsError("failed-precondition", "כבר גירדת השבוע");

    // מעקב מגבלת פרסים לפי מחזור שבועי (זהה ללקוח)
    const cycleKey = String(cycleStartIL());
    let sc = club.scratch || {};
    if (sc.key !== cycleKey) sc = {key: cycleKey, won400: false, won200: false};

    const r = Math.random() * 1000;
    let prize;
    if (r < 800) prize = 10;
    else if (r < 950) prize = 15;
    else if (r < 955) prize = !sc.won400 ? 400 : 10;
    else if (r < 965) prize = !sc.won200 ? 200 : 10;
    else prize = 10;
    if (prize === 400) sc = {...sc, won400: true};
    if (prize === 200) sc = {...sc, won200: true};

    const ownerUid = club.ownerUid || "";
    if (ownerUid && ownerUid !== uid) {
      const ownRef = db.doc(`memberships/${ownerUid}_${clubId}`);
      const ownSnap = await tx.get(ownRef);
      const ownBal = ownSnap.exists ? (Number(ownSnap.data().balance) || 0) : 0;
      if (!ownSnap.exists || ownBal < prize) {
        throw new HttpsError("resource-exhausted", "קופת הקלאב ריקה כרגע - נסה מאוחר יותר");
      }
      tx.update(ownRef, {
        balance: round2(ownBal - prize),
        bonusPaid: round2((Number(ownSnap.data().bonusPaid) || 0) + prize),
      });
      tx.update(memRef, {
        balance: round2((Number(mem.balance) || 0) + prize),
        lastScratchAt: now,
      });
      tx.update(clubRef, {scratch: sc});
      return {prize, fromBank: true};
    }

    tx.update(memRef, {lastScratchAt: now});
    tx.update(clubRef, {scratch: sc});
    return {prize, fromBank: false};
  });
});
