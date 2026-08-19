# Madar Backend — Firestore Data Model

Top-level collections. `*` = built and enforced in this phase; everything
else is designed here so later phases have a fixed target, but has no
Cloud Function writing it yet.

## Master data

- **`users/{uid}`*** — `roleId`, `branchId`, `active`, `updatedAt`,
  `updatedBy`. Mirrors the uid's Auth custom claims for admin-screen
  reads (claims themselves aren't queryable from Firestore).
- **`roles/{roleId}`*** — `name`, `permissions: string[]`, `scope`
  (`global` | `branch`).
- **`locations/{locationId}`** — `type` (`warehouse` | `branch` |
  `transit` | `kitchen`), `name`, `address`, `isActive`. The Transit
  location is a real document (`locations/transit`), not a special case —
  per the spec's requirement that Transit be a real logical location.
- **`items/{itemId}`** — `sku`, `name`, `uom`, `category`, `kind`
  (`raw` | `semi` | `finished`), `standardCost`, `reorderPoint`.

## Inventory ledger (server-only writes)

- **`stockBalances/{locationId}_{itemId}`*** — `itemId`, `locationId`,
  `qty`, `updatedAt`. Derived state — see ARCHITECTURE_DECISIONS.md §3.
- **`inventoryTransactions/{txId}`*** — `type` (one of
  `receive|issue|transfer_out|transfer_in|adjustment|production_consume|
  production_yield|waste|count_variance`), `itemId`, `locationId`, `qty`
  (signed), `before`, `after`, `refType`, `refId`, `actorUid`, `note`,
  `idempotencyKey`, `createdAt`. Append-only, never updated or deleted.
- **`idempotencyKeys/{key}`*** — `createdAt`, `actorUid`, `txId`. No
  client read/write path at all; purely a server-side dedupe guard.

## Workflow entities

- **`transfers/{id}`*** — `docNumber` (`TR-0001`, …), `fromLocationId`,
  `toLocationId`, `status` (see `transfers.js`'s `TRANSITIONS`), `lines:
  [{itemId, qtyRequested, qtyShipped, qtyReceived}]`, `notes`,
  `approvalRuleId`, `submittedBy`, `shippedBy`, `receivedBy`,
  `varianceIds`, timestamps.
  - `transfers/{id}/gpsLog/{pingId}` — designed, not yet written:
    `lat`, `lng`, `recordedAt`, `source` (must be a real device ping —
    never fabricated).
  - `transfers/{id}/signatures/{sigId}` — designed, not yet written:
    `role` (`driver_confirm` | `receiver_confirm`), `imageRef` (Cloud
    Storage path), `signedBy`, `geoloc`, `signedAt`.
- **`productionOrders/{id}`*** — `docNumber` (`PO-0001`, …), `itemId`
  (the item being produced), `locationId`, `plannedQty`, `actualYieldQty`
  (`null` until completed), `components: [{itemId, qtyPlanned,
  qtyConsumed}]`, `status` (`planned` → `in_progress` → `completed`, or
  `planned` → `cancelled`), `createdBy`/`startedBy`/`completedBy`/
  `cancelledBy`, `varianceId`, timestamps. Components are consumed at
  `start`, yield is posted at `complete` — see `production.js`'s header
  comment for why, and revisit if the real kitchen workflow differs.
- **`counts/{id}`** — designed, not yet built: cycle/physical count
  sessions, `lines`, `status`.
- **`variances/{id}`*** (transfer and production-yield shortage/overage so far) —
  `type`, `subjectType`, `subjectId`, `itemId`, `qtyDelta`, `status`
  (`open` | `reviewed` | `resolved`), `note`, `createdAt`.
- **`wasteLogs/{id}`** — designed, not yet built.
- **`approvalRules/{id}`*** — `subjectType`, `minValue`, `maxValue`,
  `approverRoleId`, `active`. Empty until an admin screen or seed script
  populates it.

## Cross-cutting

- **`auditLog/{id}`*** — `action`, `entity`, `actorUid`, `before`,
  `after`, `at`. Append-only, written inside the same transaction as the
  change it describes.
- **`counters/{name}`*** — `value`. Transactional increment source for
  human-readable document numbers (`TR-0001`, `PO-0001`, `SNAP-0001`,
  future `WL-`, …).
- **`stockSnapshots/{id}`*** — `docNumber` (`SNAP-0001`, …), `takenAt`,
  `takenBy` (uid, or `null` for the scheduled run), `trigger` (`manual` |
  `scheduled`), `locations: [{locationId, items: [{itemId, qty, unitCost,
  value}], locationValue}]`, `grandTotalValue`, `itemCount`. A frozen
  point-in-time copy of `stockBalances` with valuation attached — never
  itself replayed or corrected, a new snapshot is just taken again.
  Written by `takeStockSnapshot` (on demand) or `dailyStockSnapshotSchedule`
  (Cairo midnight, automatic). Read by three separate report callables,
  none of which write anything: `listSnapshotHistory` (lightweight
  totals-only trend list), `compareSnapshots` (period-over-period
  qty/value deltas, defaults to latest-vs-previous), and
  `getLowStockReport` (cross-references the latest snapshot against every
  active `locations` doc and every `items.reorderPoint` — deliberately
  driven by the master location list, not the snapshot's own sparse one,
  so a location that's completely out of stock is still flagged instead
  of silently missing because it has no non-zero balance to appear in the
  snapshot at all).
- **`notifications/{uid}/items/{id}`** — designed, not yet built.
