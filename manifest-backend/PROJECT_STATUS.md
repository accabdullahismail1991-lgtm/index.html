# Manifest / Supply Chain Control Tower — Project Status

Tracks progress against the 10 phases described in the "Supply Chain
Control Tower — Master AI Build Prompt V1.0". Updated at the end of every
work session on this backend, not just at milestones.

| Phase | Description (per spec) | Status |
|---|---|---|
| 0 | Project inspection & architecture alignment | **Done** — see `ARCHITECTURE_DECISIONS.md` |
| 1 | Foundation: auth, RBAC, master data, core inventory ledger | **In progress** — RBAC (`rbac.js`), Inventory Transaction Service (`inventoryTransactionService.js`), and the `transfers` workflow end-to-end (submit → approve → ship → receive → variance) are built and syntax-checked. Master-data collections (`items`, `locations`) are designed in `DATA_MODEL.md` but have no admin CRUD screens or seed data yet. |
| 2 | Transfers & Transit as a real location | **In progress** — covered by the Phase 1 slice above (ship moves stock into `locations/transit`; receive moves only the confirmed quantity out, leaving the shortfall visible in Transit + a variance record). GPS/signature capture not started (no mobile client). |
| 3 | Production orders (BOM consumption + yield) | Not started |
| 4 | Physical / cycle counts | Not started |
| 5 | Variance Engine (all 9 classification types) | Partially started — only transfer shortage/overage implemented as the reference pattern (`varianceEngine.js`); other 7 types stubbed as named constants only |
| 6 | Approval Engine | Started — configurable threshold-rule lookup (`approvalEngine.js`) works against an `approvalRules` collection, but that collection has no admin screen or seed data yet, so no rule currently matches anything |
| 7 | Automation Engine / event-driven workflows | Not started |
| 8 | Notification Center | Not started |
| 9 | Dashboards (Control Tower home, Finance) & Reporting | Not started |
| 10 | Production readiness (security review, load, docs) | Not started |

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
