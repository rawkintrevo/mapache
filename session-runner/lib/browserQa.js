"use strict";

const fs = require("fs");
const path = require("path");
const {normalizeEnvString, positiveNumber} = require("./utils");

const DEFAULT_VIEWPORTS = [
  {name: "desktop", width: 1440, height: 1000, isMobile: false},
  {name: "mobile", width: 390, height: 844, isMobile: true},
];

function createBrowserQaService(config, deps = {}) {
  const mkdir = deps.mkdir || fs.promises.mkdir;
  const rm = deps.rm || fs.promises.rm;
  const writeFile = deps.writeFile || fs.promises.writeFile;
  const isExecutable = deps.isExecutable || fileExecutable;
  const resolveModule = deps.resolveModule || defaultResolveModule;
  const runScenario = deps.runScenario || executeScenario;
  const now = deps.now || (() => new Date().toISOString());

  return {
    capabilityStatus,
    readLastRun,
    status,
    run,
  };

  function capabilityStatus() {
    const previewQaEnabled = Boolean(config.runnerCapabilities && config.runnerCapabilities.previewQa);
    const executableReady = isExecutable(config.browserQaExecutablePath);
    const playwrightModulePath = resolveModule("@playwright/test");
    const available = previewQaEnabled && executableReady && Boolean(playwrightModulePath);

    return {
      enabled: previewQaEnabled,
      available,
      engine: "playwright",
      browser: "chromium",
      command: config.browserQaCommand,
      executablePath: config.browserQaExecutablePath,
      modulePath: playwrightModulePath,
      qaDir: config.browserQaDir,
      supportedActions: ["goto", "click", "fill", "press", "waitFor", "screenshot"],
      supportedViewports: DEFAULT_VIEWPORTS,
      unavailableReason: available ? null : browserAvailabilityReason({
        previewQaEnabled,
        executableReady,
        playwrightModulePath,
      }),
    };
  }

  function readLastRun() {
    try {
      return JSON.parse(fs.readFileSync(config.browserQaStatePath, "utf8"));
    } catch (error) {
      return null;
    }
  }

  function status(previewStatus = {}) {
    const capability = capabilityStatus();
    const lastRun = readLastRun();
    const previewReady = Boolean(previewStatus.ready);
    let state = "browser_ready";
    if (!previewReady) state = "preview_not_running";
    else if (!capability.available) state = "browser_automation_unavailable";
    else if (lastRun && lastRun.status === "failed") state = "qa_execution_failed";

    return {
      ...capability,
      state,
      previewReady,
      lastRun,
    };
  }

  async function run(spec = {}, options = {}) {
    const capability = capabilityStatus();
    if (!capability.available) {
      const error = new Error(capability.unavailableReason || "browser automation unavailable");
      error.publicMessage = capability.unavailableReason || "browser_automation_unavailable";
      throw error;
    }

    const targetDir = normalizeTargetDir(config.browserQaDir, options.outputDir);
    await rm(targetDir, {recursive: true, force: true});
    await mkdir(targetDir, {recursive: true});

    const normalizedSpec = normalizeScenarioSpec(spec, config);
    const result = {
      ok: false,
      status: "failed",
      generatedAt: now(),
      targetDir,
      url: normalizedSpec.url,
      viewports: normalizedSpec.viewports,
    };

    try {
      const runResult = await runScenario({
        config,
        spec: normalizedSpec,
        targetDir,
      });
      Object.assign(result, runResult, {
        ok: runResult.status === "passed",
        status: runResult.status,
      });
    } catch (error) {
      result.error = compactBrowserQaError(error);
      result.summary = {
        failedRequests: [],
        pageErrors: [{message: result.error}],
        consoleErrors: [],
      };
    }

    await writeFile(path.join(targetDir, "report.json"), JSON.stringify(result, null, 2));
    await writeFile(path.join(targetDir, "report.md"), renderMarkdownReport(result));
    await writeFile(config.browserQaStatePath, JSON.stringify({
      generatedAt: result.generatedAt,
      reportPath: path.join(targetDir, "report.json"),
      status: result.status,
      summary: summarizeRun(result),
      url: result.url,
    }, null, 2));

    if (!result.ok) {
      const error = new Error(result.error || "browser_qa_failed");
      error.publicMessage = "browser_qa_failed";
      error.result = result;
      throw error;
    }
    return result;
  }
}

function normalizeScenarioSpec(spec = {}, config = {}) {
  const qaDir = config.browserQaDir || path.join(config.workspaceDir || "/workspace", ".mapache", "qa");
  const previewUrl = String(config.browserQaBaseUrl || config.mapachePreviewUrl || "").trim() ||
    `http://127.0.0.1:${config.port || 8080}${config.previewBasePath || "/preview"}/`;
  const url = normalizeScenarioUrl(spec.url || spec.path, previewUrl);
  return {
    url,
    baseUrl: previewUrl,
    outputDir: spec.outputDir || path.join(qaDir, "latest"),
    steps: Array.isArray(spec.steps) ? spec.steps : [],
    viewports: normalizeViewports(spec.viewports),
  };
}

function normalizeScenarioUrl(value, baseUrl) {
  const clean = normalizeEnvString(value);
  if (!clean) return baseUrl;
  try {
    return new URL(clean, baseUrl).toString();
  } catch (error) {
    return baseUrl;
  }
}

function normalizeViewports(value) {
  if (!Array.isArray(value) || !value.length) return DEFAULT_VIEWPORTS;
  return value.map((entry, index) => ({
    name: normalizeEnvString(entry && entry.name) || `viewport-${index + 1}`,
    width: positiveNumber(entry && entry.width, 1440),
    height: positiveNumber(entry && entry.height, 1000),
    isMobile: Boolean(entry && entry.isMobile),
  }));
}

function normalizeTargetDir(qaDir, requestedPath) {
  const resolvedQaDir = path.resolve(qaDir);
  const requested = normalizeEnvString(requestedPath);
  if (!requested) return path.join(resolvedQaDir, "latest");
  const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(resolvedQaDir, requested);
  if (candidate !== resolvedQaDir && candidate.startsWith(`${resolvedQaDir}${path.sep}`)) {
    return candidate;
  }
  return path.join(resolvedQaDir, "latest");
}

async function executeScenario({config, spec, targetDir}) {
  const {chromium} = require("@playwright/test");
  const browser = await chromium.launch({
    executablePath: config.browserQaExecutablePath,
    headless: config.browserQaHeadless,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const summary = {
    consoleErrors: [],
    consoleMessages: [],
    failedRequests: [],
    pageErrors: [],
  };
  const screenshots = [];

  try {
    for (const viewport of spec.viewports) {
      const context = await browser.newContext({
        isMobile: viewport.isMobile,
        viewport: {width: viewport.width, height: viewport.height},
      });
      const page = await context.newPage();
      wirePageTelemetry(page, summary);
      await page.goto(spec.url, {
        timeout: config.browserQaNavigationTimeoutMs,
        waitUntil: "networkidle",
      });
      await runScenarioSteps(page, spec.steps, viewport.name, config.browserQaActionTimeoutMs, targetDir, screenshots, spec.baseUrl);
      const screenshotPath = path.join(targetDir, `${viewport.name}.png`);
      await page.screenshot({path: screenshotPath, fullPage: true});
      screenshots.push(screenshotPath);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  const status = summary.consoleErrors.length || summary.failedRequests.length || summary.pageErrors.length ? "failed" : "passed";
  return {
    screenshots,
    status,
    summary,
  };
}

async function runScenarioSteps(page, steps, viewportName, timeoutMs, targetDir, screenshots, baseUrl) {
  for (const step of steps) {
    if (Array.isArray(step.viewports) && step.viewports.length && !step.viewports.includes(viewportName)) {
      continue;
    }
    const action = normalizeEnvString(step.action).toLowerCase();
    if (action === "goto") {
      const targetUrl = resolveStepUrl(step.url || step.path || page.url(), page.url() || baseUrl || "http://127.0.0.1/");
      await page.goto(targetUrl, {
        timeout: positiveNumber(step.timeoutMs, timeoutMs),
        waitUntil: step.waitUntil || "networkidle",
      });
      continue;
    }
    if (action === "click") {
      await page.locator(step.selector).click({timeout: positiveNumber(step.timeoutMs, timeoutMs)});
      continue;
    }
    if (action === "fill") {
      await page.locator(step.selector).fill(String(step.value || ""), {timeout: positiveNumber(step.timeoutMs, timeoutMs)});
      continue;
    }
    if (action === "press") {
      await page.locator(step.selector).press(String(step.key || "Enter"), {timeout: positiveNumber(step.timeoutMs, timeoutMs)});
      continue;
    }
    if (action === "waitfor") {
      if (step.selector) {
        await page.locator(step.selector).waitFor({
          state: step.state || "visible",
          timeout: positiveNumber(step.timeoutMs, timeoutMs),
        });
      } else {
        await page.waitForTimeout(positiveNumber(step.timeoutMs, timeoutMs));
      }
      continue;
    }
    if (action === "screenshot") {
      const fileName = normalizeEnvString(step.name) || `${viewportName}-${screenshots.length + 1}`;
      const screenshotPath = path.join(targetDir, `${fileName}.png`);
      await page.screenshot({path: screenshotPath, fullPage: Boolean(step.fullPage !== false)});
      screenshots.push(screenshotPath);
    }
  }
}

function resolveStepUrl(value, baseUrl) {
  try {
    return new URL(String(value || ""), baseUrl).toString();
  } catch (error) {
    return baseUrl;
  }
}

function wirePageTelemetry(page, summary) {
  page.on("console", (message) => {
    const entry = {level: message.type(), text: message.text()};
    summary.consoleMessages.push(entry);
    if (["assert", "error"].includes(entry.level)) {
      summary.consoleErrors.push(entry);
    }
  });
  page.on("pageerror", (error) => {
    summary.pageErrors.push({message: error.message});
  });
  page.on("requestfailed", (request) => {
    summary.failedRequests.push({
      errorText: request.failure() && request.failure().errorText || "request_failed",
      method: request.method(),
      url: request.url(),
    });
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      summary.failedRequests.push({
        method: response.request().method(),
        status: response.status(),
        url: response.url(),
      });
    }
  });
}

function fileExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch (error) {
    return false;
  }
}

function defaultResolveModule(name) {
  try {
    return require.resolve(name);
  } catch (error) {
    return "";
  }
}

function browserAvailabilityReason({previewQaEnabled, executableReady, playwrightModulePath}) {
  if (!previewQaEnabled) return "browser_qa_disabled";
  if (!executableReady) return "chromium_not_available";
  if (!playwrightModulePath) return "playwright_not_available";
  return null;
}

function compactBrowserQaError(error) {
  return normalizeEnvString(error && (error.stack || error.message || String(error))).slice(0, 4000) || "browser_qa_failed";
}

function summarizeRun(result = {}) {
  const summary = result.summary || {};
  return {
    consoleErrorCount: Array.isArray(summary.consoleErrors) ? summary.consoleErrors.length : 0,
    failedRequestCount: Array.isArray(summary.failedRequests) ? summary.failedRequests.length : 0,
    pageErrorCount: Array.isArray(summary.pageErrors) ? summary.pageErrors.length : 0,
    screenshotCount: Array.isArray(result.screenshots) ? result.screenshots.length : 0,
  };
}

function renderMarkdownReport(result = {}) {
  const summary = summarizeRun(result);
  return [
    `# Browser QA ${result.status || "failed"}`,
    "",
    `- Generated: ${result.generatedAt || "unknown"}`,
    `- URL: ${result.url || "unknown"}`,
    `- Screenshots: ${summary.screenshotCount}`,
    `- Console errors: ${summary.consoleErrorCount}`,
    `- Failed requests: ${summary.failedRequestCount}`,
    `- Page errors: ${summary.pageErrorCount}`,
    result.error ? "" : null,
    result.error ? `## Error\n\n\`\`\`\n${result.error}\n\`\`\`` : null,
  ].filter(Boolean).join("\n");
}

module.exports = {
  DEFAULT_VIEWPORTS,
  createBrowserQaService,
  normalizeScenarioSpec,
  normalizeTargetDir,
};
