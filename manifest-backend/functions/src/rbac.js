const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

// Every other Cloud Function in this project must call this first. A
// mutating callable with no requirePermission() guard at its top is a bug.
// Trusts only the server-resolved custom claims — never a role/permission
// value sent in the request body.
async function requirePermission(auth, permission) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'يجب تسجيل الدخول');
  }
  const claims = auth.token || {};
  const perms = Array.isArray(claims.permissions) ? claims.permissions : [];
  if (!perms.includes(permission) && !perms.includes('*')) {
    throw new HttpsError('permission-denied', `الصلاحية المطلوبة غير متوفرة: ${permission}`);
  }
  return { uid: auth.uid, roleId: claims.roleId || null, branchId: claims.branchId || null };
}

// Admin-only. Resolves roles/{roleId}.permissions and writes them into the
// target user's Auth custom claims, so every later request they make
// carries a fresh, server-computed permission list.
const setUserRole = onCall(async (request) => {
  const actor = await requirePermission(request.auth, 'users.manageRoles');
  const { uid, roleId, branchId } = request.data || {};
  if (!uid || !roleId) {
    throw new HttpsError('invalid-argument', 'uid و roleId مطلوبان');
  }

  const db = getFirestore();
  const roleSnap = await db.collection('roles').doc(roleId).get();
  if (!roleSnap.exists) {
    throw new HttpsError('not-found', 'الدور غير موجود');
  }
  const permissions = roleSnap.data().permissions || [];

  await getAuth().setCustomUserClaims(uid, {
    roleId,
    branchId: branchId || null,
    permissions,
  });

  const before = (await db.collection('users').doc(uid).get()).data() || null;
  const after = { roleId, branchId: branchId || null, updatedAt: new Date(), updatedBy: actor.uid };
  await db.collection('users').doc(uid).set(after, { merge: true });
  await db.collection('auditLog').add({
    action: 'user.role.set',
    entity: `users/${uid}`,
    actorUid: actor.uid,
    before,
    after,
    at: new Date(),
  });

  return { ok: true };
});

module.exports = { requirePermission, setUserRole };
