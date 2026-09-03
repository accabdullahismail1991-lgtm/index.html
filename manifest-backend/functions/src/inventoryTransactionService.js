// The ONLY code path allowed to write stockBalances/inventoryTransactions.
// See ARCHITECTURE_DECISIONS.md §3. Every higher-level flow (transfers,
// future production/waste/count) calls this internally instead of writing
// those collections itself.
//
// Exposed as two phases (prepare = reads, commit = writes) instead of one
// function, because a Firestore transaction requires ALL reads across the
// entire transaction to happen before ANY writes. A caller that needs to
// post several lines in one atomic transaction (e.g. a transfer with
// multiple items) must prepare every line first, then commit them all —
// it cannot alternate read/write per line. `postInventoryTransaction()`
// below is a convenience wrapper for the common single-posting case.

const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { requirePermission } = require('./rbac');
const { auditEntry } = require('./audit');

const TX_TYPES = [
  'receive',
  'issue',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'production_consume',
  'production_yield',
  'waste',
  'count_variance',
];

async function prepareInventoryPosting(db, tx, { type, itemId, locationId, qty, idempotencyKey }) {
  if (!TX_TYPES.includes(type)) {
    throw new HttpsError('invalid-argument', `نوع حركة غير معروف: ${type}`);
  }
  if (!itemId || !locationId) {
    throw new HttpsError('invalid-argument', 'itemId و locationId مطلوبان');
  }
  if (typeof qty !== 'number' || !isFinite(qty) || qty === 0) {
    throw new HttpsError('invalid-argument', 'الكمية يجب أن تكون رقمًا غير صفري');
  }

  const idemRef = idempotencyKey ? db.collection('idempotencyKeys').doc(idempotencyKey) : null;
  const idemSnap = idemRef ? await tx.get(idemRef) : null;
  if (idemSnap && idemSnap.exists) {
    return { duplicate: true, txId: idemSnap.data().txId };
  }

  const balanceId = `${locationId}_${itemId}`;
  const balanceRef = db.collection('stockBalances').doc(balanceId);
  const balanceSnap = await tx.get(balanceRef);
  const before = balanceSnap.exists ? balanceSnap.data().qty : 0;
  const after = before + qty;
  if (after < -1e-6) {
    throw new HttpsError(
      'failed-precondition',
      `الرصيد سيصبح سالبًا للصنف ${itemId} في الموقع ${locationId} (${before} + ${qty})`
    );
  }

  return {
    duplicate: false,
    type, itemId, locationId, qty, idempotencyKey,
    idemRef, balanceRef, balanceId, before, after,
  };
}

// Call only after every prepareInventoryPosting() for this transaction has
// already resolved — i.e. during the write phase.
function commitInventoryPosting(db, tx, prepared, { refType, refId, actorUid, note }) {
  if (prepared.duplicate) {
    return { duplicate: true, txId: prepared.txId };
  }
  const { type, itemId, locationId, qty, idempotencyKey, idemRef, balanceRef, balanceId, before, after } = prepared;

  tx.set(balanceRef, { itemId, locationId, qty: after, updatedAt: new Date() }, { merge: true });

  const txRef = db.collection('inventoryTransactions').doc();
  tx.set(txRef, {
    type, itemId, locationId, qty, before, after,
    refType: refType || null,
    refId: refId || null,
    actorUid,
    note: note || null,
    idempotencyKey: idempotencyKey || null,
    createdAt: new Date(),
  });

  if (idemRef) {
    tx.set(idemRef, { createdAt: new Date(), actorUid, txId: txRef.id });
  }

  auditEntry(tx, db, {
    action: `inventory.${type}`,
    entity: `stockBalances/${balanceId}`,
    actorUid,
    before: { qty: before },
    after: { qty: after },
  });

  return { duplicate: false, txId: txRef.id, before, after };
}

// Convenience for the single-posting case: prepare then immediately
// commit. Safe only when nothing else in the same transaction still needs
// to perform a tx.get() after this call.
async function postInventoryTransaction(db, tx, opts) {
  const prepared = await prepareInventoryPosting(db, tx, opts);
  return commitInventoryPosting(db, tx, prepared, opts);
}

const postInventoryTransactionCallable = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'inventory.adjust');
  const db = getFirestore();
  const data = request.data || {};
  return db.runTransaction((tx) => postInventoryTransaction(db, tx, { ...data, actorUid: actor.uid }));
});

module.exports = {
  TX_TYPES,
  prepareInventoryPosting,
  commitInventoryPosting,
  postInventoryTransaction,
  postInventoryTransactionCallable,
};
