import { Conversation } from "../kernel/conversation/index.js";
import type { ClientRuntime } from "./client-runtime.js";

export function trackManagedSetup<T>(pending: Set<Promise<unknown>>, flight: Promise<T>): Promise<T> {
	pending.add(flight);
	void flight.then(
		() => pending.delete(flight),
		() => pending.delete(flight),
	);
	return flight;
}

export interface ManagedRunInput {
	title: string;
	modelRef?: string;
	onEvent(event: unknown): void;
}

export interface ManagedRunHandle {
	conversationId: string;
	sessionFile?: string;
	submit(prompt: string): Promise<void>;
	cancel(): Promise<void>;
	release(): void;
}

/** Create a durable conversation without activating it. The existing core turn runner owns execution. */
export async function openManagedRun(
	runtime: ClientRuntime | undefined,
	input: ManagedRunInput,
	admitted: () => boolean,
): Promise<ManagedRunHandle> {
	if (!runtime || runtime.isDisposed()) throw new Error("managed_run_client_unavailable");
	const sessions = runtime.options.sessions;
	if (!sessions) throw new Error("managed_run_sessions_unavailable");
	const check = () => {
		if (!admitted() || runtime.isDisposed()) throw new Error("server_quiesced");
	};
	check();
	const conversation = new Conversation({
		id: `c-${runtime.registry.nextSeq()}`,
		clientId: runtime.clientId,
		cwd: runtime.cwd,
		kind: "user",
		createdAt: Date.now(),
		title: input.title.slice(0, 160),
		ephemeral: false,
	});
	runtime.registry.add(conversation);
	let unsubscribe: (() => void) | undefined;
	try {
		const opened = await sessions.ensure(conversation);
		await opened.ready;
		check();
		if (!opened.session.subscribe) throw new Error("managed_run_events_unavailable");
		if (input.modelRef) {
			const slash = input.modelRef.indexOf("/");
			if (slash <= 0 || slash === input.modelRef.length - 1) throw new Error("automation_model_invalid");
			const model = await runtime.options.resolveModel?.(
				input.modelRef.slice(0, slash),
				input.modelRef.slice(slash + 1),
			);
			check();
			if (!model || !opened.session.setModel) throw new Error("automation_model_unavailable");
			await opened.session.setModel(model);
			check();
		}
		unsubscribe = opened.session.subscribe(input.onEvent);
		let released = false;
		const release = () => {
			if (!released) {
				released = true;
				unsubscribe?.();
			}
		};
		// Follow the opened session when its conversation is transferred to another client.
		const dispose = opened.dispose.bind(opened);
		opened.dispose = () => {
			release();
			dispose();
		};
		let submitted = false;
		let canceled = false;
		runtime.surface().conversations().markListed(conversation.id);
		runtime.pushConversations();
		return {
			conversationId: conversation.id,
			sessionFile: opened.sessionFile,
			release,
			async submit(prompt) {
				check();
				if (canceled || released || !conversation.acceptsTurns) throw new Error("managed_run_closed");
				if (submitted) throw new Error("managed_run_already_submitted");
				if (!prompt.trim()) throw new Error("automation_prompt_required");
				submitted = true;
				runtime.surface().conversations().markPrompted(conversation.id);
				await runtime.turns.start(conversation, opened.session, prompt);
			},
			async cancel() {
				canceled = true;
				conversation.queues.clear();
				runtime.options.cancelManagedQuestions?.(conversation.id);
				opened.session.clearQueue?.();
				if (!opened.session.abort && (conversation.phase === "running" || opened.session.isStreaming)) {
					throw new Error("managed_run_abort_unavailable");
				}
				await opened.session.abort?.();
				await runtime.turns.whenIdle(conversation.id);
				if (opened.session.isStreaming || opened.session.isIdle === false) throw new Error("managed_run_still_active");
			},
		};
	} catch (error) {
		unsubscribe?.();
		conversation.retire();
		sessions.close(conversation.id);
		conversation.finishRetire();
		runtime.registry.remove(conversation.id);
		runtime.pushConversations();
		throw error;
	}
}
