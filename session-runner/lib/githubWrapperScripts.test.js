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

    const mapacheIssueFromOtherWorkspace = await runProcess(GH_SCRIPT, ["--repo", "rawkintrevo/mapache", "issue", "create", "--title", "Test"], {
      env: baseEnv({
        GITHUB_REPO_OWNER: "another-owner",
        GITHUB_REPO_NAME: "another-repo",
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(mapacheIssueFromOtherWorkspace.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")).args, ["--repo", "rawkintrevo/mapache", "issue", "create", "--title", "Test"]);
    assert.equal(fixture.requests.length, 2);

    const mapacheApiIssueFromOtherWorkspace = await runProcess(GH_SCRIPT, ["api", "repos/rawkintrevo/mapache/issues", "-f", "title=Test"], {
      env: baseEnv({
        GITHUB_REPO_OWNER: "another-owner",
        GITHUB_REPO_NAME: "another-repo",
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(mapacheApiIssueFromOtherWorkspace.code, 0);
    assert.equal(fixture.requests.length, 3);

    const mapachePullRequestFromOtherWorkspace = await runProcess(GH_SCRIPT, ["--repo", "rawkintrevo/mapache", "pr", "list"], {
      env: baseEnv({
        GITHUB_REPO_OWNER: "another-owner",
        GITHUB_REPO_NAME: "another-repo",
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(mapachePullRequestFromOtherWorkspace.code, 1);
    assert.match(mapachePullRequestFromOtherWorkspace.stderr, /github_repository_not_allowed/);
    assert.equal(fixture.requests.length, 3);

    const wrongFlagRepository = await runProcess(GH_SCRIPT, ["--repo", "owner/other-repo", "issue", "list"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(wrongFlagRepository.code, 1);
    assert.match(wrongFlagRepository.stderr, /github_repository_not_allowed/);
    assert.equal(fixture.requests.length, 3);

    const wrongApiRepository = await runProcess(GH_SCRIPT, ["api", "repos/owner/other-repo/issues"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(wrongApiRepository.code, 1);
    assert.match(wrongApiRepository.stderr, /github_repository_not_allowed/);
    assert.equal(fixture.requests.length, 3);
  } finally {
    await fixture.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("mapache-gh uses an existing GitHub CLI credential for Mapache issue search and creation when refresh is unconfigured", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-gh-cli-auth-"));
  const fakeBin = path.join(root, "bin");
  const capturePath = path.join(root, "capture.json");
  fs.mkdirSync(fakeBin);
  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'auth' && args[1] === 'token') {",
    "  if (!process.env.MAPACHE_GH_TEST_CLI_TOKEN) process.exit(1);",
    "  process.stdout.write(process.env.MAPACHE_GH_TEST_CLI_TOKEN);",
    "  process.exit(0);",
    "}",
    "fs.writeFileSync(process.env.MAPACHE_GH_CAPTURE, JSON.stringify({args, token: process.env.GH_TOKEN}));",
  ].join("\n"));
  fs.chmodSync(fakeGh, 0o755);

  try {
    const accepted = await runProcess(GH_SCRIPT, ["--repo", "rawkintrevo/mapache", "issue", "list"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        MAPACHE_GH_TEST_CLI_TOKEN: "selected-cli-token",
        refreshUrl: "",
      }),
    });
    assert.equal(accepted.code, 0);
    assert.equal(accepted.stdout, "");
    assert.equal(accepted.stderr, "");
    assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), {
      args: ["--repo", "rawkintrevo/mapache", "issue", "list"],
      token: "selected-cli-token",
    });

    const created = await runProcess(GH_SCRIPT, ["--repo", "rawkintrevo/mapache", "issue", "create", "--title", "Test"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        MAPACHE_GH_TEST_CLI_TOKEN: "selected-cli-token",
        refreshUrl: "",
      }),
    });
    assert.equal(created.code, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(capturePath, "utf8")), {
      args: ["--repo", "rawkintrevo/mapache", "issue", "create", "--title", "Test"],
      token: "selected-cli-token",
    });
    assert.equal(accepted.stdout.includes("selected-cli-token"), false);
    assert.equal(accepted.stderr.includes("selected-cli-token"), false);
    assert.equal(created.stdout.includes("selected-cli-token"), false);
    assert.equal(created.stderr.includes("selected-cli-token"), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("mapache-gh gives an actionable browser fallback when neither token path is configured", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-gh-no-auth-"));
  const fakeBin = path.join(root, "bin");
  const capturePath = path.join(root, "capture.json");
  fs.mkdirSync(fakeBin);
  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'auth' && args[1] === 'token') process.exit(1);",
    "fs.writeFileSync(process.env.MAPACHE_GH_CAPTURE, JSON.stringify({args, token: process.env.GH_TOKEN}));",
  ].join("\n"));
  fs.chmodSync(fakeGh, 0o755);

  try {
    const result = await runProcess(GH_SCRIPT, ["--repo", "rawkintrevo/mapache", "issue", "create"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        refreshUrl: "",
      }),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /github_cli_auth_unavailable/);
    assert.match(result.stderr, /Authentication Center/);
    assert.match(result.stderr, /https:\/\/github\.com\/rawkintrevo\/mapache\/issues\/new\/choose/);
    assert.equal(fs.existsSync(capturePath), false);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test("mapache-gh does not fall back to CLI auth after a configured broker rejects renewal", async () => {
  const fixture = await createRefreshFixture({
    status: 403,
    responseBody: JSON.stringify({error: "github_installation_access_denied"}),
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mapache-gh-broker-error-"));
  const fakeBin = path.join(root, "bin");
  const capturePath = path.join(root, "capture.json");
  fs.mkdirSync(fakeBin);
  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'auth' && args[1] === 'token') {",
    "  process.stdout.write(process.env.MAPACHE_GH_TEST_CLI_TOKEN || '');",
    "  process.exit(process.env.MAPACHE_GH_TEST_CLI_TOKEN ? 0 : 1);",
    "}",
    "fs.writeFileSync(process.env.MAPACHE_GH_CAPTURE, JSON.stringify({args, token: process.env.GH_TOKEN}));",
  ].join("\n"));
  fs.chmodSync(fakeGh, 0o755);

  try {
    const result = await runProcess(GH_SCRIPT, ["--repo", "rawkintrevo/mapache", "issue", "list"], {
      env: baseEnv({
        PATH: `${fakeBin}:${process.env.PATH}`,
        MAPACHE_GH_CAPTURE: capturePath,
        MAPACHE_GH_TEST_CLI_TOKEN: "selected-cli-token",
        refreshUrl: fixture.url,
      }),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /github_token_refresh_failed:403:github_installation_access_denied/);
    assert.equal(result.stderr.includes("selected-cli-token"), false);
    assert.equal(fs.existsSync(capturePath), false);
    assert.equal(fixture.requests.length, 1);
  } finally {
    await fixture.close();
    fs.rmSync(root, {recursive: true, force: true});
  }
});
