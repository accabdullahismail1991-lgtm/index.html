// Stock snapshot reports: a frozen, point-in-time copy of stockBalances
// (with valuation) saved as its own document, so later reporting/trend
// screens can read a historical figure without replaying the ledger.
// First piece of the still-mostly-unbuilt Reporting module (Phase 9).
//
// Deliberately NOT run inside the balance-mutating transactions in
// inventoryTransactionService.js — a snapshot reads stockBalances, it
// never writes them, so it has nothing to do with the "no direct balance
// manipulation" invariant. It also does its own big collection reads
// OUTSIDE any Firestore transaction (see buildSnapshotData) and only
// wraps the small counter+write step in one — reading a potentially
// large collection inside a transaction is an anti-pattern (long-held
// locks, contention on the counters doc), not a consistency requirement.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { getFirestore } = require('firebase-admin/firestore');
const { requirePermission } = require('./rbac');
const { auditEntry } = require('./audit');
const { nextDocNumber } = require('./counters');

// Pure function, no Firestore involved — easy to unit test directly.
// balances: array of {itemId, locationId, qty}. costByItem: Map<itemId, number>.
function computeSnapshotTotals(balances, costByItem) {
  const byLocation = new Map();
  for (const b of balances) {
    if (!b.qty || Math.abs(b.qty) < 1e-9) continue; // skip empty balances
    const unitCost = costByItem.get(b.itemId) || 0;
    const value = b.qty * unitCost;
    if (!byLocation.has(b.locationId)) {
      byLocation.set(b.locationId, { locationId: b.locationId, items: [], locationValue: 0 });
    }
    const loc = byLocation.get(b.locationId);
    loc.items.push({ itemId: b.itemId, qty: b.qty, unitCost, value });
    loc.locationValue += value;
  }
  const locations = Array.from(byLocation.values());
  const grandTotalValue = locations.reduce((s, l) => s + l.locationValue, 0);
  const itemCount = locations.reduce((s, l) => s + l.items.length, 0);
  return { locations, grandTotalValue, itemCount };
}

// Note on scale: this reads the entire stockBalances and items
// collections in one shot. Fine for a catalog of hundreds to a few
// thousand location x item combinations; a real high-SKU multi-branch
// deployment would need this paginated/batched — not built yet, flagged
// here rather than silently assumed to scale.
async function buildSnapshotData(db) {
  const [balancesSnap, itemsSnap] = await Promise.all([
    db.collection('stockBalances').get(),
    db.collection('items').get(),
  ]);

  const costByItem = new Map();
  itemsSnap.forEach((doc) => costByItem.set(doc.id, doc.data().standardCost || 0));

  const balances = [];
  balancesSnap.forEach((doc) => balances.push(doc.data()));

  return computeSnapshotTotals(balances, costByItem);
}

async function createSnapshot(db, { takenBy, trigger }) {
  const data = await buildSnapshotData(db);
  const ref = db.collection('stockSnapshots').doc();

  const { docNumber } = await db.runTransaction(async (tx) => {
    const num = await nextDocNumber(tx, db, 'SNAP');
    tx.set(ref, {
      docNumber: num,
      takenAt: new Date(),
      takenBy: takenBy || null,
      trigger,
      locations: data.locations,
      grandTotalValue: data.grandTotalValue,
      itemCount: data.itemCount,
    });
    auditEntry(tx, db, {
      action: 'reports.snapshot',
      entity: `stockSnapshots/${ref.id}`,
      actorUid: trigger === 'scheduled' ? null : takenBy,
      before: null,
      after: { docNumber: num, grandTotalValue: data.grandTotalValue, itemCount: data.itemCount },
    });
    return { docNumber: num };
  });

  return { id: ref.id, docNumber, grandTotalValue: data.grandTotalValue, itemCount: data.itemCount };
}

const takeStockSnapshot = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'reports.snapshot');
  const db = getFirestore();
  return createSnapshot(db, { takenBy: actor.uid, trigger: 'manual' });
});

// Cairo time, matching the restaurant group's own timezone rather than
// UTC midnight — an "end of day" snapshot should mean the operator's day.
const dailyStockSnapshotSchedule = onSchedule(
  { schedule: 'every day 00:00', timeZone: 'Africa/Cairo' },
  async () => {
    const db = getFirestore();
    await createSnapshot(db, { takenBy: null, trigger: 'scheduled' });
  }
);

// --- Separate reports built ON TOP OF stockSnapshots, not the snapshot
// document itself. Each answers a different question and returns only
// the shape it needs — a trend chart doesn't want per-item detail, and a
// shortage report doesn't want a full valuation breakdown. ---

// Lightweight history for a trend chart: totals only, no per-item detail.
const listSnapshotHistory = onCall(async (request) => {
  await requirePermission(request.auth, 'reports.read');
  const db = getFirestore();
  const requested = Number((request.data || {}).limit);
  const n = Math.min(Math.max(Number.isFinite(requested) && requested > 0 ? requested : 30, 1), 200);

  const snap = await db.collection('stockSnapshots').orderBy('takenAt', 'desc').limit(n).get();
  const rows = [];
  snap.forEach((doc) => {
    const d = doc.data();
    rows.push({
      id: doc.id, docNumber: d.docNumber, takenAt: d.takenAt, trigger: d.trigger,
      grandTotalValue: d.grandTotalValue, itemCount: d.itemCount,
    });
  });
  rows.reverse(); // oldest-first, ready to feed straight into a chart
  return { rows };
});

// Pure function, no Firestore involved — easy to unit test directly.
// fromSnap/toSnap: {locations: [{locationId, items:[{itemId,qty,unitCost,value}]}], grandTotalValue}.
// A null-byte join key (not "_") avoids any collision with itemId/
// locationId strings that legitimately contain underscores.
function computeSnapshotDiff(fromSnap, toSnap) {
  const flatten = (snap) => {
    const map = new Map();
    for (const loc of snap.locations || []) {
      for (const it of loc.items || []) {
        map.set(`${loc.locationId}\u0000${it.itemId}`, {
          locationId: loc.locationId, itemId: it.itemId, qty: it.qty, value: it.value,
        });
      }
    }
    return map;
  };
  const fromMap = flatten(fromSnap);
  const toMap = flatten(toSnap);

  const rows = [];
  for (const k of new Set([...fromMap.keys(), ...toMap.keys()])) {
    const from = fromMap.get(k);
    const to = toMap.get(k);
    const ref = to || from;
    const qtyFrom = from ? from.qty : 0;
    const qtyTo = to ? to.qty : 0;
    const valueFrom = from ? from.value : 0;
    const valueTo = to ? to.value : 0;
    const qtyDelta = qtyTo - qtyFrom;
    const valueDelta = valueTo - valueFrom;
    if (Math.abs(qtyDelta) < 1e-9 && Math.abs(valueDelta) < 1e-9) continue; // unchanged, not worth a row
    rows.push({ locationId: ref.locationId, itemId: ref.itemId, qtyFrom, qtyTo, qtyDelta, valueFrom, valueTo, valueDelta });
  }

  return {
    rows,
    grandTotalValueFrom: fromSnap.grandTotalValue || 0,
    grandTotalValueTo: toSnap.grandTotalValue || 0,
    grandTotalValueDelta: (toSnap.grandTotalValue || 0) - (fromSnap.grandTotalValue || 0),
  };
}

// Compares two snapshots (explicit IDs, or defaults to "latest vs. the
// one right before it" — the common "what changed since last time" case).
const compareSnapshots = onCall(async (request) => {
  await requirePermission(request.auth, 'reports.read');
  const db = getFirestore();
  const { fromId, toId } = request.data || {};

  let toDoc;
  if (toId) {
    toDoc = await db.collection('stockSnapshots').doc(toId).get();
    if (!toDoc.exists) throw new HttpsError('not-found', 'صورة المخزون (to) غير موجودة');
  } else {
    const latest = await db.collection('stockSnapshots').orderBy('takenAt', 'desc').limit(1).get();
    if (latest.empty) throw new HttpsError('failed-precondition', 'لا توجد صور مخزون محفوظة بعد');
    toDoc = latest.docs[0];
  }

  let fromDoc;
  if (fromId) {
    fromDoc = await db.collection('stockSnapshots').doc(fromId).get();
    if (!fromDoc.exists) throw new HttpsError('not-found', 'صورة المخزون (from) غير موجودة');
  } else {
    const prior = await db.collection('stockSnapshots')
      .where('takenAt', '<', toDoc.data().takenAt)
      .orderBy('takenAt', 'desc')
      .limit(1)
      .get();
    if (prior.empty) throw new HttpsError('failed-precondition', 'لا توجد صورة سابقة لمقارنتها بها');
    fromDoc = prior.docs[0];
  }

  const diff = computeSnapshotDiff(fromDoc.data(), toDoc.data());
  return {
    from: { id: fromDoc.id, docNumber: fromDoc.data().docNumber, takenAt: fromDoc.data().takenAt },
    to: { id: toDoc.id, docNumber: toDoc.data().docNumber, takenAt: toDoc.data().takenAt },
    ...diff,
  };
});

// Pure function, no Firestore involved.
// activeLocationIds: every location that should be checked — NOT just the
// ones present in the snapshot. computeSnapshotTotals skips zero-qty
// balances, so a location that's completely out of an item (or entirely
// empty) never appears in the snapshot's own `locations` array at all;
// building this report off the snapshot's location list alone would make
// total stockouts — the single most important case — silently invisible.
// snapshotLocations: the snapshot's own `locations` array, used only as a
// lookup index here, never as the iteration source.
// reorderItems: [{itemId, reorderPoint}], reorderPoint > 0 only.
function computeLowStockRows(activeLocationIds, snapshotLocations, reorderItems) {
  const qtyIndex = new Map();
  for (const loc of snapshotLocations) {
    for (const it of loc.items || []) {
      qtyIndex.set(`${loc.locationId}\u0000${it.itemId}`, it.qty);
    }
  }

  const rows = [];
  for (const locationId of activeLocationIds) {
    for (const { itemId, reorderPoint } of reorderItems) {
      const qty = qtyIndex.get(`${locationId}\u0000${itemId}`) ?? 0;
      if (qty < reorderPoint) {
        rows.push({ locationId, itemId, qty, reorderPoint, shortBy: reorderPoint - qty });
      }
    }
  }
  return rows;
}

const getLowStockReport = onCall(async (request) => {
  await requirePermission(request.auth, 'reports.read');
  const db = getFirestore();

  const latest = await db.collection('stockSnapshots').orderBy('takenAt', 'desc').limit(1).get();
  if (latest.empty) throw new HttpsError('failed-precondition', 'لا توجد صور مخزون محفوظة بعد');
  const snapDoc = latest.docs[0];
  const snapData = snapDoc.data();

  const [itemsSnap, locationsSnap] = await Promise.all([
    db.collection('items').get(),
    db.collection('locations').where('isActive', '==', true).get(),
  ]);

  const reorderItems = [];
  itemsSnap.forEach((doc) => {
    const d = doc.data();
    if (typeof d.reorderPoint === 'number' && d.reorderPoint > 0) reorderItems.push({ itemId: doc.id, reorderPoint: d.reorderPoint });
  });
  const activeLocationIds = [];
  locationsSnap.forEach((doc) => activeLocationIds.push(doc.id));

  const rows = computeLowStockRows(activeLocationIds, snapData.locations || [], reorderItems);
  return { snapshotId: snapDoc.id, docNumber: snapData.docNumber, takenAt: snapData.takenAt, rows };
});

module.exports = {
  computeSnapshotTotals,
  buildSnapshotData,
  createSnapshot,
  takeStockSnapshot,
  dailyStockSnapshotSchedule,
  listSnapshotHistory,
  computeSnapshotDiff,
  compareSnapshots,
  computeLowStockRows,
  getLowStockReport,
};
