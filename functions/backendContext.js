"use strict";

const admin = require("firebase-admin");
const {GoogleAuth} = require("google-auth-library");

if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();
const auth = new GoogleAuth({scopes: ["https://www.googleapis.com/auth/cloud-platform"]});

module.exports = {
  admin,
  auth,
  db,
};
