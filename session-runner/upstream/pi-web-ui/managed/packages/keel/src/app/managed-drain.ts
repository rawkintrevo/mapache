import type { ClientRuntime } from "./client-runtime.js";

/** One deadline covers stop requests and verification, including hung adapters. */
export async function drainManagedWriters(input: {
	stop: readonly (() => void | Promise<unknown>)[];
	isIdle(): boolean;
	timeoutMs: number;
}): Promise<boolean> {
	const duration = Number.isFinite(input.timeoutMs) ? Math.max(1, input.timeoutMs) : 5000;
	const deadline = Date.now() + duration;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let expired = false;
	const timeout = new Promise<false>((resolve) => {
		timer = setTimeout(() => { expired = true; resolve(false); }, duration);
	});
	const drain = async (): Promise<boolean> => {
		// Start every stop operation even when another throws synchronously.
		const results = await Promise.allSettled(input.stop.map((stop) => Promise.resolve().then(stop)));
		if (results.some((result) => result.status === "rejected")) return false;
		while (!expired && Date.now() < deadline) {
			if (input.isIdle()) return true;
			await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
		}
		return false;
	};
	try { return await Promise.race([drain().catch(() => false), timeout]); }
	finally { expired = true; clearTimeout(timer); }
}

export class ManagedDrain {
	since?: number;
	private generation = 0;
	private failed = false;
	private flight?: Promise<{ ok: boolean; error?: string }>;

	admission(): () => boolean {
		const generation = this.generation;
		return () => this.since === undefined && generation === this.generation;
	}

	info() {
		return this.since === undefined ? { quiesced: false } : { quiesced: true, quiescedSince: this.since };
	}

	start(timeoutMs: number, pending: Set<Promise<unknown>>, runtimes: Iterable<ClientRuntime>,
		recordInterrupted: () => void, idle: () => boolean) {
		this.since ??= Date.now();
		this.generation++;
		this.flight ??= drainManagedWriters({
			timeoutMs,
			stop: [async () => {
				await Promise.allSettled([...pending]);
				recordInterrupted();
				const results = await Promise.all(Array.from(runtimes, runtime => runtime.options.drainWriters?.(timeoutMs)));
				if (results.some(ok => !ok)) throw new Error("runtime_drain_failed");
			}],
			isIdle: () => pending.size === 0 && idle(),
		}).then(ok => {
			this.failed ||= !ok;
			return ok ? { ok } : { ok, error: "quiesce_timeout" };
		}).finally(() => { this.flight = undefined; });
		return this.flight;
	}

	resume(runtimes: Iterable<ClientRuntime>) {
		if (this.flight) throw new Error("quiesce_in_progress");
		if (this.failed) throw new Error("quiesce_failed_restart_required");
		for (const runtime of runtimes) runtime.options.unquiesceWriters?.();
		this.since = undefined;
	}
}
