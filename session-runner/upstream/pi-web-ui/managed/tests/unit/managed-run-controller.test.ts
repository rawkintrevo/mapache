import { describe, expect, it, vi } from "vitest";
import { createManagedRunController } from "../../server/managed-run-controller.js";
import type { ManagedModelCatalogResponse } from "../../server/managed-model-catalog.js";
import type { ManagedRunInput } from "../../packages/keel/src/app/managed-run-bridge.js";

function fixture() {
	let onEvent: (event: unknown) => void = () => {};
	let generation = 0;
	const handle = {
		conversationId: "request-c1",
		submit: vi.fn(async () => {}),
		cancel: vi.fn(async () => {}),
		release: vi.fn(),
	};
	const engine = {
		detach: vi.fn(),
		attach: vi.fn(async () => ({}) as any),
		get: vi.fn(() => undefined),
		isQuiesced: () => false,
		managedAdmission: () => {
			const admitted = generation;
			return () => admitted === generation;
		},
		openManagedRun: vi.fn(async (_client: string, input: ManagedRunInput) => {
			onEvent = input.onEvent;
			return handle;
		}),
	};
	const models = vi.fn(async (): Promise<ManagedModelCatalogResponse> => ({
		ok: true,
		models: [{ providerId: "provider", modelId: "family/model", name: "model", available: true }],
		savedModelSelection: { providerId: "provider", modelId: "family/model" },
	}));
	const controller = createManagedRunController({ engine: () => engine, models });
	return { controller, engine, models, handle, emit: (event: unknown) => onEvent(event), drain: () => generation++ };
}
const request = { runId: "run-1", prompt: "perform the task" };
const final = {
	type: "agent_end",
	messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
};

describe("managed run controller", () => {
	it("reserves concurrent duplicates before setup and only completes on final SDK evidence", async () => {
		const f = fixture();
		await Promise.all([f.controller.startWorkspaceRequest(request), f.controller.startWorkspaceRequest(request)]);
		expect(f.engine.openManagedRun).toHaveBeenCalledOnce();
		expect(f.handle.submit).toHaveBeenCalledOnce();
		expect(f.controller.workspaceRequestStatus(request.runId).status).toBe("running");
		f.emit({ ...final, willRetry: true });
		expect(f.controller.workspaceRequestStatus(request.runId).status).toBe("running");
		f.emit({ type: "tool_execution_start", toolCallId: "tool-1" });
		f.emit(final);
		expect(f.controller.workspaceRequestStatus(request.runId).status).toBe("running");
		f.emit({ type: "tool_execution_end", toolCallId: "tool-1" });
		expect(f.controller.workspaceRequestStatus(request.runId)).toMatchObject({
			status: "succeeded",
			state: { finalAnswer: "done" },
		});
		await f.controller.startWorkspaceRequest(request);
		expect(f.handle.submit).toHaveBeenCalledOnce();
	});
	it("does not start a canceled request after catalog setup resolves", async () => {
		const f = fixture();
		const catalog = await f.models();
		let resolve!: (value: ManagedModelCatalogResponse) => void;
		f.models.mockImplementation(
			() =>
				new Promise((done) => {
					resolve = done;
				}),
		);
		const start = f.controller.startWorkspaceRequest(request);
		expect(await f.controller.cancelWorkspaceRequest(request.runId)).toMatchObject({ status: "canceled" });
		resolve(catalog);
		expect(await start).toMatchObject({ status: "canceled" });
		expect(f.engine.openManagedRun).not.toHaveBeenCalled();
	});
	it("cancels a handle arriving after cancellation without dispatching its prompt", async () => {
		const f = fixture();
		let release!: () => void;
		f.engine.openManagedRun.mockImplementation(async () => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return f.handle;
		});
		const start = f.controller.startWorkspaceRequest(request);
		await vi.waitFor(() => expect(f.engine.openManagedRun).toHaveBeenCalledOnce());
		await f.controller.cancelWorkspaceRequest(request.runId);
		release();
		expect(await start).toMatchObject({ status: "canceled" });
		expect(f.handle.cancel).toHaveBeenCalledOnce();
		expect(f.handle.submit).not.toHaveBeenCalled();
	});
	it("rejects stale saved models and missing provider authentication without dispatch", async () => {
		const f = fixture();
		f.models.mockResolvedValueOnce({
			ok: true,
			models: [],
			savedModelSelection: { providerId: "stale", modelId: "missing" },
		});
		expect(await f.controller.startWorkspaceRequest(request)).toMatchObject({
			ok: false,
			error: "workspace_request_model_unavailable",
		});
		f.models.mockResolvedValueOnce({
			ok: true,
			models: [{ providerId: "p", modelId: "m", name: "m", available: false }],
		});
		expect(await f.controller.startWorkspaceRequest({ ...request, runId: "run-2", modelRef: "p/m" })).toMatchObject({
			ok: false,
			error: "workspace_request_provider_auth_required",
		});
		expect(f.handle.submit).not.toHaveBeenCalled();
	});
	it("does not revive admission after a drain/reopen cycle during setup", async () => {
		const f = fixture();
		const catalog = await f.models();
		f.models.mockImplementation(async () => {
			f.drain();
			return catalog;
		});
		expect(await f.controller.startWorkspaceRequest(request)).toMatchObject({ ok: false, error: "server_quiesced" });
		expect(f.engine.openManagedRun).not.toHaveBeenCalled();
	});
	it("records cancellation before interruption and retries failed cancellation without replay", async () => {
		const f = fixture();
		await f.controller.startWorkspaceRequest(request);
		f.handle.cancel.mockRejectedValueOnce(new Error("secret-error"));
		expect(await f.controller.cancelWorkspaceRequest(request.runId)).toMatchObject({
			ok: false,
			status: "canceled",
			error: "managed_run_cancel_failed",
		});
		expect(await f.controller.cancelWorkspaceRequest(request.runId)).toMatchObject({ ok: true, status: "canceled" });
		f.emit(final);
		expect(f.controller.workspaceRequestStatus(request.runId).status).toBe("canceled");
		expect(f.handle.submit).toHaveBeenCalledOnce();
	});
	it("allows one private automation run and reports unattended input requirements", async () => {
		const f = fixture();
		await f.controller.startAutomation(request);
		expect(await f.controller.startAutomation({ ...request, runId: "another" })).toMatchObject({
			ok: false,
			error: "automation_run_busy",
		});
		f.emit({ type: "tool_execution_start", toolCallId: "question", toolName: "ask_user_question" });
		await vi.waitFor(() => expect(f.handle.cancel).toHaveBeenCalledOnce());
		f.emit({ type: "tool_execution_end", toolCallId: "question" });
		f.emit(final);
		expect(f.controller.automationStatus(request.runId).status).toBe("interaction_required");
	});
});
