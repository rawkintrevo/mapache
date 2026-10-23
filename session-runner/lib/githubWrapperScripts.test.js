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
const GH_SCRIPT = path.join(__dirname, "..", "bin", "mapache-gh");

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

async function createRefreshFixture({status = 200, responseBody} = {}) {
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
      const body = responseBody || JSON.stringify({accessToken: "refreshed-token", expiresAt: "2099-01-01T00:00:00Z"});
      response.writeHead(status, {"content-type": "application/json", "content-length": Buffer.byteLength(body)});
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
    GH_TOKEN: "",
    GITHUB_AUTOMATION_TOKEN: "",
    GITHUB_AUTOMATION_TOKEN_EXPIRES_AT: "",
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

test("legacy mapache-gh forwards native CLI arguments, auth, I/O and exit status without broker calls", async () => {
  const fixture = await createRefreshFixture({status: 403});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-gh-native-"));
  const capturePath = path.join(root, "capture.json");
  const fakeGh = path.join(root, "gh");
  fs.writeFileSync(fakeGh, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "fs.writeFileSync(process.env.MAPACHE_GH_CAPTURE, JSON.stringify({args: process.argv.slice(2), token: process.env.GH_TOKEN, config: process.env.GH_CONFIG_DIR}));",
    "process.stdout.write(fs.readFileSync(0, 'utf8'));",
    "process.stderr.write('native gh diagnostic');",
    "process.exit(Number(process.env.TEST_GH_EXIT));",
  ].join("\n"));
  fs.chmodSync(fakeGh, 0o755);
  try {
    for (const args of [
      ["issue", "create", "--repo", "another/project", "--title", "Title with spaces"],
      ["pr", "list", "--repo=rawkintrevo/mapache"],
      ["api", "repos/another/project/issues"],
      ["auth", "status"],
    ]) {
      for (const token of ["", "native-cli-token"]) {
        const result = await runProcess(GH_SCRIPT, args, {
          env: baseEnv({
            PATH: `${root}:${process.env.PATH}`,
            MAPACHE_GH_CAPTURE: capturePath,
            GH_TOKEN: token,
            GH_CONFIG_DIR: root,
            GITHUB_AUTOMATION_TOKEN: "app-token-must-not-be-injected",
            refreshUrl: fixture.url,
            TEST_GH_EXIT: token ? "4" : "0",
          }),
          input: "native stdin",
        });
        assert.equal(result.code, token ? 4 : 0);
        assert.equal(result.stdout, "native stdin");
        assert.equal(result.stderr, "native gh diagnostic");
        assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), {
          args, token, config: root,
        });
      }
    }
    assert.equal(fixture.requests.length, 0);
  } finally {
    await fixture.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("seeded GitHub guidance uses native gh and the image installs the compatibility command", () => {
  const runnerRoot = path.join(__dirname, "..");
  const skill = fs.readFileSync(path.join(runnerRoot, "seeded-skills/mapache-github-issue/SKILL.md"), "utf8");
  assert.doesNotMatch(skill, /mapache-gh|mapache_gh|gh auth token/);
  assert.match(skill, /gh issue create/);
  assert.match(skill, /gh pr create/);
  const dockerfile = fs.readFileSync(path.join(runnerRoot, "Dockerfile.pi-chrome"), "utf8");
  assert.match(dockerfile, /ln -sf \/app\/bin\/mapache-gh \/usr\/local\/bin\/mapache-gh/);
});

test("managed helper renews through the runner socket without shutdown credentials", async () => {
  const {createGithubTokenApiService} = require("./githubTokenApi.service");
  const fixture = await createRefreshFixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "github-broker-"));
  const socketPath = path.join(root, "token.sock");
  const broker = createGithubTokenApiService({
    githubTokenSocketPath: socketPath,
    githubAutomationTokenRefreshUrl: fixture.url,
    shutdownToken: "runner-only-secret", workspaceId: "w", sessionId: "s",
  });
  try {
    await broker.start();
    assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
    const env = baseEnv({MAPACHE_GITHUB_TOKEN_SOCKET: socketPath});
    delete env.SESSION_SHUTDOWN_TOKEN;
    delete env.GITHUB_AUTOMATION_TOKEN_REFRESH_URL;
    const input = "protocol=https\nhost=github.com\npath=owner/repo.git\n\n";
    const results = await Promise.all(Array.from({length: 3}, () => runProcess(CREDENTIAL_SCRIPT, ["get"], {env, input})));
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /password=refreshed-token/);
      assert.doesNotMatch(result.stdout + result.stderr, /runner-only-secret/);
    }
    assert.equal(fixture.requests.length, 1, "runner caches and coalesces helper refreshes");
    assert.equal(fixture.requests[0].shutdownToken, "runner-only-secret");
    assert.deepEqual(JSON.parse(fixture.requests[0].body), {workspaceId: "w", sessionId: "s"});
    const wrongRepo = await runProcess(CREDENTIAL_SCRIPT, ["get"], {env, input: input.replace("owner/repo", "owner/other")});
    assert.equal(wrongRepo.stdout, "");
    assert.equal(fixture.requests.length, 1);
    await broker.stop();
    const unavailable = await runProcess(CREDENTIAL_SCRIPT, ["get"], {env, input});
    assert.equal(unavailable.code, 1);
    assert.equal(unavailable.stdout, "");
  } finally {
    await broker.stop();
    await fixture.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});
