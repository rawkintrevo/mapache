"use strict";

const assert = require("assert");
const {
  classifyRunnerResponseError,
  parseRunnerResponseBody,
} = require("./runnerProxy.helpers");

assert.deepStrictEqual(parseRunnerResponseBody(""), {});
assert.deepStrictEqual(parseRunnerResponseBody("not json"), {});
assert.deepStrictEqual(parseRunnerResponseBody("{\"error\":\"git_push_failed\"}"), {
  error: "git_push_failed",
});

assert.strictEqual(classifyRunnerResponseError({
  status: 429,
  data: {},
  rawBody: "",
}), "runner_busy_or_unavailable");

assert.strictEqual(classifyRunnerResponseError({
  status: 503,
  data: {},
  rawBody: "The request was aborted because there was no available instance.",
}), "runner_busy_or_unavailable");

assert.strictEqual(classifyRunnerResponseError({
  status: 400,
  data: {error: "git_push_failed"},
  rawBody: "{\"error\":\"git_push_failed\"}",
}), "git_push_failed");

console.log("runner proxy helper tests passed");
