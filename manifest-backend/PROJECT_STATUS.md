# Manifest / Supply Chain Control Tower — Project Status

Tracks progress against the 10 phases described in the "Supply Chain
Control Tower — Master AI Build Prompt V1.0". Updated at the end of every
work session on this backend, not just at milestones.

| Phase | Description (per spec) | Status |
|---|---|---|
| 0 | Project inspection & architecture alignment | **Done** — see `ARCHITECTURE_DECISIONS.md` |
| 1 | Foundation: auth, RBAC, master data, core inventory ledger | **In progress** — RBAC (`rbac.js`), Inventory Transaction Service (`inventoryTransactionService.js`), the `transfers` workflow (submit → approve/reject/cancel → ship → receive → variance), and `productionOrders` (create → start → complete/cancel → variance) are built, syntax-checked, and covered by logic tests. Master-data collections (`items`, `locations`) are designed in `DATA_MODEL.md` but have no admin CRUD screens or seed data yet. |
| 2 | Transfers & Transit as a real location | **In progress** — ship moves stock into `locations/transit`; receive moves only the confirmed quantity out (including the 0-received/total-loss edge case), leaving any shortfall visible in Transit + a variance record. Reject and cancel (pre-shipment only) are now implemented. GPS/signature capture not started (no mobile client). |
| 3 | Production orders (BOM consumption + yield) | **In progress** — `production.js`: components consumed at start, yield posted at completion, variance raised on planned-vs-actual mismatch. Cancel only works pre-consumption (see known limitation below). Not yet wired to a real BOM/recipe source (caller must pass `components` explicitly). |
| 4 | Physical / cycle counts | Not started — next in line, following the same prepare/commit pattern as transfers and production |
| 5 | Variance Engine (all 9 classification types) | Partially started — transfer shortage/overage and production yield shortage/overage implemented (`varianceEngine.js`); other 5 types (count, waste, expiry, unexplained adjustment) stubbed as named constants only |
| 6 | Approval Engine | Started — configurable threshold-rule lookup (`approvalEngine.js`) works against an `approvalRules` collection, but that collection has no admin screen or seed data yet, so no rule currently matches anything |
| 7 | Automation Engine / event-driven workflows | Not started |
| 8 | Notification Center | Not started |
| 9 | Dashboards (Control Tower home, Finance) & Reporting | **Started** — stock snapshot reports (`reports.js`): `takeStockSnapshot` (on demand) and `dailyStockSnapshotSchedule` (automatic, Cairo midnight) both freeze `stockBalances` + valuation into a `stockSnapshots` document. No dashboards, no other report types (movement history export, variance summary, sales/costing reports) yet. |
| 10 | Production readiness (security review, load, docs) | Not started |

## Bugs fixed this pass

Found during a self-review of the first commit, before any of it had run
against real data:

- **Zero-quantity transfer/production legs crashed the whole flow.** The
  Inventory Transaction Service correctly rejects a `qty === 0` posting as
  meaningless — but `transfers.js` and `production.js` weren't skipping
  zero-qty lines (an item pulled from a shipment, a total-loss line)
  before calling it, so a legitimate zero would have thrown and aborted
  the entire transfer or production order. Fixed by skipping zero-qty
  legs in both callers; the shortfall is still fully captured by the
  variance record.
- **`pending_approval → rejected` was a valid transition with no function
  to reach it**, and there was no way to cancel a transfer at all. Added
  `rejectTransfer` and `cancelTransfer` (the latter only before shipment —
  see ARCHITECTURE_DECISIONS.md §10 for why after-shipment cancellation
  isn't modeled yet).

## Note: the scheduled snapshot needs Cloud Scheduler, not just Firestore

`dailyStockSnapshotSchedule` (in `reports.js`) is a `firebase-functions/v2/scheduler`
function — deploying it provisions a Cloud Scheduler job automatically,
which is a separate (still Blaze-plan, still small/effectively-free at
this scale) Google Cloud service from Firestore/Cloud Functions
themselves. Nothing extra to configure by hand, just flagging that it's
one more thing that needs the real project to exist before it can run.

## Known gap: no live Firebase project

Nothing in `manifest-backend/` has been deployed or run against a real
Firestore instance — this sandbox has no `firebase-tools`/Java and no
network path to provision a Firebase project. Code has been validated with
`node --check` only. **Next real blocker:** a Firebase project (Firestore
+ Cloud Functions, Blaze billing plan — Cloud Functions require it even
for light usage) needs to exist and its config/service-account needs to be
shared before this can be deployed and actually tested end-to-end.

## Not yet started, deliberately

`central-kitchen-prototype.html` (Manifest UI) still runs entirely on its
original in-memory mock arrays. Wiring specific screens to call these
Cloud Functions instead is separate follow-up work, done incrementally
once there's a real backend to call.
