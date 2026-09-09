"use strict";

const assert = require("assert");
const {
  cleanOpenAiCodexDeviceField,
  createOpenAiCodexAuthService,
  openAiCodexAccountId,
  parseOpenAiCodexErrorCode,
} = require("./openAiCodexAuth.service");

function response({ok = true, status = 200, data = {}, text = ""} = {}) {
  return {
    ok,
    status,
    json: async () => data,
    text: async () => text,
  };
}

function publicMessage(error) {
  return error && error.publicMessage;
}

assert.strictEqual(cleanOpenAiCodexDeviceField(" code "), "code");
assert.strictEqual(cleanOpenAiCodexDeviceField("bad\ncode"), "");
assert.strictEqual(parseOpenAiCodexErrorCode(JSON.stringify({error: "slow_down"})), "slow_down");
assert.strictEqual(parseOpenAiCodexErrorCode(JSON.stringify({error: {code: "deviceauth_authorization_pending"}})), "deviceauth_authorization_pending");
assert.strictEqual(parseOpenAiCodexErrorCode("not-json"), "");
const accountPayload = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": {chatgpt_account_id: "acct_123"},
})).toString("base64url");
assert.strictEqual(openAiCodexAccountId(`header.${accountPayload}.signature`), "acct_123");
assert.strictEqual(openAiCodexAccountId("bad-token"), "");

(async () => {
  const originalFetch = global.fetch;
  const calls = [];
  const saved = [];
  const updated = [];
  const agentAuthService = {
    savePiAuthCredential: async (...args) => saved.push(args),
    updatePiAuthCredential: async (...args) => updated.push(args),
    getPiAuth: async () => ({providers: {"openai-codex": {type: "oauth"}}, entries: {}}),
  };
  const service = createOpenAiCodexAuthService({agentAuthService});

  try {
    global.fetch = async (url, options) => {
      calls.push({url, options});
      return response({data: {device_auth_id: "device-1", user_code: "ABCD", interval: "0"}});
    };
    assert.deepStrictEqual(await service.startOpenAiCodexDeviceCode(), {
      deviceAuthId: "device-1",
      userCode: "ABCD",
      verificationUri: "https://auth.openai.com/codex/device",
      intervalSeconds: 1,
      expiresInSeconds: 900,
    });
    assert.strictEqual(calls[0].options.method, "POST");
    assert.ok(calls[0].options.body.includes("app_EMoamEEZ73f0CkXaXp7hrann"));

    global.fetch = async () => response({ok: false, status: 403});
    assert.deepStrictEqual(await service.completeOpenAiCodexDeviceCode("uid-1", {
      deviceAuthId: "device-1",
      userCode: "ABCD",
    }), {status: "pending"});
    assert.strictEqual(saved.length, 0);

    const accessToken = `header.${accountPayload}.signature`;
    let successCall = 0;
    global.fetch = async (url) => {
      successCall += 1;
      if (successCall === 1) {
        assert.strictEqual(url, "https://auth.openai.com/api/accounts/deviceauth/token");
        return response({data: {authorization_code: "authorization-code", code_verifier: "verifier"}});
      }
      assert.strictEqual(url, "https://auth.openai.com/oauth/token");
      return response({data: {
        access_token: accessToken,
        refresh_token: "refresh-token",
        id_token: "id-token",
        expires_in: 3600,
      }});
    };
    const completed = await service.completeOpenAiCodexDeviceCode("uid-1", {
      deviceAuthId: "device-1",
      userCode: "ABCD",
    });
    assert.strictEqual(completed.status, "complete");
    assert.strictEqual(saved[0][0], "uid-1");
    assert.strictEqual(saved[0][1], "openai-codex");
    assert.deepStrictEqual(saved[0][2], {
      type: "oauth",
      id: "id-token",
      access: accessToken,
      refresh: "refresh-token",
      accountId: "acct_123",
      expires: saved[0][2].expires,
    });

    successCall = 0;
    const edited = await service.completeOpenAiCodexDeviceCode("uid-1", {
      deviceAuthId: "device-1",
      userCode: "ABCD",
      entryId: "openai-codex-existing",
      label: "Work account",
    });
    assert.strictEqual(edited.status, "complete");
    assert.strictEqual(updated[0][0], "uid-1");
    assert.strictEqual(updated[0][1], "openai-codex-existing");
    assert.strictEqual(updated[0][2], "openai-codex");
    assert.strictEqual(updated[0][4], "Work account");

    await assert.rejects(
        service.completeOpenAiCodexDeviceCode("uid-1", {deviceAuthId: "bad\nvalue", userCode: "ABCD"}),
        (error) => error.status === 400 && publicMessage(error) === "invalid_openai_codex_device_code",
    );

    global.fetch = async () => response({ok: false, status: 500, text: "provider down"});
    await assert.rejects(
        service.startOpenAiCodexDeviceCode(),
        (error) => error.status === 502 && publicMessage(error).startsWith("openai_codex_device_code_failed"),
    );
  } finally {
    global.fetch = originalFetch;
  }
  console.log("OpenAI Codex auth service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
