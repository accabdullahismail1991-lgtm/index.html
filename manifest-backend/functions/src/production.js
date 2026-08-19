const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { requirePermission } = require('./rbac');
const { prepareInventoryPosting, commitInventoryPosting } = require('./inventoryTransactionService');
const { classifyProductionVariance } = require('./varianceEngine');
const { auditEntry } = require('./audit');
const { nextDocNumber } = require('./counters');

// Design assumption (not spelled out in the excerpt of the spec this was
// built from — flagged explicitly rather than guessed silently): BOM
// components are consumed at production START, and the finished/semi item
// is yielded at production COMPLETE. If the real kitchen workflow instead
// consumes at completion (e.g. to allow adjusting actual component usage
// before posting), this needs revisiting — see PROJECT_STATUS.md.
const TRANSITIONS = {
  planned: ['in_progress', 'cancelled'],
  in_progress: ['completed'],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
    throw new HttpsError('failed-precondition', `لا يمكن الانتقال من الحالة "${from}" إلى "${to}"`);
  }
}

const createProductionOrder = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'production.create');
  const { itemId, locationId, plannedQty, components, notes } = request.data || {};
  if (!itemId || !locationId || typeof plannedQty !== 'number' || plannedQty <= 0) {
    throw new HttpsError('invalid-argument', 'بيانات أمر الإنتاج غير مكتملة');
  }
  if (!Array.isArray(components) || !components.length) {
    throw new HttpsError('invalid-argument', 'مكونات الوصفة مطلوبة');
  }
  for (const c of components) {
    if (!c.itemId || typeof c.qtyPlanned !== 'number' || c.qtyPlanned < 0) {
      throw new HttpsError('invalid-argument', 'كل مكوّن يجب أن يحتوي على itemId وكمية مخططة صحيحة');
    }
  }

  const db = getFirestore();
  const ref = db.collection('productionOrders').doc();
  const { docNumber } = await db.runTransaction(async (tx) => {
    const num = await nextDocNumber(tx, db, 'PO');
    tx.set(ref, {
      docNumber: num, itemId, locationId, plannedQty, actualYieldQty: null,
      components: components.map((c) => ({ itemId: c.itemId, qtyPlanned: c.qtyPlanned, qtyConsumed: null })),
      notes: notes || null,
      status: 'planned',
      createdBy: actor.uid,
      createdAt: new Date(),
    });
    auditEntry(tx, db, { action: 'production.create', entity: `productionOrders/${ref.id}`, actorUid: actor.uid, before: null, after: { status: 'planned', docNumber: num } });
    return { docNumber: num };
  });

  return { id: ref.id, docNumber, status: 'planned' };
});

const startProduction = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'production.start');
  const { productionOrderId, idempotencyKey } = request.data || {};
  if (!productionOrderId) throw new HttpsError('invalid-argument', 'productionOrderId مطلوب');

  const db = getFirestore();
  const ref = db.collection('productionOrders').doc(productionOrderId);
  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'أمر الإنتاج غير موجود');
    const order = snap.data();
    assertTransition(order.status, 'in_progress');

    const postings = [];
    for (const c of order.components) {
      if (!(c.qtyPlanned > 0)) continue; // zero-qty component: nothing to consume
      postings.push(await prepareInventoryPosting(db, tx, {
        type: 'production_consume', itemId: c.itemId, locationId: order.locationId,
        qty: -c.qtyPlanned,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}_consume_${c.itemId}` : null,
      }));
    }

    // --- write phase ---
    for (const p of postings) {
      commitInventoryPosting(db, tx, p, { refType: 'production', refId: productionOrderId, actorUid: actor.uid });
    }
    const components = order.components.map((c) => ({ ...c, qtyConsumed: c.qtyPlanned }));
    tx.update(ref, { components, status: 'in_progress', startedBy: actor.uid, startedAt: new Date() });
    auditEntry(tx, db, { action: 'production.start', entity: `productionOrders/${productionOrderId}`, actorUid: actor.uid, before: { status: order.status }, after: { status: 'in_progress' } });
    return { ok: true };
  });
});

// Records however much was actually produced — which may differ from
// plannedQty (kitchen yield is rarely exact) — and raises a variance when
// it does, rather than silently accepting the planned figure as truth.
const completeProduction = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'production.complete');
  const { productionOrderId, actualYieldQty, idempotencyKey } = request.data || {};
  if (!productionOrderId) throw new HttpsError('invalid-argument', 'productionOrderId مطلوب');
  if (typeof actualYieldQty !== 'number' || actualYieldQty < 0) {
    throw new HttpsError('invalid-argument', 'الكمية الفعلية المنتجة مطلوبة');
  }

  const db = getFirestore();
  const ref = db.collection('productionOrders').doc(productionOrderId);
  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'أمر الإنتاج غير موجود');
    const order = snap.data();
    assertTransition(order.status, 'completed');

    const posting = actualYieldQty > 0
      ? await prepareInventoryPosting(db, tx, {
          type: 'production_yield', itemId: order.itemId, locationId: order.locationId,
          qty: actualYieldQty,
          idempotencyKey: idempotencyKey ? `${idempotencyKey}_yield` : null,
        })
      : null;

    // --- write phase ---
    if (posting) commitInventoryPosting(db, tx, posting, { refType: 'production', refId: productionOrderId, actorUid: actor.uid });

    let varianceId = null;
    const variance = classifyProductionVariance(order.plannedQty, actualYieldQty);
    if (variance) {
      const vRef = db.collection('variances').doc();
      tx.set(vRef, {
        type: variance.type,
        subjectType: 'production', subjectId: productionOrderId, itemId: order.itemId,
        qtyDelta: variance.qtyDelta,
        status: 'open',
        note: `المخطط: ${order.plannedQty}، الفعلي: ${actualYieldQty}`,
        createdAt: new Date(),
      });
      varianceId = vRef.id;
    }

    tx.update(ref, { actualYieldQty, status: 'completed', completedBy: actor.uid, completedAt: new Date(), varianceId });
    auditEntry(tx, db, { action: 'production.complete', entity: `productionOrders/${productionOrderId}`, actorUid: actor.uid, before: { status: order.status }, after: { status: 'completed', actualYieldQty, varianceId } });
    return { ok: true, varianceId };
  });
});

// Only reachable from 'planned' — once components have been consumed
// (startProduction), cancelling needs a reversal flow that isn't modeled
// yet, same limitation as an already-shipped transfer.
const cancelProduction = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'production.cancel');
  const { productionOrderId, reason } = request.data || {};
  if (!productionOrderId) throw new HttpsError('invalid-argument', 'productionOrderId مطلوب');

  const db = getFirestore();
  const ref = db.collection('productionOrders').doc(productionOrderId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'أمر الإنتاج غير موجود');
    const order = snap.data();
    assertTransition(order.status, 'cancelled');

    tx.update(ref, { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: new Date(), cancelReason: reason || null });
    auditEntry(tx, db, { action: 'production.cancel', entity: `productionOrders/${productionOrderId}`, actorUid: actor.uid, before: { status: order.status }, after: { status: 'cancelled', reason: reason || null } });
    return { ok: true };
  });
});

module.exports = { TRANSITIONS, createProductionOrder, startProduction, completeProduction, cancelProduction };
