import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoreWorkspace } from "../../server/core-workspace-adapter.js";
import { ClientStateStore } from "../../server/client-state.js";

const mode = vi.hoisted(() => ({ root: null as string | null }));
vi.mock("../../server/managed-workspace.js", async (original) => {
	const implementation = await original<typeof import("../../server/managed-workspace.js")>();
	const roots = () => mode.root ? [mode.root] : [];
	return {
		...implementation,
		managedWorkspaceRoot: () => mode.root,
		managedCwdAllowed: (path: string) => implementation.managedCwdAllowed(path, roots()),
		managedDisplayPath: (path: string) => implementation.managedDisplayPath(path, roots()),
	};
});

describe("managed Keel workspace host", () => {
	let directory: string;
	let root: string;
	let child: string;
	let outside: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "managed-core-workspace-"));
		root = join(directory, "workspace"); child = join(root, "child"); outside = join(directory, "outside");
		mkdirSync(child, { recursive: true }); mkdirSync(outside);
		symlinkSync(outside, join(root, "escape"));
		mode.root = root;
	});
	afterEach(() => { mode.root = null; rmSync(directory, { recursive: true, force: true }); });
	it("admits workspace descendants but refuses external targets and symlink escapes", async () => {
		const host = createCoreWorkspace();
		expect((await host.resolveTarget("child", root)).cwd).toBe(child);
		for (const target of [outside, join(root, "escape"), "ssh://foreign/project"]) {
			await expect(host.resolveTarget(target, root)).rejects.toThrow("managed_workspace_required");
		}
	});
	it("refuses extra roots before persistence and filters stale external roots on restore", () => {
		const file = join(directory, "state.json");
		writeFileSync(file, JSON.stringify({ client: { projects: [], workspaceRoots: { [root]: [child, outside, join(root, "escape")] } } }));
		const store = new ClientStateStore(file);
		expect(store.getWorkspaceRoots("client", root)).toEqual([child]);
		expect(() => store.saveWorkspaceRoots("client", root, [outside])).toThrow("managed_workspace_required");
		expect(store.getWorkspaceRoots("client", root)).toEqual([child]);
	});
	it("preserves standalone remote and external workspace support", async () => {
		mode.root = null;
		const host = createCoreWorkspace({ dataDir: directory });
		expect((await host.resolveTarget(outside, root)).cwd).toBe(outside);
		expect((await host.resolveTarget("ssh://foreign/project", root)).cwd).toBe("ssh://foreign/project");
	});
});
