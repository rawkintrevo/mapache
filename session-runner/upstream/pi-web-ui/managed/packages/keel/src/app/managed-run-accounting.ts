import type { TurnCapableSession } from "../contracts/session.js";

/** Engine-lifetime counters for the managed scheduler, independent of plugin listeners. */
export class ManagedRunAccounting {
	private completed = 0;
	private readonly tools = new Set<Set<string>>();

	completedTurns(): number { return this.completed; }
	activeTools(): number {
		let count = 0;
		for (const calls of this.tools) count += calls.size;
		return count;
	}

	/** Follow the opened session when it transfers between client registries. */
	trackOpened(opened: { session: TurnCapableSession; dispose(): void }): void {
		const release = this.track(opened.session);
		const dispose = opened.dispose.bind(opened);
		opened.dispose = () => {
			try { dispose(); } finally { release(); }
		};
	}

	track(session: TurnCapableSession): () => void {
		const calls = new Set<string>();
		this.tools.add(calls);
		let closed = false;
		const unsubscribe = session.subscribe?.((event) => {
			if (closed || !event || typeof event !== "object") return;
			const ev = event as { type?: string; toolCallId?: unknown; willRetry?: boolean };
			if (ev.type === "agent_end" && !ev.willRetry) this.completed += 1;
			if (typeof ev.toolCallId !== "string") return;
			if (ev.type === "tool_execution_start") calls.add(ev.toolCallId);
			if (ev.type === "tool_execution_end") calls.delete(ev.toolCallId);
		});
		return () => {
			if (closed) return;
			closed = true;
			this.tools.delete(calls);
			unsubscribe?.();
		};
	}
}
