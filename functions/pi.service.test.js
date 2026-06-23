"use strict";

const assert = require("assert");
const {
  appendQuery,
  buildGitPackageSource,
  cleanOpenAiCodexDeviceField,
  createPiService,
  mergeCompatiblePiAuthState,
  normalizeGitPackageSource,
  normalizeOpenAiCodexReturnTo,
  normalizePiAuthApiKey,
  normalizePiAuthEntries,
  normalizePiAuthEntryId,
  normalizePiAuthProviderKey,
  normalizePiAuthProviders,
  normalizePiAuthSelection,
  normalizePiAuthStoredProviderKey,
  normalizePiPackageSource,
  normalizePiSkillContent,
  normalizePiSkillDescription,
  normalizePiSkillName,
  normalizePiSkillPayload,
  normalizePlainObject,
  openAiCodexAccountId,
  parseGitPackageSource,
  parseOpenAiCodexErrorCode,
  piPackageCatalogDocId,
  removePiAuthEntry,
  removePiAuthProvider,
  sessionSupportsWorkspaceSkills,
  writePiAuthMaps,
} = require("./pi.service");

function publicMessage(error) {
  return error && error.publicMessage;
}

assert.deepStrictEqual(normalizePiSkillPayload({
  name: " My-Skill ",
  description: "  Does work  ",
  instructions: "  Use this carefully  ",
}), {
  name: "my-skill",
  description: "Does work",
  content: "Use this carefully",
});
assert.strictEqual(normalizePiSkillName("skill-1"), "skill-1");
assert.throws(() => normalizePiSkillName("Bad Name"), (error) => publicMessage(error) === "invalid_skill_name");
assert.strictEqual(normalizePiSkillDescription("x".repeat(1024)).length, 1024);
assert.throws(() => normalizePiSkillDescription(""), (error) => publicMessage(error) === "invalid_skill_description");
assert.strictEqual(normalizePiSkillContent("x".repeat(128 * 1024)).length, 128 * 1024);
assert.throws(() => normalizePiSkillContent("bad\u0000content"), (error) => publicMessage(error) === "invalid_skill_content");

assert.deepStrictEqual(normalizePiPackageSource("npm:@scope/pkg@1.2.3"), {
  source: "npm:@scope/pkg@1.2.3",
  type: "npm",
  identity: "npm:@scope/pkg",
  name: "@scope/pkg",
  pinned: true,
});
assert.deepStrictEqual(normalizePiPackageSource("github:owner/repo#main"), {
  source: "github:owner/repo#main",
  type: "git",
  identity: "git:github.com/owner/repo",
  host: "github.com",
  path: "owner/repo",
  pinned: true,
});
assert.deepStrictEqual(normalizeGitPackageSource("git+ssh://github.com/Owner/Repo.git#v1"), {
  source: "git+ssh://github.com/Owner/Repo.git#v1",
  type: "git",
  identity: "git:github.com/Owner/Repo",
  host: "github.com",
  path: "Owner/Repo",
  pinned: true,
});
assert.deepStrictEqual(parseGitPackageSource("git@github.com:owner/repo.git#main"), {
  host: "github.com",
  path: "owner/repo",
  ref: "main",
});
assert.deepStrictEqual(buildGitPackageSource("GitHub.COM", "/owner/repo.git"), {
  host: "github.com",
  path: "owner/repo",
  ref: "",
});
assert.throws(() => normalizePiPackageSource("npm:not valid"), (error) => publicMessage(error) === "invalid_package_source");
assert.throws(() => normalizePiPackageSource("https://user:pass@example.com/repo"), (error) => publicMessage(error) === "package_source_must_not_include_credentials");
assert.throws(() => normalizePiPackageSource("ftp://example.com/repo"), (error) => publicMessage(error) === "unsupported_package_source");
assert.strictEqual(piPackageCatalogDocId("git:github.com/owner/repo"), "git%3Agithub.com%2Fowner%2Frepo");

assert.deepStrictEqual(normalizePlainObject({
  token: "abc",
  nested: {count: 1, skip: undefined},
  list: ["a", {b: true}, undefined],
  fn: () => {},
}), {
  token: "abc",
  nested: {count: 1},
  list: ["a", {b: true}],
});
assert.deepStrictEqual(normalizePiAuthProviders({
  " openai ": {type: "api_key", key: "sk"},
  bad: null,
}), {
  openai: {type: "api_key", key: "sk"},
});
assert.deepStrictEqual(normalizePiAuthEntries({}, {openai: {type: "api_key", key: "sk"}}), {
  "legacy-openai": {
    id: "legacy-openai",
    providerKey: "openai",
    label: "openai",
    credential: {type: "api_key", key: "sk"},
    createdAt: "",
  },
});
assert.deepStrictEqual(mergeCompatiblePiAuthState({
  providers: {openai: {type: "api_key", key: "new"}},
  entries: {
    "entry-new": {
      id: "entry-new",
      providerKey: "openai",
      label: "new",
      credential: {type: "api_key", key: "new"},
      createdAt: "2026-06-23T00:00:00.000Z",
    },
  },
}, {
  providers: {
    openai: {type: "api_key", key: "old"},
    anthropic: {type: "api_key", key: "legacy"},
  },
  entries: {
    "entry-old": {
      id: "entry-old",
      providerKey: "openai",
      label: "old",
      credential: {type: "api_key", key: "old"},
      createdAt: "2026-06-22T00:00:00.000Z",
    },
  },
}), {
  providers: {
    openai: {type: "api_key", key: "new"},
    anthropic: {type: "api_key", key: "legacy"},
  },
  entries: {
    "entry-old": {
      id: "entry-old",
      providerKey: "openai",
      label: "old",
      credential: {type: "api_key", key: "old"},
      createdAt: "2026-06-22T00:00:00.000Z",
    },
    "entry-new": {
      id: "entry-new",
      providerKey: "openai",
      label: "new",
      credential: {type: "api_key", key: "new"},
      createdAt: "2026-06-23T00:00:00.000Z",
    },
    "legacy-anthropic": {
      id: "legacy-anthropic",
      providerKey: "anthropic",
      label: "anthropic",
      credential: {type: "api_key", key: "legacy"},
      createdAt: "",
    },
  },
});
assert.deepStrictEqual(normalizePiAuthSelection({
  openai: "entry-1",
  anthropic: "entry-1",
}, {
  "entry-1": {providerKey: "openai"},
}), {
  openai: "entry-1",
});
assert.strictEqual(normalizePiAuthEntryId("entry:1_ok"), "entry:1_ok");
assert.strictEqual(normalizePiAuthEntryId("", {required: false}), "");
assert.throws(() => normalizePiAuthEntryId("bad id"), (error) => publicMessage(error) === "invalid_pi_auth_entry");
assert.strictEqual(normalizePiAuthProviderKey("openai"), "openai");
assert.throws(() => normalizePiAuthProviderKey("unknown-provider"), (error) => publicMessage(error) === "invalid_pi_auth_provider");
assert.strictEqual(normalizePiAuthStoredProviderKey("custom-provider"), "custom-provider");
assert.throws(() => normalizePiAuthApiKey(""), (error) => publicMessage(error) === "invalid_pi_auth_key");
assert.strictEqual(normalizePiAuthApiKey(" key "), "key");

const openAiCredential1 = {type: "oauth", access: "first"};
const openAiCredential2 = {type: "oauth", access: "second"};
assert.deepStrictEqual(removePiAuthEntry({"openai-codex": openAiCredential2}, {
  "entry-1": {providerKey: "openai-codex", credential: openAiCredential1, createdAt: "2026-01-01"},
  "entry-2": {providerKey: "openai-codex", credential: openAiCredential2, createdAt: "2026-01-02"},
}, "entry-2"), {
  providers: {"openai-codex": openAiCredential1},
  entries: {
    "entry-1": {providerKey: "openai-codex", credential: openAiCredential1, createdAt: "2026-01-01"},
  },
});
assert.deepStrictEqual(removePiAuthEntry({"openai-codex": openAiCredential1}, {
  "entry-1": {providerKey: "openai-codex", credential: openAiCredential1, createdAt: "2026-01-01"},
}, "entry-1"), {providers: {}, entries: {}});
assert.deepStrictEqual(removePiAuthProvider({anthropic: {type: "api_key", key: "secret"}}, {
  "entry-1": {providerKey: "anthropic", credential: {type: "api_key", key: "secret"}},
}, "anthropic"), {providers: {}, entries: {}});

const transactionCalls = [];
writePiAuthMaps({
  update: (ref, payload) => transactionCalls.push({method: "update", ref, payload}),
  set: (ref, payload) => transactionCalls.push({method: "set", ref, payload}),
}, "pi-auth-ref", {exists: true}, {providers: {}, entries: {}, updatedAt: "now", createdAt: "created"});
assert.deepStrictEqual(transactionCalls, [{
  method: "update",
  ref: "pi-auth-ref",
  payload: {providers: {}, entries: {}, updatedAt: "now"},
}]);

assert.strictEqual(cleanOpenAiCodexDeviceField(" code "), "code");
assert.strictEqual(cleanOpenAiCodexDeviceField("bad\ncode"), "");
assert.strictEqual(parseOpenAiCodexErrorCode(JSON.stringify({error: "slow_down"})), "slow_down");
assert.strictEqual(parseOpenAiCodexErrorCode(JSON.stringify({error: {code: "deviceauth_authorization_pending"}})), "deviceauth_authorization_pending");
assert.strictEqual(parseOpenAiCodexErrorCode("not-json"), "");
assert.strictEqual(normalizeOpenAiCodexReturnTo("https://example.com/app#secret"), "https://example.com/app");
assert.throws(() => normalizeOpenAiCodexReturnTo("javascript:alert(1)"), (error) => publicMessage(error) === "invalid_openai_codex_return_url");
assert.strictEqual(appendQuery("https://example.com/app?x=1", {status: "ok"}), "https://example.com/app?x=1&status=ok");
assert.strictEqual(appendQuery("not a url", {status: "ok"}), "/?status=ok");

const accountPayload = Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": {chatgpt_account_id: "acct_123"},
})).toString("base64url");
assert.strictEqual(openAiCodexAccountId(`header.${accountPayload}.signature`), "acct_123");
assert.strictEqual(openAiCodexAccountId("bad-token"), "");
assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind: "pi"}), true);
assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind: "codex"}), true);
assert.strictEqual(sessionSupportsWorkspaceSkills({terminalKind: "shell"}), false);

async function assertServiceError(fn, expectedStatus, expectedMessage) {
  await assert.rejects(fn, (error) => error.status === expectedStatus && error.publicMessage === expectedMessage);
}

const stoppedSessionSnap = {
  data: () => ({serviceUrl: "", shutdownToken: "token", terminalKind: "pi"}),
  ref: {set: async () => {}},
};
const unsupportedSessionSnap = {
  data: () => ({serviceUrl: "https://runner", shutdownToken: "", terminalKind: "pi"}),
  ref: {set: async () => {}},
};
const runningSessionSnap = {
  data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "pi"}),
  ref: {set: async () => {}},
};
const shellSessionSnap = {
  data: () => ({serviceUrl: "https://runner", shutdownToken: "token", terminalKind: "shell"}),
  ref: {set: async () => {}},
};

function serviceForSession(sessionSnap, calls = []) {
  return createPiService({
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap}),
    requestRunnerJson: async (session, routePath, options) => {
      calls.push({session, routePath, options});
      return {ok: true, routePath, body: options.body || null};
    },
  });
}

(async () => {
  await assertServiceError(
      () => serviceForSession(stoppedSessionSnap).listPiPackages("uid", "workspace", "session"),
      409,
      "no_active_session",
  );
  await assertServiceError(
      () => serviceForSession(unsupportedSessionSnap).listPiPackages("uid", "workspace", "session"),
      501,
      "runner_package_listing_unsupported",
  );
  await assertServiceError(
      () => serviceForSession(shellSessionSnap).saveSessionPiAuthSelection("uid", "workspace", "session", {selection: {}}),
      400,
      "auth_selection_unsupported",
  );
  await assertServiceError(
      () => serviceForSession(shellSessionSnap).saveWorkspaceSkill("uid", "workspace", "session", {
        name: "review-code",
        description: "Review code",
        content: "Check the diff",
      }),
      501,
      "runner_skill_save_unsupported",
  );

  const calls = [];
  const result = await serviceForSession(runningSessionSnap, calls)
      .savePiSkill("uid", "workspace", "session", {
        name: "review-code",
        description: "Review code",
        content: "Check the diff",
      });
  assert.strictEqual(result.ok, true);
  assert.strictEqual(calls[0].routePath, "/skills");
  assert.strictEqual(calls[0].options.method, "POST");
  assert.deepStrictEqual(calls[0].options.body, {
    name: "review-code",
    description: "Review code",
    content: "Check the diff",
  });
  assert.strictEqual(calls[0].options.notFoundError, "runner_skill_save_unsupported");
  assert.strictEqual(calls[0].options.unavailableError, "runner_skill_save_unavailable");

  const fallbackCalls = [];
  const fallbackService = createPiService({
    requireWorkspace: async () => ({}),
    requireSession: async () => ({sessionSnap: runningSessionSnap}),
    requestRunnerJson: async (session, routePath, options) => {
      fallbackCalls.push({session, routePath, options});
      if (routePath === "/skills") {
        const error = new Error("runner_skill_save_unsupported");
        error.status = 501;
        error.publicMessage = "runner_skill_save_unsupported";
        throw error;
      }
      return {ok: true, routePath};
    },
  });
  const fallbackResult = await fallbackService.saveWorkspaceSkill("uid", "workspace", "session", {
    name: "review-code",
    description: "Review code",
    content: "Check the diff",
  });
  assert.strictEqual(fallbackResult.routePath, "/pi/skills");
  assert.deepStrictEqual(fallbackCalls.map((call) => call.routePath), ["/skills", "/pi/skills"]);

  console.log("pi service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
