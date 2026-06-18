"use strict";

const assert = require("assert");
const {
  appAllowListStatus,
  isAppAllowListConfigured,
  isFirebaseTokenAllowed,
  isUserWhitelisted,
  normalizeAppAllowListConfig,
  parseAppAllowList,
  setUserWhitelistStatus,
} = require("./appAllowList.helpers");

assert.deepStrictEqual(parseAppAllowList(""), []);
assert.deepStrictEqual(parseAppAllowList("alice@example.com, uid:ABC123; email:BOB@example.com"), [
  {type: "email", value: "alice@example.com"},
  {type: "uid", value: "ABC123"},
  {type: "email", value: "bob@example.com"},
]);
assert.deepStrictEqual(normalizeAppAllowListConfig({
  enabled: true,
  entries: ["uid:uid-1"],
  allowedEmails: ["Alice@Example.com"],
  allowedUids: ["uid-2"],
}), {
  enabled: true,
  entries: [
    {type: "uid", value: "uid-1"},
    {type: "email", value: "alice@example.com"},
    {type: "uid", value: "uid-2"},
  ],
});
assert.deepStrictEqual(appAllowListStatus({enabled: true, entries: ["alice@example.com"]}), {
  enabled: true,
  entryCount: 1,
});
assert.strictEqual(isAppAllowListConfigured({}), false);
assert.strictEqual(isAppAllowListConfigured({enabled: true}), true);

assert.strictEqual(
    isFirebaseTokenAllowed({uid: "uid-1", email: "Alice@Example.com"}, {
      enabled: true,
      entries: ["alice@example.com"],
    }),
    true,
);
assert.strictEqual(
    isFirebaseTokenAllowed({uid: "uid-1", email: "alice@example.com"}, {
      enabled: true,
      entries: ["uid:uid-1"],
    }),
    true,
);
assert.strictEqual(
    isFirebaseTokenAllowed({uid: "uid-1", email: "alice@example.com"}, {
      enabled: true,
      entries: ["uid:UID-1"],
    }),
    false,
);
assert.strictEqual(
    isFirebaseTokenAllowed({uid: "uid-2", email: "blocked@example.com"}, {
      enabled: true,
      entries: ["alice@example.com uid:uid-1"],
    }),
    false,
);
assert.strictEqual(
    isFirebaseTokenAllowed({uid: "anyone", email: "anyone@example.com"}, {enabled: false}),
    true,
);
assert.strictEqual(
    isFirebaseTokenAllowed({uid: "anyone", email: "anyone@example.com"}, {enabled: true}),
    false,
);

assert.strictEqual(
    isUserWhitelisted({uid: "uid-1", email: "alice@example.com"}, {
      enabled: false,
      allowedEmails: ["alice@example.com"],
    }),
    true,
);
assert.strictEqual(
    isUserWhitelisted({uid: "uid-1", email: "alice@example.com"}, {
      enabled: true,
      allowedUids: ["uid-2"],
    }),
    false,
);

assert.deepStrictEqual(setUserWhitelistStatus({
  enabled: false,
  entries: ["email:alice@example.com", "uid:uid-3"],
  allowedEmails: ["bob@example.com"],
  allowedUids: ["uid-1"],
}, {uid: "uid-1", email: "alice@example.com"}, false), {
  enabled: false,
  entries: ["uid:uid-3"],
  allowedEmails: ["bob@example.com"],
  allowedUids: [],
});

assert.deepStrictEqual(setUserWhitelistStatus({
  enabled: false,
  entries: [],
  allowedEmails: [],
  allowedUids: [],
}, {uid: "uid-1", email: "Alice@Example.com"}, true), {
  enabled: true,
  entries: [],
  allowedEmails: ["alice@example.com"],
  allowedUids: [],
});

assert.deepStrictEqual(setUserWhitelistStatus({
  enabled: true,
  entries: [],
  allowedEmails: [],
  allowedUids: [],
}, {uid: "uid-1", email: ""}, true), {
  enabled: true,
  entries: [],
  allowedEmails: [],
  allowedUids: ["uid-1"],
});

console.log("app allow list helper tests passed");
