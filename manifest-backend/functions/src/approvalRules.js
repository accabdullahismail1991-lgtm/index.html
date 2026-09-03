// Management (create/update) for approvalRules -- the resolution/lookup
// side lives in approvalEngine.js. Split out because resolveApprovalRequirement
// is called on the hot path of every submitTransfer, while these are
// admin-only, occasional writes; keeping them apart also means the
// lookup logic never accidentally depends on anything admin-only.
//
// Rules are never hard-deleted, only deactivated (active:false). A rule
// is what determined whether a real transfer needed approval at some
// point in the past -- silently erasing that from a "why was this
// auto-approved" audit trail would be worse than an unused, inactive row
// sitting in the collection.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore } = require('firebase-admin/firestore');
const { requirePermission } = require('./rbac');
const { auditEntry } = require('./audit');

function validateRuleShape({ subjectType, minValue, maxValue }) {
  if (!subjectType || typeof subjectType !== 'string') {
    throw new HttpsError('invalid-argument', 'subjectType مطلوب');
  }
  if (typeof minValue !== 'number' || minValue < 0) {
    throw new HttpsError('invalid-argument', 'minValue يجب أن يكون رقمًا غير سالب');
  }
  if (maxValue != null && (typeof maxValue !== 'number' || maxValue <= minValue)) {
    throw new HttpsError('invalid-argument', 'maxValue يجب أن يكون أكبر من minValue');
  }
}

const createApprovalRule = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'approvals.manageRules');
  const { subjectType, minValue, maxValue, approverRoleId, active } = request.data || {};
  validateRuleShape({ subjectType, minValue, maxValue });
  if (!approverRoleId) throw new HttpsError('invalid-argument', 'approverRoleId مطلوب');

  const db = getFirestore();
  const ref = db.collection('approvalRules').doc();

  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const roleSnap = await tx.get(db.collection('roles').doc(approverRoleId));
    if (!roleSnap.exists) throw new HttpsError('not-found', 'الدور المعتمِد غير موجود');

    // --- write phase ---
    const after = {
      subjectType, minValue,
      maxValue: maxValue == null ? null : maxValue,
      approverRoleId,
      active: active !== false,
      createdBy: actor.uid, createdAt: new Date(),
    };
    tx.set(ref, after);
    auditEntry(tx, db, { action: 'approvalRule.create', entity: `approvalRules/${ref.id}`, actorUid: actor.uid, before: null, after });
    return { id: ref.id };
  });
});

// Partial update -- only fields present in request.data are changed.
// Passing active:false is the intended way to retire a rule.
const updateApprovalRule = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'approvals.manageRules');
  const { ruleId, subjectType, minValue, maxValue, approverRoleId, active } = request.data || {};
  if (!ruleId) throw new HttpsError('invalid-argument', 'ruleId مطلوب');

  const db = getFirestore();
  const ref = db.collection('approvalRules').doc(ruleId);

  return db.runTransaction(async (tx) => {
    // --- read phase ---
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'القاعدة غير موجودة');
    const before = snap.data();

    const roleChanged = approverRoleId && approverRoleId !== before.approverRoleId;
    if (roleChanged) {
      const roleSnap = await tx.get(db.collection('roles').doc(approverRoleId));
      if (!roleSnap.exists) throw new HttpsError('not-found', 'الدور المعتمِد غير موجود');
    }

    const after = {
      subjectType: subjectType ?? before.subjectType,
      minValue: minValue ?? before.minValue,
      maxValue: maxValue === undefined ? before.maxValue : maxValue,
      approverRoleId: approverRoleId ?? before.approverRoleId,
      active: active === undefined ? before.active : active,
    };
    validateRuleShape(after);

    // --- write phase ---
    tx.update(ref, { ...after, updatedBy: actor.uid, updatedAt: new Date() });
    auditEntry(tx, db, { action: 'approvalRule.update', entity: `approvalRules/${ruleId}`, actorUid: actor.uid, before, after });
    return { ok: true };
  });
});

module.exports = { validateRuleShape, createApprovalRule, updateApprovalRule };
