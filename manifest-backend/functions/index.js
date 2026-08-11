const { initializeApp } = require('firebase-admin/app');

initializeApp();

const { setUserRole } = require('./src/rbac');
const { postInventoryTransactionCallable } = require('./src/inventoryTransactionService');
const { submitTransfer, approveTransfer, shipTransfer, receiveTransfer } = require('./src/transfers');

module.exports = {
  setUserRole,
  postInventoryTransaction: postInventoryTransactionCallable,
  submitTransfer,
  approveTransfer,
  shipTransfer,
  receiveTransfer,
};
