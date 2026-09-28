"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const {once} = require("node:events");
const {spawn} = require("node:child_process");
const test = require("node:test");

const CREDENTIAL_SCRIPT = path.join(__dirname, "..", "bin", "mapache-git-credential.js");
const GH_SCRIPT = path.join(__dirname, "..", "bin", "mapache-gh.js");

function runProcess(file, args, {env, input = ""} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {env});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({code, signal, stdout, stderr}));
    child.stdin.end(input);
  });
}

async function createRefreshFixture() {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        body: Buffer.concat(chunks).toString("utf8"),
        method: request.method,
        shutdownToken: request.headers["x-shutdown-token"],
      });
      const body = JSON.stringify({accessToken: "refreshed-token", expiresAt: "2099-01-01T00:00:00Z"});
      response.writeHead(200, {"content-type": "application/json", "content-length": Buffer.byteLength(body)});
      response.end(body);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    requests,
    url: `http://127.0.0.1:${server.address().port}/github-token`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function baseEnv(extra = {}) {
  return {
    ...process.env,
    GITHUB_REPO_OWNER: "Owner",
    GITHUB_REPO_NAME: "Repo",
    GITHUB_AUTOMATION_USERNAME: "x-access-token",
    GITHUB_AUTOMATION_TOKEN_REFRESH_URL: extra.refreshUrl,
    SESSION_SHUTDOWN_TOKEN: "shutdown-secret",
    SESSION_ID: "session-462",
    WORKSPACE_ID: "workspace-462",
    ...extra,
  };
}

test("mapache-git-credential executes directly, refreshes its token, and scopes credentials to the repository", async () => {
  const fixture = await createRefreshFixture();
  try {
    const accepted = await runProcess(CREDENTIAL_SCRIPT, [], {
      env: baseEnv({refreshUrl: fixture.url}),
      input: "protocol=https\nhost=github.com\npath=owner/repo.git\n\n",
    });
    assert.equal(accepted.code, 0);
    assert.match(accepted.stdout, /username=x-access-token/);
    assert.match(accepted.stdout, /password=refreshed-token/);
    assert.equal(fixture.requests.length, 1);
    assert.deepEqual(JSON.parse(fixture.requests[0].body), {
      workspaceId: "workspace-462",
      sessionId: "session-462",
    });
    assert.equal(fixture.requests[0].method, "POST");
    assert.equal(fixture.requests[0].shutdownToken, "shutdown-secret");

    const wrongRepository = await runProcess(CREDENTIAL_SCRIPT, [], {
      env: baseEnv({refreshUrl: fixture.url}),
      input: "protocol=https\nhost=github.com\npath=owner/other-repo.git\n\n",
    });
    assert.equal(wrongRepository.code, 0);
    assert.equal(wrongRepository.stdout, "");
    assert.equal(wrongRepository.stderr, "");
    assert.equal(fixture.requests.length, 1);

    const wrongHost = await runProcess(CREDENTIAL_SCRIPT, [], {
      env: baseEnv({refreshUrl: fixture.url}),
      input: "protocol=https\nhost=example.com\npath=owner/repo.git\n\n",
    });
    assert.equal(wrongHost.code, 0);
    assert.equal(wrongHost.stdout, "");
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
  }
});

test("mapache-gh executes directly, refreshes its token, and rejects other repositories", async () => {
  const fixture = await createRefreshFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-gh-wrapper-"));
  const fakeBin = path.join(root, "bin");
  const capturePath = path.join(root, "capture.json");
  fs.mkdirSync(fakeBin);
  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.MAPACHE_GH_CAPTURE, JSON.stringify({args: process.argv.slice(2), token: process.env.GH_TOKEN}));",
  ].join("\n"));
  fs.chmodSync(fakeGh, 0o755);

  try {
    const accepted = await runProcess(GH_SCRIPT, ["--repo", "owner/repo", "issue", "list"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(accepted.code, 0);
    assert.equal(accepted.stdout, "");
    assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), {
      args: ["--repo", "owner/repo", "issue", "list"],
      token: "refreshed-token",
    });
    assert.equal(fixture.requests.length, 1);

    const wrongFlagRepository = await runProcess(GH_SCRIPT, ["--repo", "owner/other-repo", "issue", "list"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(wrongFlagRepository.code, 1);
    assert.match(wrongFlagRepository.stderr, /github_repository_not_allowed/);
    assert.equal(fixture.requests.length, 1);

    const wrongApiRepository = await runProcess(GH_SCRIPT, ["api", "repos/owner/other-repo/issues"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(wrongApiRepository.code, 1);
    assert.match(wrongApiRepository.stderr, /github_repository_not_allowed/);
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});
