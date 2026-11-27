import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendControlCommand, startControlServer } from "../../server/control-socket.js";

const tempDirs: string[] = [];

afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function waitForSocket(path: string): Promise<void> {
	for (let i = 0; i < 100 && !existsSync(path); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("local control socket", () => {
	it.skipIf(process.platform === "win32")("uses the runner control path for long ticket runtime directories", async () => {
		const socketDir = mkdtempSync(join(tmpdir(), "pi-control-short-"));
		tempDirs.push(socketDir);
		const dataDir = "/var/lib/mapache/runtimes/auto-ticket-" + "a".repeat(64) + "/agent-state/ui";
		vi.stubEnv("PI_WEB_CONTROL_PATH", join(socketDir, "agent.sock"));
		const service = {
			serviceStatus: () => ({service: null, pid: process.pid, version: "test", cwd: "/workspace", quiesced: false,
				connectedClients: 0, activeConversations: 0, activeTools: 0, pendingMessages: 0}),
			quiesce: async () => ({ok: true}), unquiesce: () => {},
			startAutomation: async () => ({ok: true, runId: "ticket-run", status: "running"}),
		};
		const stop = startControlServer({service, dataDir, port: 9880});
		try {
			await waitForSocket(join(socketDir, "agent.sock"));
			expect(await sendControlCommand(dataDir, 9880, "startAutomation", {runId: "ticket-run", prompt: "fixture"}))
				.toMatchObject({ok: true, runId: "ticket-run", status: "running"});
		} finally { stop(); }
	});

	it.skipIf(process.platform === "win32")("does not acknowledge quiesce until the drain completes", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ui-control-"));
		tempDirs.push(dataDir);
		let activeConversations = 1;
		const service = {
			serviceStatus: () => ({
				service: null,
				pid: process.pid,
				version: "test",
				cwd: "/workspace",
				quiesced: true,
				connectedClients: 0,
				activeConversations,
				activeTools: activeConversations,
				pendingMessages: 0,
			}),
			quiesce: async () => {
				await new Promise((resolve) => setTimeout(resolve, 35));
				activeConversations = 0;
				return { ok: true };
			},
			unquiesce: () => {},
		};
		const stop = startControlServer({ service, dataDir, port: 9876 });
		try {
			const socketPath = join(dataDir, "pi-web-ui.sock");
			await waitForSocket(socketPath);
			const startedAt = Date.now();
			const response = await sendControlCommand(dataDir, 9876, "quiesce");
			expect(Date.now() - startedAt).toBeGreaterThanOrEqual(25);
			expect(response).toMatchObject({ ok: true, activeConversations: 0, activeTools: 0 });
		} finally {
			stop();
		}
	});

	it.skipIf(process.platform === "win32")(
		"returns a bounded visible failure when a drain does not finish",
		async () => {
			const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ui-control-timeout-"));
			tempDirs.push(dataDir);
			const service = {
				serviceStatus: () => ({
					service: null,
					pid: process.pid,
					version: "test",
					cwd: "/workspace",
					quiesced: true,
					connectedClients: 0,
					activeConversations: 1,
					activeTools: 1,
					pendingMessages: 0,
				}),
				quiesce: async () => ({ ok: false, error: "quiesce_timeout" }),
				unquiesce: () => {},
			};
			const stop = startControlServer({ service, dataDir, port: 9877 });
			try {
				await waitForSocket(join(dataDir, "pi-web-ui.sock"));
				expect(await sendControlCommand(dataDir, 9877, "quiesce")).toMatchObject({
					ok: false,
					error: "quiesce_timeout",
					activeConversations: 1,
				});
			} finally {
				stop();
			}
		},
	);

	it.skipIf(process.platform === "win32")("routes private automation commands without an HTTP endpoint", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ui-automation-control-"));
		tempDirs.push(dataDir);
		const calls: Array<{ command: string; value?: unknown }> = [];
		const service = {
			serviceStatus: () => ({
				service: null,
				pid: process.pid,
				version: "test",
				cwd: "/workspace",
				quiesced: false,
				connectedClients: 0,
				activeConversations: 0,
				activeTools: 0,
				pendingMessages: 0,
			}),
			quiesce: async () => ({ ok: true }),
			unquiesce: () => {},
			startAutomation: async (input: { runId: string; prompt: string; modelRef?: string }) => {
				calls.push({ command: "start", value: input });
				return { ok: true, runId: input.runId, conversationId: "c1", status: "running" };
			},
			automationStatus: (runId: string) => {
				calls.push({ command: "status", value: runId });
				return { ok: true, runId, conversationId: "c1", status: "running" };
			},
			cancelAutomation: async (runId: string) => {
				calls.push({ command: "cancel", value: runId });
				return { ok: true, runId, conversationId: "c1", status: "canceled" };
			},
		};
		const stop = startControlServer({ service, dataDir, port: 9878 });
		try {
			await waitForSocket(join(dataDir, "pi-web-ui.sock"));
			expect(await sendControlCommand(dataDir, 9878, "startAutomation", { runId: "run-1", prompt: "hello", modelRef: "openai/gpt-5" })).toMatchObject({
				ok: true,
				runId: "run-1",
				status: "running",
			});
			expect(await sendControlCommand(dataDir, 9878, "automationStatus", { runId: "run-1" })).toMatchObject({ ok: true, status: "running" });
			expect(await sendControlCommand(dataDir, 9878, "cancelAutomation", { runId: "run-1" })).toMatchObject({ ok: true, status: "canceled" });
			expect(calls).toEqual([
				{ command: "start", value: { runId: "run-1", prompt: "hello", modelRef: "openai/gpt-5" } },
				{ command: "status", value: "run-1" },
				{ command: "cancel", value: "run-1" },
			]);
		} finally {
			stop();
		}
	});

	it.skipIf(process.platform === "win32")("routes visible workspace request commands", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-web-ui-workspace-request-control-"));
		tempDirs.push(dataDir);
		const calls: Array<{ command: string; value?: unknown }> = [];
		const service = {
			serviceStatus: () => ({ service: null, pid: process.pid, version: "test", cwd: "/workspace", quiesced: false, connectedClients: 0, activeConversations: 0, activeTools: 0, pendingMessages: 0 }),
			quiesce: async () => ({ ok: true }),
			unquiesce: () => {},
			startWorkspaceRequest: async (input: { runId: string; ticketId?: string; sourceWorkspaceId?: string; conversationTitle?: string; modelRef?: string; prompt: string }) => {
				calls.push({ command: "start", value: input });
				return { ok: true, runId: input.runId, conversationId: "c-request", status: "running" };
			},
			workspaceRequestStatus: (runId: string) => {
				calls.push({ command: "status", value: runId });
				return { ok: true, runId, conversationId: "c-request", status: "succeeded" };
			},
			cancelWorkspaceRequest: async (runId: string) => {
				calls.push({ command: "cancel", value: runId });
				return { ok: true, runId, conversationId: "c-request", status: "canceled" };
			},
		};
		const stop = startControlServer({ service, dataDir, port: 9879 });
		try {
			await waitForSocket(join(dataDir, "pi-web-ui.sock"));
			expect(await sendControlCommand(dataDir, 9879, "startWorkspaceRequest", {
				runId: "run-2", ticketId: "ticket-2", sourceWorkspaceId: "source", conversationTitle: "Request", modelRef: "openai/gpt-5", prompt: "hello",
			})).toMatchObject({ ok: true, runId: "run-2", status: "running" });
			expect(await sendControlCommand(dataDir, 9879, "workspaceRequestStatus", { runId: "run-2" })).toMatchObject({ ok: true, status: "succeeded" });
			expect(await sendControlCommand(dataDir, 9879, "cancelWorkspaceRequest", { runId: "run-2" })).toMatchObject({ ok: true, status: "canceled" });
			expect(calls).toHaveLength(3);
			expect(calls[0]).toEqual({ command: "start", value: {
				runId: "run-2", ticketId: "ticket-2", sourceWorkspaceId: "source", conversationTitle: "Request", modelRef: "openai/gpt-5", prompt: "hello",
			} });
		} finally {
			stop();
		}
	});
});
