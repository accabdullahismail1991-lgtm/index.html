// Must be called during the write phase of a Firestore transaction (after
// all tx.get() calls for that transaction have already happened).
function auditEntry(tx, db, { action, entity, actorUid, before, after }) {
  const ref = db.collection('auditLog').doc();
  tx.set(ref, {
    action,
    entity,
    actorUid,
    before: before === undefined ? null : before,
    after: after === undefined ? null : after,
    at: new Date(),
  });
  return ref;
}

module.exports = { auditEntry };
