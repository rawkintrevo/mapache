import assert from "node:assert/strict";
import test from "node:test";
import {makeBrowserAccessToken, summarizeModelCatalog} from "./vm-automation-agent-proof.mjs";

test("browser access proof token binds the current agent session and generation", () => {
  const token = makeBrowserAccessToken({
    sessionId: "session-19",
    generation: 19,
    secret: "browser-secret",
    now: 1_700_000_000_000,
  });
  const [payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  assert.deepEqual(claims, {sid: "session-19", aud: "agent", gen: 19, exp: 1_700_000_900});
  assert.match(signature, /^[A-Za-z0-9_-]+$/);
});

test("model catalog proof reports safe availability counts only", () => {
  assert.deepEqual(summarizeModelCatalog({models: [
    {providerId: "pi", modelId: "one", available: true},
    {providerId: "pi", modelId: "two", available: false},
  ]}), {modelCount: 2, availableCount: 1});
  assert.deepEqual(summarizeModelCatalog({}), {modelCount: 0, availableCount: 0});
});
