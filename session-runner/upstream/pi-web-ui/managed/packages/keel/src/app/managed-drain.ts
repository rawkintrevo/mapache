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
