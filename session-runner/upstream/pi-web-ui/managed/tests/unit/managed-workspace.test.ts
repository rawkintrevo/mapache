import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, it } from "vitest";
import {
  isCanonicalPathWithinRoot,
  isCanonicalPathWithinRootSync,
  managedProjectRoots,
  pathWithinRoot,
} from "../../server/managed-workspace.js";

describe("managed workspace", () => {
  it("defaults interactive managed sessions to the provisioned home and keeps the worktree accessible", () => {
    const env = { PI_WEB_MANAGED: "1", HOME: "/home/mapache", PI_WEB_CWD: "/home/mapache" };
    assert.deepEqual(managedProjectRoots(env), ["/home/mapache", "/workspace"]);
    assert.deepEqual(managedProjectRoots({ ...env, PI_WEB_CWD: "/automation-output/run" }), ["/workspace"]);
    assert.deepEqual(managedProjectRoots({ ...env, HOME: "/root" }), ["/workspace"]);
    assert.deepEqual(managedProjectRoots({ ...env, PI_WEB_MANAGED: "0" }), []);
  });

  it("checks canonical paths and rejects symlink escapes", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-ui-managed-workspace-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    const link = join(workspace, "link");
    await mkdir(workspace);
    await mkdir(outside);
    await symlink(outside, link);

    assert.equal(pathWithinRoot(workspace, join(workspace, "project")), true);
    assert.equal(pathWithinRoot(workspace, outside), false);
    assert.equal(pathWithinRoot(workspace, link), false);
    assert.equal(pathWithinRoot(workspace, join(link, "new-file")), false);
    assert.equal(isCanonicalPathWithinRootSync(workspace, workspace), true);
    assert.equal(isCanonicalPathWithinRootSync(workspace, link), false);
    assert.equal(await isCanonicalPathWithinRoot(workspace, link), false);

    await rm(root, { recursive: true, force: true });
  });

  it("shares flat SDK history IDs and branches across independent clients", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-ui-flat-history-"));
    const workspace = join(root, "workspace");
    const history = join(root, "history");
    await mkdir(workspace);
    await mkdir(history);

    const manager = SessionManager.create(workspace, history, {
      id: "task11-shared-session",
    });
    const userId = manager.appendMessage({
      role: "user",
      content: [{ type: "text", text: "shared" }],
      timestamp: Date.now(),
    } as never);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "reply" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as never);
    manager.branch(userId);
    manager.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "branched" }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    } as never);

    const sessionFile = manager.getSessionFile();
    assert.ok(sessionFile);
    assert.equal(dirname(sessionFile), history);
    const firstClient = await SessionManager.list(workspace, history);
    const secondClient = await SessionManager.list(workspace, history);
    assert.deepEqual(
      secondClient.map((entry) => entry.id),
      firstClient.map((entry) => entry.id),
    );
    assert.equal(firstClient[0]?.id, "task11-shared-session");

    const opened = SessionManager.open(sessionFile, history);
    assert.equal(opened.getSessionId(), "task11-shared-session");
    assert.equal(opened.getCwd(), workspace);
    assert.equal(opened.getSessionDir(), history);
    assert.equal(opened.getLeafId(), manager.getLeafId());
    assert.equal(opened.getBranch().length, 2);

    await rm(root, { recursive: true, force: true });
  });
});
