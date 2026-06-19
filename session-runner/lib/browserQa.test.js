"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {createBrowserQaService, normalizeScenarioSpec} = require("./browserQa");

function qaConfig(workspaceDir) {
  const qaDir = path.join(workspaceDir, ".mapache", "qa");
  return {
    browserQaActionTimeoutMs: 5000,
    browserQaBaseUrl: "http://127.0.0.1:8080/preview/",
    browserQaCommand: "mapache-preview-qa",
    browserQaDir: qaDir,
    browserQaExecutablePath: "/usr/bin/chromium",
    browserQaHeadless: true,
    browserQaNavigationTimeoutMs: 15000,
    browserQaStatePath: path.join(qaDir, "last-run.json"),
    runnerCapabilities: {previewQa: true},
    workspaceDir,
  };
}

test("normalizeScenarioSpec defaults to the preview URL and standard viewports", () => {
  const spec = normalizeScenarioSpec({}, qaConfig("/workspace"));
  assert.equal(spec.url, "http://127.0.0.1:8080/preview/");
  assert.deepEqual(spec.viewports.map((viewport) => viewport.name), ["desktop", "mobile"]);
});

test("browser QA status reports unavailable dependencies", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-browser-qa-"));
  const browserQa = createBrowserQaService(qaConfig(workspaceDir), {
    isExecutable() {
      return true;
    },
    resolveModule() {
      return "";
    },
  });
  const status = browserQa.status({ready: true});
  assert.equal(status.available, false);
  assert.equal(status.state, "browser_automation_unavailable");
  assert.equal(status.unavailableReason, "playwright_not_available");
});

test("browser QA run writes reports and last-run state", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-browser-qa-"));
  const config = qaConfig(workspaceDir);
  const browserQa = createBrowserQaService(config, {
    isExecutable() {
      return true;
    },
    resolveModule() {
      return "/usr/local/lib/node_modules/@playwright/test/index.js";
    },
    runScenario: async ({targetDir}) => {
      await fs.writeFile(path.join(targetDir, "desktop.png"), "image");
      return {
        status: "passed",
        screenshots: [path.join(targetDir, "desktop.png")],
        summary: {
          consoleErrors: [],
          consoleMessages: [],
          failedRequests: [],
          pageErrors: [],
        },
      };
    },
  });

  const result = await browserQa.run({});
  assert.equal(result.status, "passed");

  const report = JSON.parse(await fs.readFile(path.join(config.browserQaDir, "latest", "report.json"), "utf8"));
  assert.equal(report.status, "passed");

  const lastRun = JSON.parse(await fs.readFile(config.browserQaStatePath, "utf8"));
  assert.equal(lastRun.status, "passed");
  assert.equal(lastRun.summary.screenshotCount, 1);
});

test("browser QA run surfaces failed executions in state", async () => {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "mapache-browser-qa-"));
  const config = qaConfig(workspaceDir);
  const browserQa = createBrowserQaService(config, {
    isExecutable() {
      return true;
    },
    resolveModule() {
      return "/usr/local/lib/node_modules/@playwright/test/index.js";
    },
    runScenario: async () => {
      throw new Error("navigation timeout");
    },
  });

  await assert.rejects(() => browserQa.run({}), (error) => error.publicMessage === "browser_qa_failed");
  const status = browserQa.status({ready: true});
  assert.equal(status.state, "qa_execution_failed");
  assert.equal(status.lastRun.status, "failed");
});
