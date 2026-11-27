import { appBase } from "./base-url";

export const EMBEDDED_AGENT_BRIDGE_VERSION = 1 as const;
export const AGENT_ACCESS_RENEWED_EVENT = "mapache-agent-access-renewed";
export type AgentRenewalReason = "expired" | "bootstrap" | "connection-error";

export type AgentParentMessage = {
	type: "mapache.agent.access";
	version: typeof EMBEDDED_AGENT_BRIDGE_VERSION;
	agentUrl: string;
};

export type AgentChildMessage =
	| {
			type: "mapache.agent.ready";
			version: typeof EMBEDDED_AGENT_BRIDGE_VERSION;
		}
	| {
			type: "mapache.agent.navigate";
			version: typeof EMBEDDED_AGENT_BRIDGE_VERSION;
			surface: "chrome";
		}
	| {
			type: "mapache.agent.renewal-request";
			version: typeof EMBEDDED_AGENT_BRIDGE_VERSION;
			reason: AgentRenewalReason;
		}
	| {
			type: "mapache.agent.status";
			version: typeof EMBEDDED_AGENT_BRIDGE_VERSION;
			status: "access-renewed" | "access-error";
			error?: "access_refresh_failed";
		};

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function parseAgentParentMessage(value: unknown): AgentParentMessage | null {
	if (!value || typeof value !== "object") return null;
	const candidate = value as Partial<AgentParentMessage>;
	if (candidate.version !== EMBEDDED_AGENT_BRIDGE_VERSION || candidate.type !== "mapache.agent.access") return null;
	if (typeof candidate.agentUrl !== "string" || candidate.agentUrl.length === 0 || candidate.agentUrl.length > 4096) return null;
	return { type: candidate.type, version: candidate.version, agentUrl: candidate.agentUrl };
}

export function parentOrigin(referrer: string): string {
	if (!referrer) return "";
	try {
		return new URL(referrer).origin;
	} catch {
		return "";
	}
}

export function isValidAgentAccessUrl(value: string, currentUrl: string, expectedPath: string): boolean {
	try {
		const target = new URL(value, currentUrl);
		const current = new URL(currentUrl);
		return target.origin === current.origin && target.pathname === expectedPath &&
			target.searchParams.getAll("mapache_access").length === 1 &&
			target.searchParams.get("mapache_access") !== "";
	} catch {
		return false;
	}
}

export async function refreshEmbeddedAgentAccess(
	agentUrl: string,
	{fetchImpl = globalThis.fetch, currentUrl = globalThis.location?.href || ""}: {fetchImpl?: FetchLike; currentUrl?: string} = {},
): Promise<boolean> {
	const expected = new URL(appBase(), currentUrl || "http://localhost/agent/");
	if (!isValidAgentAccessUrl(agentUrl, currentUrl || expected.href, expected.pathname)) return false;
	try {
		const response = await fetchImpl(agentUrl, {
			cache: "no-store",
			credentials: "include",
			redirect: "follow",
		});
		if (!response.ok) return false;
		globalThis.window?.dispatchEvent(new Event(AGENT_ACCESS_RENEWED_EVENT));
		return true;
	} catch {
		return false;
	}
}

export function postAgentBridgeMessage(message: AgentChildMessage): boolean {
	if (typeof window === "undefined" || window.parent === window) return false;
	const origin = parentOrigin(document.referrer);
	if (!origin) return false;
	window.parent.postMessage(message, origin);
	return true;
}

export function requestEmbeddedAgentAccess(reason: AgentRenewalReason): boolean {
	if (reason !== "expired" && reason !== "bootstrap" && reason !== "connection-error") return false;
	return postAgentBridgeMessage({
		type: "mapache.agent.renewal-request",
		version: EMBEDDED_AGENT_BRIDGE_VERSION,
		reason,
	});
}

export function openEmbeddedSurface(surface: "chrome"): boolean {
	return postAgentBridgeMessage({
		type: "mapache.agent.navigate",
		version: EMBEDDED_AGENT_BRIDGE_VERSION,
		surface,
	});
}

export function installEmbeddedAgentBridge(): () => void {
	if (typeof window === "undefined" || window.parent === window) return () => {};
	const expectedOrigin = parentOrigin(document.referrer);
	if (!expectedOrigin) return () => {};
	const parent = window.parent;
	const onMessage = (event: MessageEvent<unknown>) => {
		if (event.source !== parent || event.origin !== expectedOrigin) return;
		const message = parseAgentParentMessage(event.data);
		if (!message) return;
		void refreshEmbeddedAgentAccess(message.agentUrl).then((ok) => {
			postAgentBridgeMessage(ok ? {
				type: "mapache.agent.status",
				version: EMBEDDED_AGENT_BRIDGE_VERSION,
				status: "access-renewed",
			} : {
				type: "mapache.agent.status",
				version: EMBEDDED_AGENT_BRIDGE_VERSION,
				status: "access-error",
				error: "access_refresh_failed",
			});
		});
	};
	window.addEventListener("message", onMessage);
	postAgentBridgeMessage({type: "mapache.agent.ready", version: EMBEDDED_AGENT_BRIDGE_VERSION});
	return () => window.removeEventListener("message", onMessage);
}
