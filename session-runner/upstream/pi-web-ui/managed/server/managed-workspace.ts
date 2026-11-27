import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { relative, join } from "node:path";
import { isInsideRoots } from "./path-boundary.js";
import { isManaged } from "./managed.js";

const MAPACHE_HOME = "/home/mapache";
export const MANAGED_WORKSPACE_ROOT = "/workspace";

export function managedWorkspaceRoot(env: NodeJS.ProcessEnv = process.env): string | null {
	return isManaged(env) ? MANAGED_WORKSPACE_ROOT : null;
}

/** Use the upstream boundary resolver, including symlinks and missing descendants. */
export function pathWithinRoot(root: string, target: string): boolean {
	return isInsideRoots(target, [root]);
}

/** Follow existing symlinks before accepting a managed workspace path. */
export function isCanonicalPathWithinRootSync(root: string, target: string): boolean {
	try {
		return pathWithinRoot(realpathSync(root), realpathSync(target));
	} catch {
		return false;
	}
}

export async function isCanonicalPathWithinRoot(root: string, target: string): Promise<boolean> {
	try {
		return pathWithinRoot(await realpath(root), await realpath(target));
	} catch {
		return false;
	}
}

/** Only the runner-provisioned interactive home can become a second project root. */
export function managedProjectRoots(env: NodeJS.ProcessEnv = process.env): string[] {
	if (!isManaged(env)) return [];
	const output = env.MAPACHE_AUTOMATION_OUTPUT_DIR;
	if (output && output === env.PI_WEB_CWD && /^\/automation-output\/[a-zA-Z0-9_-]+$/.test(output)) {
		return [output, MANAGED_WORKSPACE_ROOT];
	}
	return env.HOME === MAPACHE_HOME && env.PI_WEB_CWD === MAPACHE_HOME
		? [MAPACHE_HOME, MANAGED_WORKSPACE_ROOT]
		: [MANAGED_WORKSPACE_ROOT];
}

export function managedCwdAllowed(target: string, roots = managedProjectRoots()): boolean {
	return !roots.length || roots.some(root => isCanonicalPathWithinRootSync(root, target));
}

export function managedDisplayPath(target: string, roots = managedProjectRoots()): string {
	const canonical = realpathSync(target);
	for (const root of roots) {
		if (isCanonicalPathWithinRootSync(root, canonical)) {
			return join(root, relative(realpathSync(root), canonical));
		}
	}
	throw new Error("Directory is outside the managed project roots");
}
