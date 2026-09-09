import assert from "node:assert/strict";
import {test} from "node:test";
import {createGoogleRestClient, GoogleRestError} from "./restClient.mjs";

function response(body, status = 200) {
  return new Response(body == null ? "" : JSON.stringify(body), {
    status,
    headers: {"content-type": "application/json"},
  });
}

test("reads the token per request and sends only a bearer authorization header", async () => {
  const calls = [];
  const env = {GOOGLE_MCP_ACCESS_TOKEN: "token-a"};
  const client = createGoogleRestClient({
    env,
    fetchImpl: async (url, options) => {
      calls.push({url, authorization: options.headers.get("authorization")});
      return response({ok: true});
    },
  });
  await client.request("/calendar/v3/users/me/calendarList");
  env.GOOGLE_MCP_ACCESS_TOKEN = "token-b";
  await client.request("/calendar/v3/users/me/calendarList");
  assert.deepEqual(calls, [
    {url: "https://www.googleapis.com/calendar/v3/users/me/calendarList", authorization: "Bearer token-a"},
    {url: "https://www.googleapis.com/calendar/v3/users/me/calendarList", authorization: "Bearer token-b"},
  ]);
});

test("fails before fetch when the token is missing", async () => {
  let called = false;
  const client = createGoogleRestClient({env: {}, fetchImpl: async () => {
    called = true;
    return response({});
  }});
  await assert.rejects(client.request("/drive/v3/files"), (error) => error.code === "google_access_token_missing");
  assert.equal(called, false);
});

test("parses successful JSON and normalizes provider error statuses", async () => {
  const statuses = [401, 403, 404, 409, 429, 500, 503];
  for (const status of statuses) {
    const client = createGoogleRestClient({env: {GOOGLE_MCP_ACCESS_TOKEN: "secret-token"}, fetchImpl: async () => response({error: {message: "safe provider message"}}, status)});
    await assert.rejects(client.request("/drive/v3/files"), (error) => {
      assert.ok(error instanceof GoogleRestError);
      assert.equal(error.status, status);
      assert.match(error.code, /^google_/);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    });
  }
  const client = createGoogleRestClient({env: {GOOGLE_MCP_ACCESS_TOKEN: "secret-token"}, fetchImpl: async () => response({files: []})});
  assert.deepEqual(await client.request("/drive/v3/files"), {files: []});
});

test("refreshes once after a 401 and retries with the fresh token", async () => {
  const calls = [];
  const env = {
    GOOGLE_MCP_ACCESS_TOKEN: "expired-token",
    GOOGLE_MCP_CONNECTION_ID: "connection-a",
    GOOGLE_MCP_TOKEN_REFRESH_URL: "https://broker.example/google-token",
    WORKSPACE_ID: "workspace-a",
    SESSION_ID: "session-a",
    SESSION_SHUTDOWN_TOKEN: "shutdown-secret",
  };
  const client = createGoogleRestClient({
    env,
    fetchImpl: async (url, options) => {
      calls.push({
        url,
        authorization: options.headers instanceof Headers ? options.headers.get("authorization") : "",
        shutdownToken: options.headers instanceof Headers ? "" : options.headers["x-shutdown-token"],
        body: options.body || "",
      });
      if (url === "https://broker.example/google-token") {
        return response({accessToken: "fresh-token", expiresIn: 3600});
      }
      if ((options.headers.get("authorization") || "").includes("expired-token")) {
        return response({error: {message: "expired"}}, 401);
      }
      return response({files: [{id: "file-a"}]});
    },
  });

  assert.deepEqual(await client.request("/drive/v3/files"), {files: [{id: "file-a"}]});
  assert.deepEqual(await client.request("/drive/v3/files"), {files: [{id: "file-a"}]});
  assert.equal(calls.length, 4);
  assert.equal(calls[0].authorization, "Bearer expired-token");
  assert.equal(calls[1].shutdownToken, "shutdown-secret");
  assert.deepEqual(JSON.parse(calls[1].body), {
    workspaceId: "workspace-a",
    sessionId: "session-a",
    connectionId: "connection-a",
  });
  assert.equal(calls[2].authorization, "Bearer fresh-token");
  assert.equal(calls[3].authorization, "Bearer fresh-token");
});

test("does not retry more than once when a refreshed token is also rejected", async () => {
  let googleCalls = 0;
  let refreshCalls = 0;
  const client = createGoogleRestClient({
    env: {
      GOOGLE_MCP_ACCESS_TOKEN: "expired-token",
      GOOGLE_MCP_CONNECTION_ID: "connection-a",
      GOOGLE_MCP_TOKEN_REFRESH_URL: "https://broker.example/google-token",
      WORKSPACE_ID: "workspace-a",
      SESSION_ID: "session-a",
      SESSION_SHUTDOWN_TOKEN: "shutdown-secret",
    },
    fetchImpl: async (url) => {
      if (url === "https://broker.example/google-token") {
        refreshCalls += 1;
        return response({accessToken: "still-invalid"});
      }
      googleCalls += 1;
      return response({error: {message: "unauthorized"}}, 401);
    },
  });
  await assert.rejects(client.request("/drive/v3/files"), (error) => error.code === "google_unauthorized");
  assert.equal(refreshCalls, 1);
  assert.equal(googleCalls, 2);
});

test("collapses concurrent 401 refreshes into one broker request", async () => {
  let refreshCalls = 0;
  let releaseRefresh;
  const refreshGate = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const env = {
    GOOGLE_MCP_ACCESS_TOKEN: "expired-token",
    GOOGLE_MCP_CONNECTION_ID: "connection-a",
    GOOGLE_MCP_TOKEN_REFRESH_URL: "https://broker.example/google-token",
    WORKSPACE_ID: "workspace-a",
    SESSION_ID: "session-a",
    SESSION_SHUTDOWN_TOKEN: "shutdown-secret",
  };
  const client = createGoogleRestClient({
    env,
    fetchImpl: async (url, options) => {
      if (url === "https://broker.example/google-token") {
        refreshCalls += 1;
        await refreshGate;
        return response({accessToken: "fresh-token"});
      }
      return options.headers.get("authorization") === "Bearer expired-token" ?
        response({error: {message: "expired"}}, 401) : response({ok: true});
    },
  });
  const requests = [client.request("/drive/v3/files"), client.request("/gmail/v1/users/me/threads")];
  await new Promise((resolve) => setImmediate(resolve));
  releaseRefresh();
  assert.deepEqual(await Promise.all(requests), [{ok: true}, {ok: true}]);
  assert.equal(refreshCalls, 1);
});

test("preserves the original 401 behavior when no secure refresh configuration exists", async () => {
  let calls = 0;
  const client = createGoogleRestClient({
    env: {GOOGLE_MCP_ACCESS_TOKEN: "expired-token"},
    fetchImpl: async () => {
      calls += 1;
      return response({error: {message: "expired"}}, 401);
    },
  });
  await assert.rejects(client.request("/drive/v3/files"), (error) => error.code === "google_unauthorized");
  assert.equal(calls, 1);
});

test("aborts requests after the configured timeout", async () => {
  const client = createGoogleRestClient({
    env: {GOOGLE_MCP_ACCESS_TOKEN: "secret-token"},
    timeoutMs: 5,
    fetchImpl: (_url, {signal}) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), {once: true});
    }),
  });
  await assert.rejects(client.request("/drive/v3/files"), (error) => error.code === "google_request_timeout");
});

test("rejects oversized response bodies", async () => {
  const client = createGoogleRestClient({
    env: {GOOGLE_MCP_ACCESS_TOKEN: "secret-token"},
    maxResponseBytes: 20,
    fetchImpl: async () => response({value: "this is too large"}),
  });
  await assert.rejects(client.request("/drive/v3/files"), (error) => error.code === "google_response_too_large");
});

test("collects page-token results within page and item limits", async () => {
  const calls = [];
  const client = createGoogleRestClient({env: {GOOGLE_MCP_ACCESS_TOKEN: "secret-token"}, fetchImpl: async () => response({})});
  const result = await client.paginate(async (params) => {
    calls.push(params);
    if (!params.pageToken) return {items: [1, 2], nextPageToken: "page-2"};
    return {items: [3, 4], nextPageToken: "page-3"};
  }, {initialParams: {pageSize: 2}, maxPages: 2, maxItems: 3});
  assert.deepEqual(result, {items: [1, 2, 3], pages: 2, nextPageToken: "page-3", truncated: true});
  assert.deepEqual(calls, [{pageSize: 2}, {pageSize: 2, pageToken: "page-2"}]);
});
