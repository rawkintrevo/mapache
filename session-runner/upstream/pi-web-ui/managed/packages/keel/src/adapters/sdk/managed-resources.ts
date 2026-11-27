import { readFileSync } from "node:fs";
import type { BeforeAgentStartEvent, BeforeAgentStartEventResult } from "@earendil-works/pi-coding-agent";
/**
 * Whether this instance is managed from outside.
 *
 * Accepts the spellings people actually put in a systemd unit or a
 * docker-compose file; anything else — including an empty variable — means no,
 * so the default stays exactly what it is today.
 */
export function isManaged(env: NodeJS.ProcessEnv = process.env): boolean {
	const v = (env.PI_WEB_MANAGED ?? "").trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * The image-owned adapter entry point used by managed Pi sessions. Keeping
 * this as an explicit environment contract makes an unsupported/missing
 * adapter a startup failure rather than an accidental second MCP path.
 */
export function managedMcpAdapterPath(env: NodeJS.ProcessEnv = process.env): string | null {
	if (!isManaged(env)) return null;
	const value = (env.PI_WEB_MCP_ADAPTER_PATH ?? "").trim();
	return value || null;
}



export const MAPACHE_REFERENCE_PATH = "/app/reference/mapache.md";

type PromptHandler = (event: BeforeAgentStartEvent) => BeforeAgentStartEventResult | undefined;

/** Wrap the persona hook, not APPEND_SYSTEM: custom composers may omit {{append}}.
 * Each runtime (including resumed sessions and template subagents) loads its own
 * image-owned reference. Never materialize instructions into the workspace.
 */
export function withManagedReference(
	compose: PromptHandler,
	env: NodeJS.ProcessEnv = process.env,
	referencePath = MAPACHE_REFERENCE_PATH,
): PromptHandler {
	if (!isManaged(env)) return compose;
	let reference: string;
	try {
		reference = readFileSync(referencePath, "utf8").trim();
	} catch {
		console.warn("[Mapache] Operating reference unavailable; keeping existing system prompt.");
		return compose;
	}
	if (!reference) {
		console.warn("[Mapache] Operating reference empty; keeping existing system prompt.");
		return compose;
	}
	return (event) => {
		const result = compose(event);
		const prompt = result?.systemPrompt ?? event.systemPrompt;
		// Repeated turns/reloads must not accumulate another copy.
		if (prompt.includes(reference)) return result;
		return { ...result, systemPrompt: `${prompt}\n\n${reference}` };
	};
}
