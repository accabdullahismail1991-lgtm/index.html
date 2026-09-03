const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { requirePermission } = require('./rbac');
const { prepareInventoryPosting, commitInventoryPosting } = require('./inventoryTransactionService');
const { classifyCountVariance } = require('./varianceEngine');
const { auditEntry } = require('./audit');
const { nextDocNumber } = require('./counters');

// Physical/cycle counts. The one subtlety that matters here: a count has
// a real-world duration (someone walks the floor with a clipboard) during
// which OTHER inventory activity (sales, transfers) can still post to the
// same location. If the "system quantity" used to compute the applied
// delta were frozen at count-start or even at submit-time, applyCount
// could silently post the wrong delta and land the balance somewhere
// other than what was physically counted -- which defeats the entire
// point of a physical count (the system is supposed to end up matching
// reality, exactly, not "reality as of whenever the walk started").
//
// So: qtySystemAtSubmit (recorded in submitCount) is DISPLAY-ONLY, for
// the review screen ("system said X, we counted Y"). The actual applied
// delta in applyCount is always computed from the LIVE balance read at
// apply-time, guaranteeing the post-apply balance equals qtyCounted
// exactly. If the live balance at apply-time differs from
// qtySystemAtSubmit, that's drift during the counting window -- it's
// recorded per-line in the result rather than silently ignored.
//
// Also unlike transfers/production: cancelling is allowed from BOTH
// 'open' and 'submitted', because neither state has posted anything to
// the ledger yet -- submitCount only records numbers, it doesn't move
// inventory. The irreversible step is applyCount, not submitCount.
const TRANSITIONS = {
  open: ['submitted', 'cancelled'],
  submitted: ['applied', 'cancelled'],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
    throw new HttpsError('failed-precondition', `لا يمكن الانتقال من الحالة "${from}" إلى "${to}"`);
  }
}

const startCount = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'count.create');
  const { locationId, itemIds, type } = request.data || {};
  if (!locationId || !Array.isArray(itemIds) || !itemIds.length) {
    throw new HttpsError('invalid-argument', 'locationId وقائمة itemIds مطلوبة');
  }

  const db = getFirestore();
  const ref = db.collection('counts').doc();
  const { docNumber } = await db.runTransaction(async (tx) => {
    const num = await nextDocNumber(tx, db, 'SC');
    tx.set(ref, {
      docNumber: num,
      locationId,
      type: type === 'full' ? 'full' : 'cycle',
      lines: itemIds.map((itemId) => ({ itemId, qtySystemAtSubmit: null, qtyCounted: null, qtyDelta: null })),
      status: 'open',
      createdBy: actor.uid,
      createdAt: new Date(),
    });
    auditEntry(tx, db, { action: 'count.start', entity: `counts/${ref.id}`, actorUid: actor.uid, before: null, after: { status: 'open', docNumber: num } });
    return { docNumber: num };
  });

  return { id: ref.id, docNumber, status: 'open' };
});

// Records the physical count. Reads the current balance per line purely
// for display on the review screen -- not authoritative, see module note.
const submitCount = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'count.submit');
  const { countId, countedLines } = request.data || {};
  if (!countId || !Array.isArray(countedLines) || !countedLines.length) {
    throw new HttpsError('invalid-argument', 'countId وقائمة countedLines مطلوبة');
  }

  const db = getFirestore();
  const ref = db.collection('counts').doc(countId);
  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'الجرد غير موجود');
    const count = snap.data();
    assertTransition(count.status, 'submitted');

    const balanceReads = {};
    for (const line of count.lines) {
      const balanceRef = db.collection('stockBalances').doc(`${count.locationId}_${line.itemId}`);
      const balanceSnap = await tx.get(balanceRef);
      balanceReads[line.itemId] = balanceSnap.exists ? balanceSnap.data().qty : 0;
    }

    // --- write phase ---
    const lines = count.lines.map((line) => {
      const counted = countedLines.find((c) => c.itemId === line.itemId);
      if (!counted || typeof counted.qtyCounted !== 'number' || counted.qtyCounted < 0) {
        throw new HttpsError('invalid-argument', `كمية مجرودة غير صحيحة للصنف ${line.itemId}`);
      }
      const qtySystemAtSubmit = balanceReads[line.itemId];
      return {
        itemId: line.itemId,
        qtySystemAtSubmit,
        qtyCounted: counted.qtyCounted,
        qtyDelta: counted.qtyCounted - qtySystemAtSubmit, // display-only
      };
    });

    tx.update(ref, { lines, status: 'submitted', submittedBy: actor.uid, submittedAt: new Date() });
    auditEntry(tx, db, { action: 'count.submit', entity: `counts/${countId}`, actorUid: actor.uid, before: { status: count.status }, after: { status: 'submitted' } });
    return { ok: true };
  });
});

// The step that actually touches the ledger. Recomputes each line's
// delta from the LIVE balance (not qtySystemAtSubmit) so the applied
// result always matches what was physically counted, and reports any
// drift between what the reviewer saw at submit-time and what was
// actually live at apply-time.
const applyCount = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'count.approve');
  const { countId, idempotencyKey } = request.data || {};
  if (!countId) throw new HttpsError('invalid-argument', 'countId مطلوب');

  const db = getFirestore();
  const ref = db.collection('counts').doc(countId);
  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'الجرد غير موجود');
    const count = snap.data();
    assertTransition(count.status, 'applied');

    const liveBalances = {};
    for (const line of count.lines) {
      const balanceRef = db.collection('stockBalances').doc(`${count.locationId}_${line.itemId}`);
      const balanceSnap = await tx.get(balanceRef);
      liveBalances[line.itemId] = balanceSnap.exists ? balanceSnap.data().qty : 0;
    }

    const postings = [];
    const driftWarnings = [];
    for (const line of count.lines) {
      const liveBefore = liveBalances[line.itemId];
      if (line.qtySystemAtSubmit != null && Math.abs(liveBefore - line.qtySystemAtSubmit) > 1e-6) {
        driftWarnings.push({ itemId: line.itemId, qtySystemAtSubmit: line.qtySystemAtSubmit, qtySystemAtApply: liveBefore });
      }
      const qty = line.qtyCounted - liveBefore;
      if (Math.abs(qty) < 1e-9) continue; // already matches live reality, nothing to post
      postings.push(await prepareInventoryPosting(db, tx, {
        type: 'count_variance', itemId: line.itemId, locationId: count.locationId, qty,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}_${line.itemId}` : null,
      }));
    }

    // --- write phase ---
    for (const p of postings) {
      commitInventoryPosting(db, tx, p, { refType: 'count', refId: countId, actorUid: actor.uid });
    }

    const varianceIds = [];
    for (const line of count.lines) {
      const liveBefore = liveBalances[line.itemId];
      const variance = classifyCountVariance(liveBefore, line.qtyCounted);
      if (variance) {
        const vRef = db.collection('variances').doc();
        tx.set(vRef, {
          type: variance.type,
          subjectType: 'count', subjectId: countId, itemId: line.itemId,
          qtyDelta: variance.qtyDelta,
          status: 'open',
          note: `النظام وقت التطبيق: ${liveBefore}، المجرود: ${line.qtyCounted}`,
          createdAt: new Date(),
        });
        varianceIds.push(vRef.id);
      }
    }

    tx.update(ref, { status: 'applied', appliedBy: actor.uid, appliedAt: new Date(), varianceIds, driftWarnings });
    auditEntry(tx, db, { action: 'count.apply', entity: `counts/${countId}`, actorUid: actor.uid, before: { status: count.status }, after: { status: 'applied', varianceIds, driftWarnings } });
    return { ok: true, varianceIds, driftWarnings };
  });
});

// Allowed from 'open' or 'submitted' -- see module note on why cancel is
// more permissive here than transfers/production.
const cancelCount = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'count.cancel');
  const { countId, reason } = request.data || {};
  if (!countId) throw new HttpsError('invalid-argument', 'countId مطلوب');

  const db = getFirestore();
  const ref = db.collection('counts').doc(countId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'الجرد غير موجود');
    const count = snap.data();
    assertTransition(count.status, 'cancelled');

    tx.update(ref, { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: new Date(), cancelReason: reason || null });
    auditEntry(tx, db, { action: 'count.cancel', entity: `counts/${countId}`, actorUid: actor.uid, before: { status: count.status }, after: { status: 'cancelled', reason: reason || null } });
    return { ok: true };
  });
});

module.exports = { TRANSITIONS, startCount, submitCount, applyCount, cancelCount };
