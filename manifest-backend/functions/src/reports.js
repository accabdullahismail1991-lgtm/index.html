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

const { onCall } = require('firebase-functions/v2/https');
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

module.exports = {
  computeSnapshotTotals,
  buildSnapshotData,
  createSnapshot,
  takeStockSnapshot,
  dailyStockSnapshotSchedule,
};
