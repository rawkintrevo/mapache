import { describe, expect, it, vi, afterEach } from "vitest";
import { drainManagedWriters } from "../../packages/keel/src/app/managed-drain.js";
import { BashKills } from "../../packages/keel/src/domains/background/bash-kills.js";

afterEach(() => vi.useRealTimers());

describe("managed writer drain", () => {
	it("waits for bash termination acknowledgement after requesting abort", async () => {
		vi.useFakeTimers();
		const kills = new BashKills();
		const handle = kills.register("conversation")!;
		handle.signal.addEventListener("abort", () => setTimeout(handle.release, 40));
		const stopped = vi.fn();
		const result = drainManagedWriters({ stop: [() => kills.requestStopAll()], isIdle: () => kills.activeCount() === 0, timeoutMs: 100 }).then((value) => { stopped(value); return value; });
		await vi.advanceTimersByTimeAsync(1);
		expect(handle.signal.aborted).toBe(true);
		expect(kills.activeCount()).toBe(1);
		expect(stopped).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(50);
		expect(await result).toBe(true);
	});
	it("bounds hung stop requests and observes late rejections without restarting work", async () => {
		vi.useFakeTimers();
		let reject!: (error: Error) => void;
		const otherStop = vi.fn();
		const result = drainManagedWriters({ stop: [() => new Promise((_, fail) => { reject = fail; }), otherStop], isIdle: () => true, timeoutMs: 30 });
		await vi.advanceTimersByTimeAsync(30);
		expect(await result).toBe(false);
		expect(otherStop).toHaveBeenCalledOnce();
		reject(new Error("late stop failure"));
		await vi.runAllTimersAsync();
	});
	it("attempts every stop but fails closed on a thrown stop or unreadable state", async () => {
		const stop = vi.fn();
		expect(await drainManagedWriters({ stop: [() => { throw new Error("stop failed"); }, stop], isIdle: () => true, timeoutMs: 100 })).toBe(false);
		expect(stop).toHaveBeenCalledOnce();
		expect(await drainManagedWriters({ stop: [], isIdle: () => { throw new Error("state unreadable"); }, timeoutMs: 100 })).toBe(false);
	});
	it("never treats a resolved abort as proof that writers stopped", async () => {
		vi.useFakeTimers();
		const result = drainManagedWriters({ stop: [async () => {}], isIdle: () => false, timeoutMs: 30 });
		await vi.advanceTimersByTimeAsync(30);
		expect(await result).toBe(false);
		await vi.runAllTimersAsync();
		expect(vi.getTimerCount()).toBe(0);
	});
});
