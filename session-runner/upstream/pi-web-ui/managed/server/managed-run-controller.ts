import type { CoreEngine } from "../packages/keel/src/app/core-engine.js";
import type { ManagedRunHandle } from "../packages/keel/src/app/managed-run-bridge.js";
import type { ManagedModelCatalogResponse } from "./managed-model-catalog.js";
import {
	createAutomationRunState,
	reduceAutomationRunState,
	type AutomationRunState,
	type AutomationRunEvent,
} from "./automation-run-state.js";

export interface ManagedRunRequest {
	runId: string;
	prompt: string;
	modelRef?: string;
	ticketId?: string;
	sourceWorkspaceId?: string;
	conversationTitle?: string;
}
export interface ManagedRunResponse {
	[key: string]: unknown;
	ok: boolean;
	error?: string;
	runId?: string;
	conversationId?: string;
	status?: string;
	state?: AutomationRunState;
}
type Engine = Pick<CoreEngine, "attach" | "get" | "openManagedRun" | "isQuiesced" | "managedAdmission">;
type Entry = { state: AutomationRunState; handle?: ManagedRunHandle; cancellation?: Promise<void> };

/** Run-id admission and outcome ownership; SDK execution remains in CoreEngine. */
export function createManagedRunController(options: {
	engine(): Engine;
	models(): Promise<ManagedModelCatalogResponse>;
}) {
	const requests = new Map<string, Entry>();
	const automations = new Map<string, Entry>();
	const clients = new Map<string, Promise<unknown>>();
	const response = (entry: Entry): ManagedRunResponse => ({
		ok: true,
		runId: entry.state.runId,
		...(entry.state.conversationId ? { conversationId: entry.state.conversationId } : {}),
		status: entry.state.terminal ?? (entry.state.submitted ? "running" : "submitted"),
		state: entry.state,
	});
	const reduce = (entry: Entry, event: Omit<AutomationRunEvent, "runId" | "conversationId">) => {
		if (!entry.state.conversationId) return;
		entry.state = reduceAutomationRunState(entry.state, {
			...event,
			runId: entry.state.runId,
			conversationId: entry.state.conversationId,
		} as AutomationRunEvent);
		if (entry.state.terminal) entry.handle?.release();
	};
	const stop = (entry: Entry): Promise<void> => {
		if (!entry.handle) return Promise.resolve();
		return (entry.cancellation ??= entry.handle.cancel().finally(() => {
			entry.cancellation = undefined;
		}));
	};
	const eventOf = (entry: Entry, raw: unknown, unattended: boolean) => {
		if (!raw || typeof raw !== "object" || entry.state.terminal) return;
		const event = raw as {
			type?: string;
			toolCallId?: string;
			toolName?: string;
			willRetry?: boolean;
			messages?: unknown[];
		};
		const taskId = event.toolCallId;
		if (taskId && (event.type === "tool_execution_start" || event.type === "tool_execution_end")) {
			const start = event.type === "tool_execution_start";
			// The reducer keeps final agent completion pending while tool calls remain outstanding.
			const kind =
				event.toolName === "subagent_spawn" || event.toolName === "delegate_task"
					? "subagent"
					: event.toolName?.includes("background")
						? "background_task"
						: "tool";
			reduce(entry, { type: `${kind}_${start ? "start" : "end"}`, taskId } as AutomationRunEvent);
			if (unattended && event.toolName === "ask_user_question" && !start) {
				reduce(entry, { type: "input_canceled", requestId: taskId } as AutomationRunEvent);
			}
			if (unattended && event.toolName === "ask_user_question" && start) {
				reduce(entry, { type: "input_requested", requestId: taskId } as AutomationRunEvent);
				setImmediate(() => {
					void stop(entry).catch(() => {
						entry.state = { ...entry.state, finalError: "managed_run_cancel_failed" };
					});
				});
			}
			return;
		}
		if (event.type !== "agent_end" || event.willRetry) return;
		const assistant = [...(event.messages ?? [])]
			.reverse()
			.find((value) => (value as { role?: string })?.role === "assistant") as
			{ stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
		const failed =
			!assistant || assistant.stopReason === "error" || assistant.stopReason === "aborted" || !!assistant.errorMessage;
		const content = assistant?.content;
		const answer =
			typeof content === "string"
				? content
				: Array.isArray(content)
					? content
							.filter((part) => part?.type === "text")
							.map((part) => String(part.text ?? ""))
							.join("\n")
					: undefined;
		reduce(entry, {
			type: "agent_end",
			result: failed ? "error" : "success",
			error: failed ? "managed_run_agent_failed" : undefined,
			answer: failed ? undefined : answer,
		} as AutomationRunEvent);
	};
	const ensureClient = async (engine: Engine, clientId: string) => {
		let flight = clients.get(clientId);
		if (!flight && engine.get(clientId)) return;
		if (!flight) {
			flight = engine.attach(clientId, () => {}).finally(() => clients.delete(clientId));
			clients.set(clientId, flight);
		}
		await flight;
	};
	const start = async (input: ManagedRunRequest, unattended: boolean): Promise<ManagedRunResponse> => {
		const prefix = unattended ? "automation" : "workspace_request";
		const runId = String(input.runId ?? "").trim();
		if (!runId) return { ok: false, error: `${prefix}_run_id_required` };
		const entries = unattended ? automations : requests;
		const existing = entries.get(runId);
		if (existing) return response(existing);
		if (!String(input.prompt ?? "").trim()) return { ok: false, error: `${prefix}_prompt_required` };
		if (unattended && automations.size) return { ok: false, error: "automation_run_busy" };
		const engine = options.engine();
		const admitted = engine.managedAdmission();
		if (engine.isQuiesced()) return { ok: false, error: "server_quiesced" };
		const entry: Entry = { state: createAutomationRunState(runId) };
		entries.set(runId, entry); // Reserve before any await so duplicate admission cannot dispatch twice.
		try {
			const catalog = await options.models();
			if (!catalog.ok) throw new Error(catalog.error ?? "workspace_request_model_catalog_failed");
			const saved = catalog.savedModelSelection;
			const modelRef = input.modelRef || (saved ? `${saved.providerId}/${saved.modelId}` : undefined);
			if (modelRef) {
				const model = catalog.models?.find((row) => `${row.providerId}/${row.modelId}` === modelRef);
				if (!model) throw new Error(`${prefix}_model_unavailable`);
				if (!model.available) throw new Error(`${prefix}_provider_auth_required`);
			} else if (!catalog.models?.some((model) => model.available)) throw new Error(`${prefix}_provider_auth_required`);
			if (entry.state.terminal) return response(entry);
			if (!admitted()) throw new Error("server_quiesced");
			const clientId = unattended ? "plugin:mapache-automation" : "plugin:mapache-workspace-requests";
			await ensureClient(engine, clientId);
			if (entry.state.terminal) return response(entry);
			if (!admitted()) throw new Error("server_quiesced");
			entry.handle = await engine.openManagedRun(clientId, {
				title: input.conversationTitle || `${unattended ? "Automation" : "Workspace request"} ${runId}`,
				modelRef,
				onEvent: (event) => eventOf(entry, event, unattended),
			});
			entry.state = reduceAutomationRunState(entry.state, {
				type: "started",
				runId,
				conversationId: entry.handle.conversationId,
			});
			if (entry.state.terminal) {
				try {
					await stop(entry);
				} catch {
					return { ...response(entry), ok: false, error: "managed_run_cancel_failed" };
				}
				return response(entry);
			}
			void entry.handle.submit(input.prompt).catch(() => {
				reduce(entry, { type: "agent_end", result: "error", error: "managed_run_submit_failed" } as AutomationRunEvent);
			});
			return response(entry);
		} catch (error) {
			if (entry.state.terminal) return response(entry);
			const code = error instanceof Error ? error.message : "";
			const allowed =
				/^(server_quiesced|(?:automation|workspace_request)_(?:model_unavailable|provider_auth_required|model_catalog_failed|model_client_initialization_failed|model_discovery_timeout))$/;
			// Retain failed admission: callers must not turn an uncertain failure into replay.
			entry.state = {
				...entry.state,
				terminal: "failed",
				finalResult: "error",
				finalError: allowed.test(code) ? code : `${prefix}_start_failed`,
			};
			return { ...response(entry), ok: false, error: entry.state.finalError! };
		}
	};
	const status = (runId: string, unattended: boolean): ManagedRunResponse => {
		const entry = (unattended ? automations : requests).get(runId.trim());
		return entry
			? response(entry)
			: { ok: false, error: unattended ? "automation_run_not_found" : "workspace_request_not_found" };
	};
	const cancel = async (runId: string, unattended: boolean): Promise<ManagedRunResponse> => {
		const entry = (unattended ? automations : requests).get(runId.trim());
		if (!entry) return status(runId, unattended);
		if (!entry.state.terminal)
			entry.state = { ...entry.state, terminal: "canceled", finalResult: "error", finalError: "canceled" };
		if (entry.state.terminal === "canceled") {
			try {
				await stop(entry);
			} catch {
				return { ...response(entry), ok: false, error: "managed_run_cancel_failed" };
			}
		}
		return response(entry);
	};
	return {
		startAutomation: (input: ManagedRunRequest) => start(input, true),
		automationStatus: (runId: string) => status(runId, true),
		cancelAutomation: (runId: string) => cancel(runId, true),
		startWorkspaceRequest: (input: ManagedRunRequest) => start(input, false),
		workspaceRequestStatus: (runId: string) => status(runId, false),
		cancelWorkspaceRequest: (runId: string) => cancel(runId, false),
	};
}
