import {execFileSync} from "node:child_process";
import {createServer} from "node:http";
import {mkdir, readdir, readFile, readlink, rename, rm, stat, symlink, unlink, writeFile} from "node:fs/promises";
import path from "node:path";

const workspaceRoot = path.resolve(process.env.WORKSPACE_DIR || "/workspace");
const runnerId = String(process.env.MAPACHE_FIXTURE_RUNNER_ID || "runner").replace(/[^A-Za-z0-9._-]/g, "-");
const port = Number(process.env.PORT || 8080);

function workspacePath(relativePath) {
  const clean = String(relativePath || "").replace(/^\/+/, "");
  const target = path.resolve(workspaceRoot, clean);
  const relative = path.relative(workspaceRoot, target);
  if (!clean || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("fixture path must stay under /workspace");
  }
  return target;
}

async function jsonResponse(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {"content-type": "application/json", "cache-control": "no-store"});
  response.end(body);
}

async function listTree(root, prefix = "") {
  const entries = await readdir(root, {withFileTypes: true});
  const result = [];
  for (const entry of entries) {
    const relative = path.posix.join(prefix, entry.name);
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listTree(target, relative));
    else if (entry.isSymbolicLink()) result.push({path: relative, type: "symlink", target: await readlinkSafe(target)});
    else {
      const details = await stat(target);
      result.push({path: relative, type: "file", size: details.size});
    }
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function readlinkSafe(target) {
  try {
    return await readlink(target);
  } catch (error) {
    return `error:${error.code || "readlink_failed"}`;
  }
}

function gitEnv(gitDir) {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_DIR: gitDir,
    GIT_WORK_TREE: workspaceRoot,
    HOME: `/tmp/mapache-fixture-home-${runnerId}`,
  };
}

function git(gitDir, args) {
  return execFileSync("git", ["--git-dir", gitDir, "--work-tree", workspaceRoot, ...args], {
    cwd: workspaceRoot,
    env: gitEnv(gitDir),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function runGitFixture() {
  const gitDir = `/var/lib/mapache/git/fixture-${runnerId}`;
  await mkdir(gitDir, {recursive: true});
  try {
    await stat(path.join(gitDir, "HEAD"));
  } catch {
    git(gitDir, ["init", "--initial-branch=main"]);
    git(gitDir, ["config", "user.email", "mapache-fixture@example.invalid"]);
    git(gitDir, ["config", "user.name", "Mapache storage fixture"]);
  }
  await writeFile(workspacePath("git-fixture.txt"), `written by ${runnerId}\n`);
  git(gitDir, ["add", "--all"]);
  const diff = git(gitDir, ["diff", "--cached", "--name-status"]);
  git(gitDir, ["commit", "--allow-empty", "-m", `fixture ${runnerId}`]);
  return {
    ok: true,
    insideWorkTree: git(gitDir, ["rev-parse", "--is-inside-work-tree"]) === "true",
    status: git(gitDir, ["status", "--short"]),
    stagedDiff: diff,
    privateGitDir: gitDir,
    workspaceGitEntry: await exists(workspacePath(".git")),
  };
}

async function runPackageFixture() {
  await mkdir(workspacePath("scripts"), {recursive: true});
  await writeFile(workspacePath("package.json"), JSON.stringify({
    name: "mapache-storage-fixture",
    private: true,
    scripts: {fixture: "node scripts/storage-fixture.mjs"},
  }, null, 2));
  await writeFile(workspacePath("scripts/storage-fixture.mjs"), "console.log('fixture script invoked');\n");
  const output = execFileSync("npm", ["run", "fixture", "--", "--runner", runnerId], {
    cwd: workspaceRoot,
    env: {...process.env, HOME: `/tmp/mapache-fixture-home-${runnerId}`},
    encoding: "utf8",
  }).trim();
  return {ok: output.includes("fixture script invoked"), output: output.slice(-500)};
}

async function execute(action, url) {
  const relative = String(url.searchParams.get("path") || "shared/cross-run.txt");
  const content = String(url.searchParams.get("content") || `hello from ${runnerId}\n`);
  if (action === "write") {
    await mkdir(path.dirname(workspacePath(relative)), {recursive: true});
    await writeFile(workspacePath(relative), content);
    return {ok: true, action, runnerId, path: relative, content};
  }
  if (action === "read") {
    return {ok: true, action, runnerId, path: relative, content: await readFile(workspacePath(relative), "utf8")};
  }
  if (action === "overwrite") {
    await writeFile(workspacePath(relative), content);
    return {ok: true, action, runnerId, path: relative, content};
  }
  if (action === "rename") {
    const target = String(url.searchParams.get("target") || `${relative}.renamed`);
    await rename(workspacePath(relative), workspacePath(target));
    return {ok: true, action, runnerId, from: relative, to: target};
  }
  if (action === "delete") {
    await unlink(workspacePath(relative));
    return {ok: true, action, runnerId, path: relative};
  }
  if (action === "symlink") {
    const target = String(url.searchParams.get("target") || "shared/cross-run.txt");
    const link = String(url.searchParams.get("path") || "shared/cross-run.link");
    try {
      await rm(workspacePath(link), {force: true});
      await symlink(target, workspacePath(link));
      return {ok: true, supported: true, action, runnerId, path: link, target};
    } catch (error) {
      return {ok: false, supported: false, action, runnerId, code: error.code || "symlink_failed"};
    }
  }
  if (action === "git") return runGitFixture();
  if (action === "package") return runPackageFixture();
  if (action === "snapshot") {
    const tree = await listTree(workspaceRoot);
    return {ok: true, action, runnerId, tree, privateStateOutsideMount: !tree.some((entry) => entry.path === ".git" || entry.path.startsWith(".mapache/"))};
  }
  if (action === "concurrent") {
    try {
      await writeFile(workspacePath(relative), content);
      return {ok: true, action, runnerId, path: relative, content};
    } catch (error) {
      return {ok: false, action, runnerId, path: relative, code: error.code || "write_failed"};
    }
  }
  return {ok: true, action: "health", runnerId, workspaceRoot};
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);
    if (url.pathname !== "/fixture") return jsonResponse(response, 404, {ok: false, error: "not_found"});
    return jsonResponse(response, 200, await execute(url.searchParams.get("action") || "health", url));
  } catch (error) {
    return jsonResponse(response, 500, {ok: false, error: error.code || "fixture_failed", message: String(error.message || error).slice(0, 300)});
  }
});

await mkdir(workspaceRoot, {recursive: true});
server.listen(port, "0.0.0.0");
