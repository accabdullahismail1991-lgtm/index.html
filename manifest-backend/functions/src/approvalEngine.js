const { getFirestore } = require('firebase-admin/firestore');

// Deliberately data, not code (spec requirement: "configurable, not
// hardcoded"). Reads a plain, unfiltered read outside any transaction —
// this is a threshold lookup, not part of the balance/ledger atomicity
// invariant, so it doesn't need transactional consistency with the write
// that follows it.
//
// approvalRules/{id}: { subjectType, minValue, maxValue|null, approverRoleId, active }
// Returns the highest-minValue matching rule, or null if none match (and
// the collection is empty until an admin screen or seed script populates
// it — that's expected right now, not a bug).
async function resolveApprovalRequirement(subjectType, value) {
  const db = getFirestore();
  const rulesSnap = await db
    .collection('approvalRules')
    .where('subjectType', '==', subjectType)
    .where('active', '==', true)
    .get();

  let matched = null;
  rulesSnap.forEach((doc) => {
    const r = doc.data();
    const min = r.minValue || 0;
    const inRange = value >= min && (r.maxValue == null || value < r.maxValue);
    if (inRange && (!matched || min > matched.minValue)) {
      matched = { id: doc.id, ...r, minValue: min };
    }
  });
  return matched;
}

module.exports = { resolveApprovalRequirement };
