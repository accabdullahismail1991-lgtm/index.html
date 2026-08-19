const { initializeApp } = require('firebase-admin/app');

initializeApp();

const { setUserRole } = require('./src/rbac');
const { postInventoryTransactionCallable } = require('./src/inventoryTransactionService');
const { submitTransfer, approveTransfer, rejectTransfer, cancelTransfer, shipTransfer, receiveTransfer } = require('./src/transfers');
const { createProductionOrder, startProduction, completeProduction, cancelProduction } = require('./src/production');

module.exports = {
  setUserRole,
  postInventoryTransaction: postInventoryTransactionCallable,
  submitTransfer,
  approveTransfer,
  rejectTransfer,
  cancelTransfer,
  shipTransfer,
  receiveTransfer,
  createProductionOrder,
  startProduction,
  completeProduction,
  cancelProduction,
};
