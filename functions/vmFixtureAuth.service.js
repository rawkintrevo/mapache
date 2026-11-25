"use strict";
const {httpError} = require("./backendUtils.helpers");

// IAM-private test helper. Fixed synthetic identities only; no caller UID or
// email and no bypass of the ordinary app allowlist in vmApi_v2.
function createVmFixtureAuthService({db, auth}) {
  return async req => {
    if (req.method !== "POST") throw httpError(405, "method_not_allowed");
    const body = req.body || {};
    if (Object.keys(body).some(key => key !== "identity") || !["owner", "outsider"].includes(body.identity)) throw httpError(400, "invalid_fixture_identity");
    const ws = (await db.doc("vmRuntimes_v2/vm-proof-605").get()).data();
    if (ws?.ownerUid !== "vm-proof-owner" || ws.apiEnabled !== true || ws.lifecycleEnabled !== true) throw httpError(409, "fixture_not_admitted");
    const uid = body.identity === "owner" ? "vm-proof-owner" : "vm-proof-outsider";
    let user;
    try { user = await auth.getUser(uid); } catch (error) { if (error.code !== "auth/user-not-found") throw error; }
    const created = !user;
    if (user && (user.customClaims?.vmFixture605 !== true || user.disabled)) throw httpError(409, "fixture_user_conflict");
    if (!user) {
      await auth.createUser({uid, displayName: "Mapache VM fixture 605", disabled: false});
      await auth.setCustomUserClaims(uid, {vmFixture605: true});
    }
    return {uid, created, token: await auth.createCustomToken(uid, {vmFixture605: true})};
  };
}
module.exports = {createVmFixtureAuthService};
