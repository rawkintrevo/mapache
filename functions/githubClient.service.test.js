"use strict";

const assert = require("assert");
const crypto = require("crypto");
const {
  createGithubClientService,
} = require("./githubClient.service");

function response(status, body, textBody) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => textBody == null ? JSON.stringify(body) : textBody,
  };
}

function createSecrets(privateKey) {
  const values = {
    GITHUB_APP_ID: "12345",
    GITHUB_APP_CLIENT_ID: "client-id",
    GITHUB_APP_CLIENT_SECRET: "client-secret",
    GITHUB_APP_PRIVATE_KEY: privateKey,
  };
  return (secret) => values[secret.name] || "";
}

function decodeJwtSegment(segment) {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
}

(async () => {
  const {privateKey, publicKey} = crypto.generateKeyPairSync("rsa", {modulusLength: 2048});
  const fixedNow = 1710000000000;
  const calls = [];
  const client = createGithubClientService({
    fetch: async (url, options) => {
      calls.push({url: String(url), options});
      return response(201, {
        token: "installation-token",
        expires_at: "2026-01-01T00:00:00Z",
        permissions: {contents: "write"},
        repository_selection: "selected",
      });
    },
    now: () => fixedNow,
    readSecret: createSecrets(privateKey.export({type: "pkcs8", format: "pem"})),
  });

  const jwt = client.createGithubAppJwt();
  const [encodedHeader, encodedPayload, encodedSignature] = jwt.split(".");
  assert.deepStrictEqual(decodeJwtSegment(encodedHeader), {alg: "RS256", typ: "JWT"});
  assert.deepStrictEqual(decodeJwtSegment(encodedPayload), {
    iat: Math.floor(fixedNow / 1000) - 60,
    exp: Math.floor(fixedNow / 1000) + 8 * 60,
    iss: "12345",
  });
  assert.strictEqual(crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, "base64url"),
  ), true);

  const installationToken = await client.createGithubInstallationToken("42");
  assert.deepStrictEqual(installationToken, {
    installationId: "42",
    token: "installation-token",
    expiresAt: "2026-01-01T00:00:00Z",
    permissions: {contents: "write"},
    repositorySelection: "selected",
  });
  assert.strictEqual(calls[0].url, "https://api.github.com/app/installations/42/access_tokens");
  assert.strictEqual(calls[0].options.method, "POST");
  assert.match(calls[0].options.headers.authorization, /^Bearer .+\..+\..+$/);

  const paginationCalls = [];
  const paginatedClient = createGithubClientService({
    fetch: async (url) => {
      const parsedUrl = new URL(url);
      paginationCalls.push(parsedUrl.toString());
      const page = parsedUrl.searchParams.get("page");
      if (parsedUrl.pathname === "/user/installations") {
        return response(200, {installations: page === "1" ? Array.from({length: 100}, (_, index) => ({id: index + 1})) : [{id: 101}]});
      }
      return response(200, {repositories: page === "1" ? Array.from({length: 100}, (_, index) => ({id: index + 1})) : [{id: 101}]});
    },
  });
  assert.strictEqual((await paginatedClient.listGithubUserInstallations("token")).length, 101);
  assert.strictEqual((await paginatedClient.listGithubInstallationRepositories("42", "token")).length, 101);
  assert.deepStrictEqual(paginationCalls.map((url) => new URL(url).searchParams.get("page")), ["1", "2", "1", "2"]);

  const oauthCalls = [];
  const oauthClient = createGithubClientService({
    fetch: async (url, options) => {
      oauthCalls.push({url, options});
      return response(200, {access_token: "oauth-token"});
    },
    readSecret: createSecrets("unused-key"),
  });
  assert.deepStrictEqual(await oauthClient.exchangeGithubOAuthCode("code-1", "https://example.test/callback"), {access_token: "oauth-token"});
  assert.strictEqual(oauthCalls[0].url, "https://github.com/login/oauth/access_token");
  assert.deepStrictEqual(JSON.parse(oauthCalls[0].options.body), {
    client_id: "client-id",
    client_secret: "client-secret",
    code: "code-1",
    redirect_uri: "https://example.test/callback",
  });

  const errorClient = createGithubClientService({
    fetch: async () => response(422, {message: "Validation Failed", errors: [{field: "head"}]}),
  });
  await assert.rejects(
      () => errorClient.requestGithubJson("https://api.github.com/test", "token"),
      (error) => error.status === 400 && error.publicMessage === "Validation Failed: head",
  );

  const networkClient = createGithubClientService({
    fetch: async () => { throw new Error("network down"); },
  });
  await assert.rejects(
      () => networkClient.requestGithubJson("https://api.github.com/test", "token", {failureError: "github_test_failed"}),
      (error) => error.status === 502 && error.publicMessage === "github_test_failed" && error.cause.message === "network down",
  );

  console.log("github client service tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
