"use strict";

const {Storage} = require("@google-cloud/storage");
const admin = require("firebase-admin");

admin.initializeApp();

module.exports = {
  admin,
  db: admin.firestore(),
  storage: new Storage(),
};
