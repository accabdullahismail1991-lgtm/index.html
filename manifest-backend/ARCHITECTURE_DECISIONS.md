# Manifest / Supply Chain Control Tower — Architecture Decisions

This document reinterprets the "Supply Chain Control Tower — Master AI Build
Prompt V1.0" specification for the backend the user chose: **Firebase
(Firestore + Cloud Functions)**, not a relational database. It exists so
every later phase builds on the same, explicit ground rules instead of each
new Cloud Function re-deciding them.

## 1. Scope

Single organization, multiple branches/locations — matching the actual
business (the restaurant group already running `index.html.html`), not a
multi-tenant SaaS product. No `organizations/{orgId}` wrapper collection;
every collection is top-level. If multi-tenant ever becomes a real
requirement, that is a deliberate future migration, not something to guess
at now.

`central-kitchen-prototype.html` ("Manifest") stays a standalone file per
the user's earlier explicit choice. It will be migrated, screen by screen,
from its current in-memory mock arrays to calling these Cloud Functions —
that migration is separate follow-up work, not part of this commit.

## 2. Relational → Firestore mapping

The spec is written in relational-database language (tables, foreign keys,
joins, an ERD). Firestore is a NoSQL document store, so:

- Every "table" becomes a top-level **collection** of documents.
- Every foreign key becomes a plain **ID field** (`itemId`, `locationId`,
  …) — Firestore does not enforce referential integrity, so every Cloud
  Function that writes one of these fields is responsible for validating
  the referenced document exists before committing.
- One-to-many detail data that is only ever read in the context of its
  parent (GPS pings, signatures) is a **subcollection**
  (`transfers/{id}/gpsLog`, `transfers/{id}/signatures`) instead of a join.
- Denormalized read-optimized fields are allowed (e.g. an item's `name`
  cached onto a transaction line) but only ever written by the Cloud
  Function that owns the source of truth, never entered independently by a
  client.

See `DATA_MODEL.md` for the concrete collection list.

## 3. The one non-negotiable invariant: no direct balance manipulation

This is the spec's central requirement (Section on the Inventory
Transaction Service) and the one decision everything else follows from:

- `stockBalances` (current quantity per item per location) and
  `inventoryTransactions` (the append-only ledger that produces those
  balances) can **never** be written directly by a client, from any screen,
  under any role — including admin.
- **Enforcement is two-layered, not just a convention:**
  1. `firestore.rules` sets `allow write: if false` on both collections.
     No exceptions, no role check that could be bypassed — the rule
     is unconditional.
  2. The *only* code path that writes them is
     `functions/src/inventoryTransactionService.js`'s
     `postInventoryTransaction()`, running under the Admin SDK (which is
     not subject to Firestore rules — that is the standard, correct
     Firebase pattern for a server-enforced invariant). Every higher-level
     flow (transfer receive, production consume/yield, waste, count
     adjustment, manual admin adjustment) calls this function internally;
     none of them ever construct a `stockBalances` or
     `inventoryTransactions` write of their own.
- Balances are **derived state**: if `stockBalances` is ever suspected
  wrong, the correct fix is to replay `inventoryTransactions` for that
  item/location, not to patch the balance document by hand. (A replay/
  rebuild function is future work, not built yet — noted in Section 6.)

## 4. RBAC

- Firebase Auth **custom claims** carry `roleId`, `branchId`, and a
  resolved `permissions` array (e.g. `inventory.adjust`,
  `transfer.approve`, `delivery.sign`). Claims are the only thing a Cloud
  Function trusts for authorization — never a role/permission field sent
  in the request body.
- `roles/{roleId}` documents are the source of truth for what a role can
  do. `setUserRole` (admin-only, itself permission-gated) resolves a
  role's permissions and writes them into the user's custom claims, so
  every subsequent request carries a fresh, server-computed permission
  list.
- Every callable Cloud Function starts with `requirePermission(auth, '<perm>')`
  from `functions/src/rbac.js`. A function with no such call at its top is
  a bug, not a shortcut.

## 5. Idempotency

The spec calls this out explicitly because of the mobile driver app
operating over unreliable connections. Every mutating callable accepts an
`idempotencyKey` from the client; `postInventoryTransaction()` checks (and
atomically claims) a matching `idempotencyKeys/{key}` document inside the
*same* Firestore transaction as the balance/ledger write, so a retried
request after a dropped response is a safe no-op (returns the original
`txId`) instead of double-posting.

## 6. State machines

Every workflow entity (`transfers`, and future `productionOrders`,
`counts`) has a `status` field and an explicit `TRANSITIONS` table checked
server-side (`assertTransition`) before any status write. A client can
*request* a transition (call `shipTransfer`, `receiveTransfer`, …); it can
never set `status` directly — `transfers` has `allow write: if false` in
rules for the same reason as the ledger.

## 7. Approval Engine

Implemented as **data, not code**: `approvalRules` documents
(`subjectType`, `minValue`, `maxValue`, approver role) are read at submit
time by `resolveApprovalRequirement()`. Changing a threshold is a Firestore
write to `approvalRules`, not a redeploy — matching the spec's explicit
"configurable, not hardcoded" requirement. No rules exist yet (empty
collection); the engine safely no-ops (no approval required) until an
admin screen or seed script populates them — that admin screen is future
work.

## 8. Variance Engine — worked example implemented literally

The spec's own acceptance example (80kg shipped, only 75kg received) is
implemented exactly, not simulated: `shipTransfer` moves 80kg
Warehouse → Transit; `receiveTransfer` moves only the 75kg the receiver
actually confirms, Transit → Branch, leaving 5kg sitting in Transit (never
silently discarded and never assumed delivered) and writes a
`variances` document for the 5kg delta. Only the transfer-shortage/overage
classification is implemented so far; the other 7 of the spec's 9 variance
types (count variance, production yield variance, etc.) are stubbed as
named constants in `varianceEngine.js` but not yet wired to a flow — see
Section 10.

## 9. Audit trail

`auditLog` is append-only (`allow write: if false` in rules, written only
by Cloud Functions via `auditEntry()`), and every mutating function in
this phase writes one entry, inside the same Firestore transaction as the
business write it's describing — so an audit entry can never exist without
its corresponding change, or vice versa.

## 10. What this phase does NOT include (explicitly, so it isn't assumed done)

This is Phase 0 (architecture) plus a first vertical slice of Phase 1
(Foundation), not the whole spec:

- No GPS/signature capture wiring — no mobile client exists yet to send
  real pings or capture real signatures. Nothing simulates them either
  ("No Fake Functionality" rule); the `transfers/{id}/gpsLog` and
  `.../signatures` subcollections are designed for in `DATA_MODEL.md` but
  have no writer function yet.
- No Notification Center delivery (push/SMS/email) — no
  `sendNotification` function exists yet.
- No Control Tower / Finance dashboards, no Reporting module.
- No production-order or physical-count flows — only `transfers` is
  built end-to-end as the reference pattern for the other workflow
  entities to follow.
- No balance-rebuild/replay tool.
- No live Firebase project. This code has been syntax-checked
  (`node --check`) but never run against a real Firestore instance or the
  Firebase emulator — this sandbox has no `firebase-tools`/Java installed
  and no network access to provision one. **A real Firebase project
  (with Firestore + Cloud Functions on the Blaze plan) and its config
  need to be created and shared before anything here can actually be
  deployed or tested.**
