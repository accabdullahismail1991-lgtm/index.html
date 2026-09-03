const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { requirePermission } = require('./rbac');
const { prepareInventoryPosting, commitInventoryPosting } = require('./inventoryTransactionService');
const { classifyTransferVariance } = require('./varianceEngine');
const { resolveApprovalRequirement } = require('./approvalEngine');
const { auditEntry } = require('./audit');
const { nextDocNumber } = require('./counters');

const TRANSIT_LOCATION_ID = 'transit';

const TRANSITIONS = {
  submitted: ['approved', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['in_transit', 'cancelled'],
  in_transit: ['received', 'variance_reviewed'],
};

function assertTransition(from, to) {
  if (!TRANSITIONS[from] || !TRANSITIONS[from].includes(to)) {
    throw new HttpsError('failed-precondition', `لا يمكن الانتقال من الحالة "${from}" إلى "${to}"`);
  }
}

// Approval-rule lookup happens before opening the transaction — it's a
// threshold read, not part of the ledger atomicity invariant (see
// approvalEngine.js).
const submitTransfer = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'transfer.submit');
  const { fromLocationId, toLocationId, lines, notes } = request.data || {};
  if (!fromLocationId || !toLocationId || !Array.isArray(lines) || !lines.length) {
    throw new HttpsError('invalid-argument', 'بيانات التحويل غير مكتملة');
  }
  for (const l of lines) {
    if (!l.itemId || typeof l.qty !== 'number' || l.qty <= 0) {
      throw new HttpsError('invalid-argument', 'كل سطر يجب أن يحتوي على itemId وكمية موجبة');
    }
  }

  const db = getFirestore();
  const totalValue = lines.reduce((s, l) => s + (l.estimatedValue || 0), 0);
  const approvalRule = await resolveApprovalRequirement('transfer', totalValue);
  const status = approvalRule ? 'pending_approval' : 'submitted';

  const ref = db.collection('transfers').doc();
  const result = await db.runTransaction(async (tx) => {
    const docNumber = await nextDocNumber(tx, db, 'TR');
    const doc = {
      docNumber, fromLocationId, toLocationId,
      lines: lines.map((l) => ({ itemId: l.itemId, qtyRequested: l.qty, qtyShipped: null, qtyReceived: null })),
      notes: notes || null,
      status,
      approvalRuleId: approvalRule ? approvalRule.id : null,
      submittedBy: actor.uid,
      createdAt: new Date(),
    };
    tx.set(ref, doc);
    auditEntry(tx, db, { action: 'transfer.submit', entity: `transfers/${ref.id}`, actorUid: actor.uid, before: null, after: { status, docNumber } });
    return { docNumber };
  });

  return { id: ref.id, docNumber: result.docNumber, status };
});

const approveTransfer = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'transfer.approve');
  const { transferId } = request.data || {};
  if (!transferId) throw new HttpsError('invalid-argument', 'transferId مطلوب');

  const db = getFirestore();
  const ref = db.collection('transfers').doc(transferId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'التحويل غير موجود');
    const transfer = snap.data();
    assertTransition(transfer.status, 'approved');

    tx.update(ref, { status: 'approved', approvedBy: actor.uid, approvedAt: new Date() });
    auditEntry(tx, db, { action: 'transfer.approve', entity: `transfers/${transferId}`, actorUid: actor.uid, before: { status: transfer.status }, after: { status: 'approved' } });
    return { ok: true };
  });
});

const rejectTransfer = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'transfer.approve');
  const { transferId, reason } = request.data || {};
  if (!transferId) throw new HttpsError('invalid-argument', 'transferId مطلوب');

  const db = getFirestore();
  const ref = db.collection('transfers').doc(transferId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'التحويل غير موجود');
    const transfer = snap.data();
    assertTransition(transfer.status, 'rejected');

    tx.update(ref, { status: 'rejected', rejectedBy: actor.uid, rejectedAt: new Date(), rejectReason: reason || null });
    auditEntry(tx, db, { action: 'transfer.reject', entity: `transfers/${transferId}`, actorUid: actor.uid, before: { status: transfer.status }, after: { status: 'rejected', reason: reason || null } });
    return { ok: true };
  });
});

// Only reachable before shipment — once stock has actually left the
// source location (shipTransfer), the physical goods are in motion and
// this is no longer a paperwork-only cancellation; that case isn't
// modeled yet (see PROJECT_STATUS.md).
const cancelTransfer = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'transfer.cancel');
  const { transferId, reason } = request.data || {};
  if (!transferId) throw new HttpsError('invalid-argument', 'transferId مطلوب');

  const db = getFirestore();
  const ref = db.collection('transfers').doc(transferId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'التحويل غير موجود');
    const transfer = snap.data();
    assertTransition(transfer.status, 'cancelled');

    tx.update(ref, { status: 'cancelled', cancelledBy: actor.uid, cancelledAt: new Date(), cancelReason: reason || null });
    auditEntry(tx, db, { action: 'transfer.cancel', entity: `transfers/${transferId}`, actorUid: actor.uid, before: { status: transfer.status }, after: { status: 'cancelled', reason: reason || null } });
    return { ok: true };
  });
});

// Moves the shipped quantity of every line: source location -> Transit.
// Read phase (transfer doc + one posting-prep per line) fully completes
// before any write, per Firestore's transaction rules — see
// inventoryTransactionService.js's module comment.
const shipTransfer = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'transfer.ship');
  const { transferId, shippedLines, idempotencyKey } = request.data || {};
  if (!transferId) throw new HttpsError('invalid-argument', 'transferId مطلوب');

  const db = getFirestore();
  const ref = db.collection('transfers').doc(transferId);

  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'التحويل غير موجود');
    const transfer = snap.data();
    assertTransition(transfer.status, 'in_transit');

    const lines = transfer.lines.map((line) => {
      const shipped = (shippedLines || []).find((s) => s.itemId === line.itemId);
      return { ...line, qtyShipped: shipped ? shipped.qty : line.qtyRequested };
    });

    const postings = [];
    for (const line of lines) {
      // A zero-qty leg (item pulled from the shipment) moves nothing —
      // posting it would just be a meaningless zero-qty ledger entry, and
      // the core service rejects qty===0 outright, so skip it here.
      if (!(line.qtyShipped > 0)) continue;
      postings.push(await prepareInventoryPosting(db, tx, {
        type: 'transfer_out', itemId: line.itemId, locationId: transfer.fromLocationId,
        qty: -line.qtyShipped,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}_out_${line.itemId}` : null,
      }));
      postings.push(await prepareInventoryPosting(db, tx, {
        type: 'transfer_in', itemId: line.itemId, locationId: TRANSIT_LOCATION_ID,
        qty: line.qtyShipped,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}_transit_${line.itemId}` : null,
      }));
    }

    // --- write phase ---
    for (const prepared of postings) {
      commitInventoryPosting(db, tx, prepared, { refType: 'transfer', refId: transferId, actorUid: actor.uid });
    }
    tx.update(ref, { lines, status: 'in_transit', shippedBy: actor.uid, shippedAt: new Date() });
    auditEntry(tx, db, { action: 'transfer.ship', entity: `transfers/${transferId}`, actorUid: actor.uid, before: { status: transfer.status }, after: { status: 'in_transit' } });
    return { ok: true };
  });
});

// Moves only the CONFIRMED-received quantity of every line: Transit ->
// destination. Any shortfall stays sitting in Transit (never assumed
// delivered, never silently discarded) and gets a variances/ record —
// this is the spec's own 80kg-shipped/75kg-received worked example,
// implemented literally rather than simulated.
const receiveTransfer = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'transfer.receive');
  const { transferId, receivedLines, idempotencyKey } = request.data || {};
  if (!transferId) throw new HttpsError('invalid-argument', 'transferId مطلوب');

  const db = getFirestore();
  const ref = db.collection('transfers').doc(transferId);

  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'التحويل غير موجود');
    const transfer = snap.data();
    assertTransition(transfer.status, 'received');

    const lines = transfer.lines.map((line) => {
      const received = (receivedLines || []).find((r) => r.itemId === line.itemId);
      const qtyReceived = received ? received.qty : line.qtyShipped;
      if (qtyReceived < 0 || qtyReceived > line.qtyShipped + 1e-6) {
        throw new HttpsError('invalid-argument', `كمية الاستلام غير منطقية للصنف ${line.itemId}`);
      }
      return { ...line, qtyReceived };
    });

    const postings = [];
    for (const line of lines) {
      // A total loss (qtyReceived === 0) moves nothing out of Transit —
      // the shortfall is entirely captured by the variance record below,
      // not by a meaningless zero-qty posting.
      if (!(line.qtyReceived > 0)) continue;
      postings.push(await prepareInventoryPosting(db, tx, {
        type: 'transfer_out', itemId: line.itemId, locationId: TRANSIT_LOCATION_ID,
        qty: -line.qtyReceived,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}_transitout_${line.itemId}` : null,
      }));
      postings.push(await prepareInventoryPosting(db, tx, {
        type: 'transfer_in', itemId: line.itemId, locationId: transfer.toLocationId,
        qty: line.qtyReceived,
        idempotencyKey: idempotencyKey ? `${idempotencyKey}_in_${line.itemId}` : null,
      }));
    }

    // --- write phase ---
    for (const prepared of postings) {
      commitInventoryPosting(db, tx, prepared, { refType: 'transfer', refId: transferId, actorUid: actor.uid });
    }

    const varianceIds = [];
    for (const line of lines) {
      const variance = classifyTransferVariance(line.qtyShipped, line.qtyReceived);
      if (variance) {
        const vRef = db.collection('variances').doc();
        tx.set(vRef, {
          type: variance.type,
          subjectType: 'transfer', subjectId: transferId, itemId: line.itemId,
          qtyDelta: variance.qtyDelta,
          status: 'open',
          note: `متبقٍ في الترانزيت: ${(line.qtyShipped - line.qtyReceived).toFixed(3)}`,
          createdAt: new Date(),
        });
        varianceIds.push(vRef.id);
      }
    }

    const finalStatus = varianceIds.length ? 'variance_reviewed' : 'received';
    tx.update(ref, { lines, status: finalStatus, receivedBy: actor.uid, receivedAt: new Date(), varianceIds });
    auditEntry(tx, db, { action: 'transfer.receive', entity: `transfers/${transferId}`, actorUid: actor.uid, before: { status: transfer.status }, after: { status: finalStatus, varianceIds } });
    return { ok: true, varianceIds };
  });
});

module.exports = { TRANSITIONS, submitTransfer, approveTransfer, rejectTransfer, cancelTransfer, shipTransfer, receiveTransfer };
