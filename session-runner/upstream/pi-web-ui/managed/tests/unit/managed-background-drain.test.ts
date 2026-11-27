import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createCoreBackground } from "../../server/core-background-adapter.js";
import { pidAlive } from "../../server/process-utils.js";
import type { ServerMessage } from "../../server/protocol.js";

it("drains a real background job and verifies its process exited", async () => {
	const root = mkdtempSync(join(tmpdir(), "managed-bg-drain-"));
	writeFileSync(join(root, "worker.cjs"), 'console.log("MANAGED_BG_PID=" + process.pid); setInterval(() => {}, 1000);');
	writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
		worker: `${JSON.stringify(process.execPath)} worker.cjs`,
	} }));
	const frames: ServerMessage[] = [];
	let disposed = false;
	const port = createCoreBackground({
		dataDir: root, emit: (message) => frames.push(message), flushSnapshot() {},
		isDisposed: () => disposed, getCwd: () => root, activeConversationId: () => "test", cleanupMinutes: () => 0,
	});
	try {
		port.startBgScript("worker");
		let pid = 0;
		let childPid = 0;
		await vi.waitFor(() => {
			const frame = frames.filter((message) => message.type === "bg_servers").at(-1);
			const row = frame?.servers.find((row) => row.kind === "job");
			pid = row?.pid ?? 0;
			expect(pid).toBeGreaterThan(1);
			expect(pidAlive(pid)).toBe(true);
			const log = row?.logPath && existsSync(row.logPath) ? readFileSync(row.logPath, "utf8") : "";
			childPid = Number(/^MANAGED_BG_PID=(\d+)$/m.exec(log)?.[1] ?? 0);
			expect(childPid).toBeGreaterThan(1);
			expect(pidAlive(childPid)).toBe(true);
		}, { timeout: 5000 });
		expect(await port.quiesce!()).toBe(true);
		expect(pidAlive(pid)).toBe(false);
		expect(pidAlive(childPid)).toBe(false);
	} finally {
		disposed = true;
		port.dispose();
		rmSync(root, { recursive: true, force: true });
	}
}, 15000);
