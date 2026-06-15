"use strict";

const fs = require("fs");
const path = require("path");
const {spawn} = require("child_process");
const {collectStderr, waitForChild} = require("./processes");
const {
  compactErrorMessage,
  normalizeRelativeWorkspacePath,
  pathExists,
  readJsonFile,
  safeReadDir,
} = require("./utils");

function createPiService({config, syncUp}) {
  let packageOperationLock = null;
  let skillOperationLock = null;

  async function withPackageOperationLock(options, operation) {
    while (packageOperationLock) {
      if (!options || !options.read) {
        const busyError = new Error("package_operation_busy");
        busyError.code = "package_operation_busy";
        throw busyError;
      }
      await packageOperationLock.catch(() => {});
    }

    let releaseLock;
    const currentLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    packageOperationLock = currentLock;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (packageOperationLock === currentLock) {
        packageOperationLock = null;
      }
    }
  }

  async function withSkillOperationLock(options, operation) {
    while (skillOperationLock) {
      if (!options || !options.read) {
        const busyError = new Error("skill_operation_busy");
        busyError.code = "skill_operation_busy";
        throw busyError;
      }
      await skillOperationLock.catch(() => {});
    }

    let releaseLock;
    const currentLock = new Promise((resolve) => {
      releaseLock = resolve;
    });
    skillOperationLock = currentLock;
    try {
      return await operation();
    } finally {
      releaseLock();
      if (skillOperationLock === currentLock) {
        skillOperationLock = null;
      }
    }
  }

  async function listWorkspacePiPackages() {
    const settingsPath = path.join(config.workspaceDir, ".pi", "settings.json");
    const userSettingsPath = path.join(process.env.PI_HOME_DIR || "/root/.pi", "agent", "settings.json");
    const settings = await readJsonFile(settingsPath, {});
    const userSettings = await readJsonFile(userSettingsPath, {});
    const packages = await listPiPackageSettingsEntries(settings, "workspace");
    const userPackages = await listPiPackageSettingsEntries(userSettings, "user");

    return {
      ok: true,
      scope: "workspace",
      settingsPath,
      packages,
      userPackages,
    };
  }

  async function listPiPackageSettingsEntries(settings, scope) {
    const packages = Array.isArray(settings.packages) ? settings.packages : [];
    return Promise.all(packages
        .map((entry) => normalizePiPackageSettingsEntry(entry, scope))
        .filter(Boolean)
        .map(async (entry) => ({
          ...entry,
          installedPath: await resolveInstalledPiPackagePath(entry.source, scope),
        })));
  }

  async function installWorkspacePiPackage(body) {
    const source = normalizePiMutationPackageSource(body.source);
    await runPiCommand(["install", "-l", source]);
    await syncUp({includeArchives: true});
    return {
      ok: true,
      action: "install",
      source,
      packages: (await listWorkspacePiPackages()).packages,
    };
  }

  async function removeWorkspacePiPackage(body) {
    const source = normalizePiMutationPackageSource(body.source);
    await runPiCommand(["remove", "-l", source]);
    await syncUp({includeArchives: true});
    return {
      ok: true,
      action: "remove",
      source,
      packages: (await listWorkspacePiPackages()).packages,
    };
  }

  async function updateWorkspacePiPackages(body) {
    const source = body.source ? normalizePiMutationPackageSource(body.source) : "";
    const args = source ? ["update", "--extension", source] : ["update", "--extensions"];
    await runPiCommand(args);
    await syncUp({includeArchives: true});
    return {
      ok: true,
      action: "update",
      source: source || null,
      packages: (await listWorkspacePiPackages()).packages,
    };
  }

  async function seedDefaultRuntimeSkills() {
    const skills = defaultRuntimeSkills(config.runnerCapabilities);
    if (!skills.length) return;

    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    await fs.promises.mkdir(skillsPath, {recursive: true});

    for (const skill of skills) {
      const skillDir = path.join(skillsPath, skill.name);
      const skillPath = path.join(skillDir, "SKILL.md");
      if (await pathExists(skillPath)) continue;
      await fs.promises.mkdir(skillDir, {recursive: true});
      await fs.promises.writeFile(skillPath, skill.content, "utf8");
    }
  }

  async function listWorkspacePiSkills() {
    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    const skills = [];
    const entries = await safeReadDir(skillsPath);

    for (const entry of entries) {
      const entryPath = path.join(skillsPath, entry.name);
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const content = await readSkillMarkdown(entryPath);
        skills.push(skillSummaryFromMarkdown(content, {
          path: `.pi/skills/${entry.name}`,
          kind: "file",
          editable: true,
          fallbackName: entry.name.replace(/\.md$/i, ""),
        }));
        continue;
      }
      if (entry.isDirectory()) {
        const skillPath = path.join(entryPath, "SKILL.md");
        if (await pathExists(skillPath)) {
          const content = await readSkillMarkdown(skillPath);
          skills.push(skillSummaryFromMarkdown(content, {
            path: `.pi/skills/${entry.name}/SKILL.md`,
            kind: "directory",
            editable: true,
            fallbackName: entry.name,
          }));
        }
      }
    }

    return {
      ok: true,
      scope: "workspace",
      skillsPath,
      skills: skills.sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  async function saveWorkspacePiSkill(body) {
    const name = normalizePiSkillName(body.name);
    const description = normalizePiSkillDescription(body.description);
    const instructions = normalizePiSkillContent(body.content || body.instructions || "");
    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    const skillDir = path.join(skillsPath, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    await fs.promises.mkdir(skillDir, {recursive: true});
    const markdown = buildPiSkillMarkdown({name, description, content: instructions});
    await fs.promises.writeFile(skillPath, markdown, "utf8");
    await syncUp({includeArchives: false});
    return {
      ok: true,
      action: "save",
      skill: skillSummaryFromMarkdown(markdown, {
        path: `.pi/skills/${name}/SKILL.md`,
        kind: "directory",
        editable: true,
        fallbackName: name,
      }),
      skills: (await listWorkspacePiSkills()).skills,
    };
  }

  async function deleteWorkspacePiSkill(body) {
    const name = normalizePiSkillName(body.name);
    const skillsPath = path.join(config.workspaceDir, ".pi", "skills");
    const skillDir = path.join(skillsPath, name);
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!await pathExists(skillPath)) {
      const rootMdPath = path.join(skillsPath, `${name}.md`);
      if (!await pathExists(rootMdPath)) {
        const error = new Error("skill_not_found");
        error.code = "skill_not_found";
        throw error;
      }
      await fs.promises.unlink(rootMdPath);
    } else {
      await fs.promises.rm(skillDir, {recursive: true, force: true});
    }
    await syncUp({includeArchives: false});
    return {
      ok: true,
      action: "delete",
      name,
      skills: (await listWorkspacePiSkills()).skills,
    };
  }

  async function readSkillMarkdown(skillPath) {
    const stat = await fs.promises.stat(skillPath);
    if (stat.size > 256 * 1024) {
      const error = new Error("invalid_skill_content");
      error.code = "invalid_skill_content";
      throw error;
    }
    return fs.promises.readFile(skillPath, "utf8");
  }

  async function runPiCommand(args) {
    const child = spawn("pi", args, {
      cwd: config.workspaceDir,
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });
    const stderr = collectStderr(child);
    try {
      await waitForChild(child, stderr, `pi ${args[0]}`);
    } catch (error) {
      throw new Error(compactErrorMessage(error.message || error) || "pi_command_failed");
    }
  }

  async function resolveInstalledPiPackagePath(source, scope = "workspace") {
    const parsed = classifyPiPackageSource(source);
    const root = scope === "user" ?
      path.join(process.env.PI_HOME_DIR || "/root/.pi", "agent") :
      path.join(config.workspaceDir, ".pi");
    if (parsed.type === "npm" && parsed.name) {
      return existingManagedPackagePath(path.join(root, "npm", "node_modules"), [parsed.name]);
    }
    if (parsed.type === "git" && parsed.host && parsed.gitPath) {
      return existingManagedPackagePath(path.join(root, "git"), [parsed.host, ...parsed.gitPath.split("/")]);
    }
    if (parsed.type === "local" && parsed.localPath) {
      const resolved = resolveWorkspacePackagePath(parsed.localPath);
      return resolved && await pathExists(resolved) ? resolved : null;
    }
    return null;
  }

  async function existingManagedPackagePath(root, parts) {
    const resolvedRoot = path.resolve(root);
    const resolvedPath = path.resolve(resolvedRoot, ...parts);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
    return await pathExists(resolvedPath) ? resolvedPath : null;
  }

  function resolveWorkspacePackagePath(packagePath) {
    const resolvedRoot = path.resolve(config.workspaceDir);
    const resolvedPath = path.resolve(resolvedRoot, packagePath);
    if (resolvedPath !== resolvedRoot && !resolvedPath.startsWith(`${resolvedRoot}${path.sep}`)) return null;
    return resolvedPath;
  }

  return {
    deleteWorkspacePiSkill,
    installWorkspacePiPackage,
    listWorkspacePiPackages,
    listWorkspacePiSkills,
    removeWorkspacePiPackage,
    saveWorkspacePiSkill,
    seedDefaultRuntimeSkills,
    updateWorkspacePiPackages,
    withPackageOperationLock,
    withSkillOperationLock,
  };
}

function sendPiPackageError(res, error, fallbackCode) {
  if (error && error.code === "package_operation_busy") {
    res.status(409).json({error: "package_operation_busy", busy: true});
    return;
  }
  if (error && error.code === "invalid_package_source") {
    res.status(400).json({error: "invalid_package_source"});
    return;
  }
  if (error && error.code === "unsupported_package_source") {
    res.status(400).json({error: "unsupported_package_source"});
    return;
  }
  console.error(`${fallbackCode.replace(/_/g, " ")}`, error);
  res.status(500).json({error: fallbackCode});
}

function sendPiSkillError(res, error, fallbackCode) {
  if (error && error.code === "skill_operation_busy") {
    res.status(409).json({error: "skill_operation_busy", busy: true});
    return;
  }
  if (error && [
    "invalid_skill_name",
    "invalid_skill_description",
    "invalid_skill_content",
    "skill_not_found",
  ].includes(error.code)) {
    res.status(error.code === "skill_not_found" ? 404 : 400).json({error: error.code});
    return;
  }
  console.error(`${fallbackCode.replace(/_/g, " ")}`, error);
  res.status(500).json({error: fallbackCode});
}

function defaultRuntimeSkills(capabilities = {}) {
  if (capabilities.n64) return defaultPiN64Skills();
  if (capabilities.preview) return defaultPiWebSkills();
  return [];
}

function defaultPiWebSkills() {
  return [
    {
      name: "mapache-preview-build",
      content: buildPiSkillMarkdown({
        name: "mapache-preview-build",
        description: "Build static web output where the Mapache pi-web preview canvas can serve it.",
        content: `Use this skill when building a static website or static frontend bundle in a Mapache pi-web session.

## Contract

- The preview gateway serves static files from /workspace/build by default.
- The preview is ready when /workspace/build/index.html exists.
- The browser preview URL is available as $MAPACHE_PREVIEW_URL.
- The local runner control URL is available as $MAPACHE_RUNNER_URL.

## Build Steps

1. Build or copy the final static site into /workspace/build.
2. Make sure the entry point is /workspace/build/index.html.
3. Check readiness with: curl "$MAPACHE_RUNNER_URL/preview/status"
4. Open or QA the site at $MAPACHE_PREVIEW_URL.

## Common Frameworks

For Vite, prefer:

\`\`\`bash
npm run build -- --outDir build
\`\`\`

or set build.outDir = "build" in vite.config.js.

For projects that output to dist, out, or public, either configure the framework to emit build directly or copy the generated output into /workspace/build.

## Rules

- Do not put source files only in build; put the generated browser-loadable output there.
- Do not assume dist is visible in the preview unless .mapache/preview.json changes the static root.
- Prefer relative asset paths or configure the app base path so assets load correctly under /preview/.`,
      }),
    },
    {
      name: "mapache-api-hosting",
      content: buildPiSkillMarkdown({
        name: "mapache-api-hosting",
        description: "Host an app or API behind the Mapache pi-web preview gateway.",
        content: `Use this skill when a preview needs a running server, API routes, server-rendered app, or function emulator instead of only static files.

## Contract

The runner can proxy /preview/* to a local HTTP server when the workspace contains /workspace/.mapache/preview.json:

\`\`\`json
{
  "mode": "proxy",
  "upstream": "http://127.0.0.1:3000"
}
\`\`\`

Only localhost upstreams are accepted. Use 127.0.0.1 or localhost.

## Server Steps

1. Start the app or API server on a local port, usually 127.0.0.1:3000.
2. Write /workspace/.mapache/preview.json with mode "proxy" and the upstream URL.
3. Check readiness with: curl "$MAPACHE_RUNNER_URL/preview/status"
4. Test through the gateway with: curl "$MAPACHE_PREVIEW_URL"

## Examples

Vite dev server:

\`\`\`bash
npm run dev -- --host 127.0.0.1 --port 3000
\`\`\`

Express or Node API:

\`\`\`bash
HOST=127.0.0.1 PORT=3000 npm start
\`\`\`

Function framework:

\`\`\`bash
npx functions-framework --target=app --host=127.0.0.1 --port=3000
\`\`\`

## Return To Static Mode

Remove /workspace/.mapache/preview.json or write:

\`\`\`json
{
  "mode": "static",
  "staticRoot": "build"
}
\`\`\`

## Rules

- Keep servers bound to localhost.
- Do not expose secret-bearing debug endpoints in the preview.
- Use $MAPACHE_PREVIEW_URL for QA, because it exercises the same route the user sees in the Preview canvas.`,
      }),
    },
    {
      name: "mapache-preview-qa",
      content: buildPiSkillMarkdown({
        name: "mapache-preview-qa",
        description: "QA a Mapache pi-web preview with status checks, console logs, screenshots, and Playwright.",
        content: `Use this skill after building a site or starting a preview server in a Mapache pi-web session.

## Contract

- Preview URL: $MAPACHE_PREVIEW_URL
- Runner URL: $MAPACHE_RUNNER_URL
- QA artifact directory: $MAPACHE_QA_DIR
- Browser console/error logs: $MAPACHE_RUNNER_URL/preview/logs
- Preview status: $MAPACHE_RUNNER_URL/preview/status

## QA Steps

1. Create the QA directory: mkdir -p "$MAPACHE_QA_DIR/latest"
2. Confirm preview readiness: curl "$MAPACHE_RUNNER_URL/preview/status"
3. Load the page with Playwright, capture screenshots, and collect console/page errors.
4. Check runner-side browser logs: curl "$MAPACHE_RUNNER_URL/preview/logs"
5. Write findings to $MAPACHE_QA_DIR/latest/report.md and $MAPACHE_QA_DIR/latest/report.json.

## Minimal Playwright Screenshot

\`\`\`bash
node - <<'EOF'
const { chromium } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

(async () => {
  const qaDir = process.env.MAPACHE_QA_DIR || '/workspace/.mapache/qa';
  const outDir = path.join(qaDir, 'latest');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const events = [];
  page.on('console', (msg) => events.push({ type: 'console', level: msg.type(), text: msg.text() }));
  page.on('pageerror', (error) => events.push({ type: 'pageerror', text: error.message }));
  await page.goto(process.env.MAPACHE_PREVIEW_URL, { waitUntil: 'networkidle' });
  await page.screenshot({ path: path.join(outDir, 'home-desktop.png'), fullPage: true });
  fs.writeFileSync(path.join(outDir, 'events.json'), JSON.stringify(events, null, 2));
  await browser.close();
})();
EOF
\`\`\`

## What To Look For

- Blank screens or missing primary content.
- Console errors, unhandled promise rejections, failed network requests, and broken assets.
- Layout clipping or overlap at desktop and mobile viewport sizes.
- Buttons and navigation that do not respond.
- Forms that cannot be completed or fail without useful feedback.

## Rules

- Save screenshots and reports under $MAPACHE_QA_DIR/latest.
- Prefer testing through $MAPACHE_PREVIEW_URL, not direct localhost upstream ports.
- Treat console errors as actionable unless they are clearly third-party noise and documented in the report.`,
      }),
    },
  ];
}

function defaultPiN64Skills() {
  return [
    {
      name: "mapache-n64-build",
      content: buildPiSkillMarkdown({
        name: "mapache-n64-build",
        description: "Build and package Nintendo 64 homebrew ROM artifacts for the pi-n64 preview.",
        content: `Use this skill when creating or updating Nintendo 64 homebrew in a Mapache pi-n64 session.

## Contract

- The workspace uses the libdragon SDK and MIPS N64 toolchain installed in the runner.
- The preview looks for the primary ROM at /workspace/build/game.z64.
- Build commands should run from /workspace unless the project has its own documented subdirectory.
- The local runner control URL is available as $MAPACHE_RUNNER_URL.

## Build Steps

1. Inspect the project Makefile or build script before changing commands.
2. Build the ROM with the project's existing command, usually make.
3. Create /workspace/build if it does not exist.
4. Copy or emit the playable ROM to /workspace/build/game.z64.
5. Check readiness with: curl "$MAPACHE_RUNNER_URL/preview/status"

## New Project Defaults

For a new libdragon project, prefer a small Makefile that includes the installed libdragon n64.mk file and produces a .z64 ROM. Keep source files outside /workspace/build and treat build as generated output.

## Rules

- Build only homebrew ROMs owned by the workspace.
- Do not use proprietary Nintendo SDK files, leaked headers, commercial ROMs, or assets without permission.
- Keep the final ROM path stable so the Preview tab and QA scripts can find it.`,
      }),
    },
    {
      name: "mapache-n64-preview",
      content: buildPiSkillMarkdown({
        name: "mapache-n64-preview",
        description: "Use the Mapache pi-n64 browser emulator preview contract for ROM artifacts.",
        content: `Use this skill after building a Nintendo 64 homebrew ROM in a Mapache pi-n64 session.

## Contract

- Preview URL: $MAPACHE_PREVIEW_URL
- Status endpoint: $MAPACHE_RUNNER_URL/preview/status
- ROM endpoint: $MAPACHE_RUNNER_URL/preview/rom.z64
- Expected ROM file: /workspace/build/game.z64
- The Preview tab loads the ROM through the Mapache EmulatorJS shell when the ROM exists.

## Preview Steps

1. Confirm /workspace/build/game.z64 exists.
2. Check status: curl "$MAPACHE_RUNNER_URL/preview/status"
3. Open $MAPACHE_PREVIEW_URL to run the ROM in the browser emulator shell.
4. Use $MAPACHE_RUNNER_URL/preview/rom.z64 as the stable ROM URL for downloads or external emulator checks.

## Optional Preview Config

Write /workspace/.mapache/preview.json to override the ROM path or emulator core:

\`\`\`json
{
  "mode": "n64",
  "rom": "build/custom.z64",
  "core": "mupen64plus_next"
}
\`\`\`

Accepted core values are "n64", "parallel_n64", and the alias "parallel-n64". Existing configs that use "mupen64plus_next" are accepted but normalized to "parallel_n64" for browser preview reliability.

## Notes

The browser preview is useful for fast iteration, but it does not claim hardware accuracy. Validate serious compatibility with a modern native N64 emulator or real hardware.`,
      }),
    },
  ];
}

function skillSummaryFromMarkdown(markdown, options = {}) {
  const frontmatter = parseSkillFrontmatter(markdown);
  const name = safePiSkillName(frontmatter.name || options.fallbackName || "");
  const description = String(frontmatter.description || "").trim().slice(0, 1024);
  return {
    name,
    description,
    path: options.path || "",
    kind: options.kind || "file",
    editable: Boolean(options.editable),
    content: markdown,
  };
}

function parseSkillFrontmatter(markdown) {
  const match = String(markdown || "").match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  return match[1].split("\n").reduce((acc, line) => {
    const field = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!field) return acc;
    acc[field[1]] = field[2].replace(/^['\"]|['\"]$/g, "").trim();
    return acc;
  }, {});
}

function safePiSkillName(value) {
  try {
    return normalizePiSkillName(value);
  } catch (error) {
    return "unnamed-skill";
  }
}

function normalizePiSkillName(value) {
  const name = String(value || "").trim().toLowerCase();
  if (!name || name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    const error = new Error("invalid_skill_name");
    error.code = "invalid_skill_name";
    throw error;
  }
  return name;
}

function normalizePiSkillDescription(value) {
  const description = String(value || "").trim();
  if (!description || description.length > 1024 || /[\u0000-\u001f\u007f]/.test(description)) {
    const error = new Error("invalid_skill_description");
    error.code = "invalid_skill_description";
    throw error;
  }
  return description;
}

function normalizePiSkillContent(value) {
  const content = String(value || "").trim();
  if (!content || content.length > 128 * 1024 || /\u0000/.test(content)) {
    const error = new Error("invalid_skill_content");
    error.code = "invalid_skill_content";
    throw error;
  }
  return content;
}

function buildPiSkillMarkdown({name, description, content}) {
  const body = String(content || "").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, " ")}\n---\n\n${body}\n`;
}

function normalizePiMutationPackageSource(source) {
  const normalized = String(source || "").trim();
  if (!normalized || normalized.length > 2048 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    const error = new Error("invalid_package_source");
    error.code = "invalid_package_source";
    throw error;
  }
  if (hasPackageSourceCredentials(normalized)) {
    const error = new Error("invalid_package_source");
    error.code = "invalid_package_source";
    throw error;
  }
  const parsed = classifyPiPackageSource(normalized);
  if (parsed.type !== "npm" && parsed.type !== "git") {
    const error = new Error("unsupported_package_source");
    error.code = "unsupported_package_source";
    throw error;
  }
  if (parsed.type === "npm" && !/^(@[^/]+\/[^@/]+|[^@/]+)(?:@[^\s/]+)?$/.test(normalized.slice("npm:".length))) {
    const error = new Error("invalid_package_source");
    error.code = "invalid_package_source";
    throw error;
  }
  return normalized;
}

function hasPackageSourceCredentials(source) {
  const candidate = source.startsWith("git+") ? source.slice("git+".length) : source;
  try {
    const parsed = new URL(candidate.startsWith("git:") ? candidate.slice("git:".length) : candidate);
    return Boolean(parsed.username || parsed.password);
  } catch (error) {
    return false;
  }
}

function normalizePiPackageSettingsEntry(entry, scope = "workspace") {
  const source = typeof entry === "string" ? entry : entry && typeof entry.source === "string" ? entry.source : "";
  const safeSource = redactPackageSource(source.trim());
  if (!safeSource) return null;

  const filters = typeof entry === "object" && entry && !Array.isArray(entry) ? {...entry} : {};
  delete filters.source;
  Object.keys(filters).forEach((key) => {
    if (filters[key] === undefined || filters[key] === null) delete filters[key];
  });

  return {
    source: safeSource,
    scope,
    type: classifyPiPackageSource(safeSource).type,
    installedPath: null,
    filtered: Object.keys(filters).length > 0,
  };
}

function redactPackageSource(source) {
  if (!source) return "";
  const gitPrefix = source.startsWith("git+") ? "git+" : "";
  const candidate = gitPrefix ? source.slice(gitPrefix.length) : source;
  try {
    const parsed = new URL(candidate);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
      return `${gitPrefix}${parsed.toString()}`;
    }
  } catch (error) {
    // Non-URL package sources are expected for npm and git shorthand packages.
  }
  return source;
}

function classifyPiPackageSource(source) {
  if (source.startsWith("npm:")) {
    const spec = source.slice("npm:".length).trim();
    const npmMatch = spec.match(/^(@[^/]+\/[^@]+|[^@]+)(?:@(.+))?$/);
    return {type: "npm", name: npmMatch ? npmMatch[1] : spec};
  }

  const gitSource = parsePiGitPackageSource(source);
  if (gitSource) return {type: "git", ...gitSource};

  return {type: "local", localPath: source};
}

function parsePiGitPackageSource(source) {
  const withoutGitPrefix = source.startsWith("git:") ? source.slice("git:".length) : source;
  const withoutGitPlus = withoutGitPrefix.startsWith("git+") ? withoutGitPrefix.slice("git+".length) : withoutGitPrefix;
  const withoutRef = withoutGitPlus.split("#")[0];

  const sshMatch = withoutRef.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) return buildPiGitPackageSource(sshMatch[1], sshMatch[2]);

  const githubShorthand = withoutRef.match(/^github:([^/]+\/.+)$/);
  if (githubShorthand) return buildPiGitPackageSource("github.com", githubShorthand[1]);

  try {
    const parsed = new URL(withoutRef);
    if (["git:", "https:", "http:", "ssh:"].includes(parsed.protocol)) {
      return buildPiGitPackageSource(parsed.hostname, parsed.pathname.replace(/^\/+/, ""));
    }
  } catch (error) {
    // Not a URL-shaped git source.
  }

  return null;
}

function buildPiGitPackageSource(host, gitPath) {
  const normalizedHost = String(host || "").toLowerCase();
  const normalizedPath = normalizeRelativeWorkspacePath(String(gitPath || "").replace(/\.git$/, ""));
  const parts = normalizedPath.split("/").filter(Boolean);
  if (!normalizedHost || !parts.length || parts.some((part) => part === "." || part === "..")) return null;
  return {host: normalizedHost, gitPath: parts.join("/")};
}

module.exports = {
  createPiService,
  sendPiPackageError,
  sendPiSkillError,
};
