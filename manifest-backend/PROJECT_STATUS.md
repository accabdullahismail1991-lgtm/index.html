# Madar (مدار) / Supply Chain Control Tower — Project Status

Product name as of this pass: **مدار (Madar)**, formerly "Manifest" during
early prototyping. The `manifest-backend/` folder path and internal doc
filenames are kept as-is (an implementation detail, not user-facing
branding) rather than renamed along with the product — see
`MADAR_USER_GUIDE.md` at the repo root for the user-facing name.

Tracks progress against the 10 phases described in the "Supply Chain
Control Tower — Master AI Build Prompt V1.0". Updated at the end of every
work session on this backend, not just at milestones.

| Phase | Description (per spec) | Status |
|---|---|---|
| 0 | Project inspection & architecture alignment | **Done** — see `ARCHITECTURE_DECISIONS.md` |
| 1 | Foundation: auth, RBAC, master data, core inventory ledger | **In progress** — RBAC (`rbac.js`), Inventory Transaction Service (`inventoryTransactionService.js`), the `transfers` workflow (submit → approve/reject/cancel → ship → receive → variance), and `productionOrders` (create → start → complete/cancel → variance) are built, syntax-checked, and covered by logic tests. Master-data collections (`items`, `locations`) are designed in `DATA_MODEL.md` but have no admin CRUD screens or seed data yet. |
| 2 | Transfers & Transit as a real location | **In progress** — ship moves stock into `locations/transit`; receive moves only the confirmed quantity out (including the 0-received/total-loss edge case), leaving any shortfall visible in Transit + a variance record. Reject and cancel (pre-shipment only) are now implemented. GPS/signature capture not started (no mobile client). |
| 3 | Production orders (BOM consumption + yield) | **In progress** — `production.js`: components consumed at start, yield posted at completion, variance raised on planned-vs-actual mismatch. Cancel only works pre-consumption (see known limitation below). Not yet wired to a real BOM/recipe source (caller must pass `components` explicitly). |
| 4 | Physical / cycle counts | **In progress** — `counts.js`: start (register items to count) → submit (record counted quantities, display-only system-qty snapshot) → apply (post the live-balance-computed delta to the ledger, raise a variance on mismatch) → or cancel (allowed pre-apply). No UI/flow yet for generating which items to count. |
| 5 | Variance Engine (all 9 classification types) | Partially started — transfer shortage/overage, production yield shortage/overage, and count shortage/overage implemented (`varianceEngine.js`); other 2 types (waste, unexplained adjustment) stubbed as named constants only |
| 6 | Approval Engine | **In progress** — configurable threshold-rule lookup (`approvalEngine.js`) plus rule management (`createApprovalRule`/`updateApprovalRule` in `approvalRules.js`, validated, audited, soft-delete only). No rules exist by default and no admin *screen* exists yet — but a rule can now actually be created via a direct Cloud Function call, closing the loop that Pass 1's `submitTransfer` approval gate depended on. |
| 7 | Automation Engine / event-driven workflows | Not started |
| 8 | Notification Center | Not started |
| 9 | Dashboards (Control Tower home, Finance) & Reporting | **Started** — `reports.js`: `takeStockSnapshot`/`dailyStockSnapshotSchedule` freeze balances+valuation into `stockSnapshots`; three separate read-only reports build on top of that data — `listSnapshotHistory` (trend list), `compareSnapshots` (period-over-period deltas), `getLowStockReport` (shortage alerts, correctly catching total stockouts — see below). No dashboards, no other report types (movement history export, variance summary, sales/costing reports) yet. |
| 10 | Production readiness (security review, load, docs) | Not started |

## Changelog — bugs and notable design decisions, by pass

**Pass 1 (transfers + production foundation):**
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
  see ARCHITECTURE_DECISIONS.md §11 for why after-shipment cancellation
  isn't modeled yet).

**Pass 2 (reports):**
- **`getLowStockReport` almost missed the most important case.**
  `computeSnapshotTotals` deliberately skips zero-quantity balances (right
  for a valuation snapshot — a zero-value row adds nothing there). But a
  low-stock report's entire purpose is catching shortages, and a complete
  stockout (qty 0) is the case that matters most — building the report
  off the snapshot's own `locations` list would have made total stockouts
  silently invisible, since a fully-out location never has a non-zero
  balance to appear there. Fixed by driving the report from the full
  active `locations` collection instead, using the snapshot purely as a
  qty lookup. Covered by a dedicated test.
- Caught while writing `computeSnapshotDiff`/`computeLowStockRows`: an
  earlier edit briefly wrote a **raw NUL byte** into `reports.js` (meant
  to be the source text `\u0000`, a collision-safe map-key separator, not
  an actual control character in the file). Fixed at the byte level
  before it was ever committed — `node --check` and a `grep`-for-`\x00`
  pass both confirm it's gone.

**Pass 3 (counts):**
- **Caught during design, before it was ever written naively:** computing
  a physical count's applied delta from the balance snapshot taken at
  submit-time (rather than the live balance at apply-time) would silently
  post the wrong delta whenever other activity touched the same location
  during the counting window -- see ARCHITECTURE_DECISIONS.md section 10
  for the full reasoning and test/logic.test.js's drift-scenario test that
  proves the live-balance approach lands correctly where the stale-
  snapshot approach would not.

**Pass 4 (approval rule management):**
- **`firestore.rules` gated `approvalRules` reads on `users.manageRoles`**
  -- a permission about managing user *roles*, not approval *thresholds*.
  Harmless while nothing wrote to that collection (Pass 1-3), but would
  have quietly let the wrong set of people read approval configuration
  once a real admin UI existed. Fixed to `approvals.manageRules`, the
  permission `approvalRules.js`'s own Cloud Functions actually check.

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

`central-kitchen-prototype.html` (Madar UI) still runs entirely on its
original in-memory mock arrays. Wiring specific screens to call these
Cloud Functions instead is separate follow-up work, done incrementally
once there's a real backend to call.
