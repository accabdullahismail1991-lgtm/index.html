// Standalone logic tests against an in-memory Firestore mock — this
// sandbox has no firebase-tools/Java to run the real emulator (see
// PROJECT_STATUS.md). This does NOT replace testing against a real
// project before deploy, and it does not exercise the onCall() wrappers
// themselves (permission gating, request parsing) — only the internal
// two-phase posting/variance logic that transfers.js and production.js
// are built on. Covers both the transfer flow and the production flow.
//
// Run: node test/logic.test.js
const assert = require('node:assert/strict');
const {
  prepareInventoryPosting,
  commitInventoryPosting,
  postInventoryTransaction,
} = require('../src/inventoryTransactionService');
const { classifyTransferVariance, classifyProductionVariance } = require('../src/varianceEngine');

let autoId = 0;

function makeFakeDb(store) {
  function collection(name) {
    return {
      doc(id) {
        const docId = id || `auto${++autoId}`;
        return { id: docId, path: `${name}/${docId}` };
      },
    };
  }
  return { collection };
}

// Mirrors the real Firestore transaction constraint: once any write has
// been issued, no further reads are allowed. This is exactly the bug
// class the two-phase prepare/commit split exists to avoid.
function makeFakeTx(store) {
  let writesStarted = false;
  const pending = [];
  return {
    async get(ref) {
      if (writesStarted) throw new Error(`READ AFTER WRITE on ${ref.path} — transaction ordering violated`);
      const val = store.get(ref.path);
      return { exists: val !== undefined, data: () => val };
    },
    set(ref, data, opts) {
      writesStarted = true;
      const prev = store.get(ref.path);
      const merged = opts && opts.merge && prev ? { ...prev, ...data } : data;
      pending.push(() => store.set(ref.path, merged));
    },
    update(ref, data) {
      writesStarted = true;
      const prev = store.get(ref.path) || {};
      pending.push(() => store.set(ref.path, { ...prev, ...data }));
    },
    _commit() {
      pending.forEach((w) => w());
    },
  };
}

async function runTransaction(store, fn) {
  const tx = makeFakeTx(store);
  const result = await fn(tx);
  tx._commit();
  return result;
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`ok   - ${name}`);
  } catch (e) {
    console.log(`FAIL - ${name}`);
    console.log(e.stack || e.message);
    process.exitCode = 1;
  }
}

(async () => {
  await test('single posting from an empty balance', async () => {
    const store = new Map();
    const db = makeFakeDb(store);
    const res = await runTransaction(store, (tx) =>
      postInventoryTransaction(db, tx, { type: 'receive', itemId: 'ITEM1', locationId: 'WH1', qty: 10, actorUid: 'u1' })
    );
    assert.equal(res.duplicate, false);
    assert.equal(store.get('stockBalances/WH1_ITEM1').qty, 10);
    assert.equal(store.get(`inventoryTransactions/${res.txId}`).after, 10);
  });

  await test('rejects a posting that would go negative', async () => {
    const store = new Map();
    const db = makeFakeDb(store);
    await assert.rejects(
      runTransaction(store, (tx) =>
        postInventoryTransaction(db, tx, { type: 'issue', itemId: 'ITEM1', locationId: 'WH1', qty: -5, actorUid: 'u1' })
      ),
      /failed-precondition|سالبًا/
    );
    assert.equal(store.has('stockBalances/WH1_ITEM1'), false);
  });

  await test('idempotency key dedupes a replayed posting', async () => {
    const store = new Map();
    const db = makeFakeDb(store);
    const opts = { type: 'receive', itemId: 'ITEM1', locationId: 'WH1', qty: 10, actorUid: 'u1', idempotencyKey: 'k1' };
    const r1 = await runTransaction(store, (tx) => postInventoryTransaction(db, tx, opts));
    const r2 = await runTransaction(store, (tx) => postInventoryTransaction(db, tx, opts));
    assert.equal(r1.duplicate, false);
    assert.equal(r2.duplicate, true);
    assert.equal(r2.txId, r1.txId);
    assert.equal(store.get('stockBalances/WH1_ITEM1').qty, 10); // not double-posted
  });

  await test('multi-line prepare-all-then-commit-all never reads after a write', async () => {
    const store = new Map();
    store.set('stockBalances/WH1_ITEM1', { itemId: 'ITEM1', locationId: 'WH1', qty: 100 });
    store.set('stockBalances/WH1_ITEM2', { itemId: 'ITEM2', locationId: 'WH1', qty: 50 });
    const db = makeFakeDb(store);

    await runTransaction(store, async (tx) => {
      const lines = [
        { itemId: 'ITEM1', qty: 20 },
        { itemId: 'ITEM2', qty: 5 },
      ];
      const postings = [];
      for (const line of lines) {
        postings.push(await prepareInventoryPosting(db, tx, { type: 'transfer_out', itemId: line.itemId, locationId: 'WH1', qty: -line.qty }));
        postings.push(await prepareInventoryPosting(db, tx, { type: 'transfer_in', itemId: line.itemId, locationId: 'TRANSIT', qty: line.qty }));
      }
      for (const p of postings) commitInventoryPosting(db, tx, p, { actorUid: 'u1', refType: 'transfer', refId: 'TR-TEST' });
    });

    assert.equal(store.get('stockBalances/WH1_ITEM1').qty, 80);
    assert.equal(store.get('stockBalances/WH1_ITEM2').qty, 45);
    assert.equal(store.get('stockBalances/TRANSIT_ITEM1').qty, 20);
    assert.equal(store.get('stockBalances/TRANSIT_ITEM2').qty, 5);
  });

  await test("spec's worked example: 80kg shipped, 75kg received — shortfall stays in Transit + a variance is raised", async () => {
    const store = new Map();
    store.set('stockBalances/WAREHOUSE_ITEM1', { itemId: 'ITEM1', locationId: 'WAREHOUSE', qty: 100 });
    const db = makeFakeDb(store);

    // ship: Warehouse -> Transit
    await runTransaction(store, async (tx) => {
      const p1 = await prepareInventoryPosting(db, tx, { type: 'transfer_out', itemId: 'ITEM1', locationId: 'WAREHOUSE', qty: -80 });
      const p2 = await prepareInventoryPosting(db, tx, { type: 'transfer_in', itemId: 'ITEM1', locationId: 'TRANSIT', qty: 80 });
      commitInventoryPosting(db, tx, p1, { actorUid: 'driver1' });
      commitInventoryPosting(db, tx, p2, { actorUid: 'driver1' });
    });
    assert.equal(store.get('stockBalances/WAREHOUSE_ITEM1').qty, 20);
    assert.equal(store.get('stockBalances/TRANSIT_ITEM1').qty, 80);

    // receive: only 75kg confirmed — Transit -> Branch
    await runTransaction(store, async (tx) => {
      const p1 = await prepareInventoryPosting(db, tx, { type: 'transfer_out', itemId: 'ITEM1', locationId: 'TRANSIT', qty: -75 });
      const p2 = await prepareInventoryPosting(db, tx, { type: 'transfer_in', itemId: 'ITEM1', locationId: 'BRANCH1', qty: 75 });
      commitInventoryPosting(db, tx, p1, { actorUid: 'receiver1' });
      commitInventoryPosting(db, tx, p2, { actorUid: 'receiver1' });
    });

    assert.equal(store.get('stockBalances/WAREHOUSE_ITEM1').qty, 20);
    assert.equal(store.get('stockBalances/TRANSIT_ITEM1').qty, 5); // not silently discarded
    assert.equal(store.get('stockBalances/BRANCH1_ITEM1').qty, 75);

    const variance = classifyTransferVariance(80, 75);
    assert.equal(variance.type, 'transfer_shortage');
    assert.equal(variance.qtyDelta, -5);
  });

  await test('classifyTransferVariance returns null when shipped equals received', () => {
    assert.equal(classifyTransferVariance(80, 80), null);
  });

  await test('classifyProductionVariance flags shortage and overage correctly', () => {
    const shortage = classifyProductionVariance(10, 8);
    assert.equal(shortage.type, 'production_yield_shortage');
    assert.equal(shortage.qtyDelta, -2);

    const overage = classifyProductionVariance(10, 11);
    assert.equal(overage.type, 'production_yield_overage');
    assert.equal(overage.qtyDelta, 1);

    assert.equal(classifyProductionVariance(10, 10), null);
  });

  await test('total-loss transfer leg (0 received): no transfer_in posting, full shortfall stays a variance', async () => {
    const store = new Map();
    store.set('stockBalances/TRANSIT_ITEM1', { itemId: 'ITEM1', locationId: 'TRANSIT', qty: 10 });
    const db = makeFakeDb(store);

    // Mirrors receiveTransfer's zero-qty skip: only prepare/commit a
    // posting when qtyReceived > 0.
    await runTransaction(store, async (tx) => {
      const qtyReceived = 0;
      if (qtyReceived > 0) {
        const p1 = await prepareInventoryPosting(db, tx, { type: 'transfer_out', itemId: 'ITEM1', locationId: 'TRANSIT', qty: -qtyReceived });
        commitInventoryPosting(db, tx, p1, { actorUid: 'receiver1' });
      }
    });

    // Transit balance is untouched — the goods were never confirmed
    // received, so nothing was moved out of Transit on the receiving side.
    assert.equal(store.get('stockBalances/TRANSIT_ITEM1').qty, 10);
    const variance = classifyTransferVariance(10, 0);
    assert.equal(variance.type, 'transfer_shortage');
    assert.equal(variance.qtyDelta, -10);
  });

  await test('production: consume components at start, yield at completion, variance on short yield', async () => {
    const store = new Map();
    store.set('stockBalances/KITCHEN1_FLOUR', { itemId: 'FLOUR', locationId: 'KITCHEN1', qty: 50 });
    store.set('stockBalances/KITCHEN1_YEAST', { itemId: 'YEAST', locationId: 'KITCHEN1', qty: 5 });
    const db = makeFakeDb(store);

    // startProduction: consume 20 flour + 2 yeast for a planned 30-unit batch
    await runTransaction(store, async (tx) => {
      const components = [{ itemId: 'FLOUR', qtyPlanned: 20 }, { itemId: 'YEAST', qtyPlanned: 2 }];
      const postings = [];
      for (const c of components) {
        if (!(c.qtyPlanned > 0)) continue;
        postings.push(await prepareInventoryPosting(db, tx, { type: 'production_consume', itemId: c.itemId, locationId: 'KITCHEN1', qty: -c.qtyPlanned }));
      }
      for (const p of postings) commitInventoryPosting(db, tx, p, { actorUid: 'chef1', refType: 'production', refId: 'PO-TEST' });
    });
    assert.equal(store.get('stockBalances/KITCHEN1_FLOUR').qty, 30);
    assert.equal(store.get('stockBalances/KITCHEN1_YEAST').qty, 3);

    // completeProduction: only 28 units actually came out of the oven
    const plannedQty = 30;
    const actualYieldQty = 28;
    await runTransaction(store, async (tx) => {
      const posting = actualYieldQty > 0
        ? await prepareInventoryPosting(db, tx, { type: 'production_yield', itemId: 'BREAD', locationId: 'KITCHEN1', qty: actualYieldQty })
        : null;
      if (posting) commitInventoryPosting(db, tx, posting, { actorUid: 'chef1', refType: 'production', refId: 'PO-TEST' });
    });
    assert.equal(store.get('stockBalances/KITCHEN1_BREAD').qty, 28);

    const variance = classifyProductionVariance(plannedQty, actualYieldQty);
    assert.equal(variance.type, 'production_yield_shortage');
    assert.equal(variance.qtyDelta, -2);
  });

  await test('a read after a write throws (mock sanity check for the ordering rule itself)', async () => {
    const store = new Map();
    const db = makeFakeDb(store);
    await assert.rejects(
      runTransaction(store, async (tx) => {
        await prepareInventoryPosting(db, tx, { type: 'receive', itemId: 'X', locationId: 'WH1', qty: 1 });
        tx.set(db.collection('foo').doc('bar'), { a: 1 });
        await tx.get(db.collection('foo').doc('bar')); // should throw
      }),
      /READ AFTER WRITE/
    );
  });
})();
