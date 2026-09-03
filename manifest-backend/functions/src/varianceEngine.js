// Only the transfer shortage/overage classification is implemented — the
// reference pattern the other 7 of the spec's 9 variance types should
// follow once their owning flows (counts, production) are built. Listed
// here as named constants so nothing downstream has to guess the string.
const VARIANCE_TYPES = {
  TRANSFER_SHORTAGE: 'transfer_shortage',
  TRANSFER_OVERAGE: 'transfer_overage',
  COUNT_SHORTAGE: 'count_shortage', // not wired to a flow yet
  COUNT_OVERAGE: 'count_overage', // not wired to a flow yet
  PRODUCTION_YIELD_SHORTAGE: 'production_yield_shortage', // not wired yet
  PRODUCTION_YIELD_OVERAGE: 'production_yield_overage', // not wired yet
  WASTE_UNEXPECTED: 'waste_unexpected', // not wired yet
  EXPIRY_LOSS: 'expiry_loss', // not wired yet
  ADJUSTMENT_UNEXPLAINED: 'adjustment_unexplained', // not wired yet
};

function classifyTransferVariance(qtyShipped, qtyReceived) {
  const delta = qtyReceived - qtyShipped;
  if (Math.abs(delta) < 1e-6) return null;
  return {
    type: delta < 0 ? VARIANCE_TYPES.TRANSFER_SHORTAGE : VARIANCE_TYPES.TRANSFER_OVERAGE,
    qtyDelta: delta,
  };
}

function classifyProductionVariance(qtyPlanned, qtyActual) {
  const delta = qtyActual - qtyPlanned;
  if (Math.abs(delta) < 1e-6) return null;
  return {
    type: delta < 0 ? VARIANCE_TYPES.PRODUCTION_YIELD_SHORTAGE : VARIANCE_TYPES.PRODUCTION_YIELD_OVERAGE,
    qtyDelta: delta,
  };
}

// qtySystem here must be the LIVE balance read at apply-time, not a
// snapshot taken when the count started or was submitted — see
// counts.js's module comment for why (drift during the counting window
// would otherwise silently apply the wrong delta).
function classifyCountVariance(qtySystem, qtyCounted) {
  const delta = qtyCounted - qtySystem;
  if (Math.abs(delta) < 1e-6) return null;
  return {
    type: delta < 0 ? VARIANCE_TYPES.COUNT_SHORTAGE : VARIANCE_TYPES.COUNT_OVERAGE,
    qtyDelta: delta,
  };
}

module.exports = { VARIANCE_TYPES, classifyTransferVariance, classifyProductionVariance, classifyCountVariance };
