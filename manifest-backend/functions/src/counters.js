const { getFirestore } = require('firebase-admin/firestore');

// Transactional increment so two simultaneous submits never produce the
// same human-readable document number (TR-0001, future PO-, WL-, ...).
// Must be called from inside the caller's own db.runTransaction().
function nextDocNumber(tx, db, prefix) {
  const ref = db.collection('counters').doc(prefix);
  return tx.get(ref).then((snap) => {
    const next = (snap.exists ? snap.data().value : 0) + 1;
    tx.set(ref, { value: next }, { merge: true });
    return `${prefix}-${String(next).padStart(4, '0')}`;
  });
}

module.exports = { nextDocNumber };
