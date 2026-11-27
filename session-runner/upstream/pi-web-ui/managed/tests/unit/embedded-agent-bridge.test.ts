import { describe, expect, it } from "vitest";
import {
	EMBEDDED_AGENT_BRIDGE_VERSION,
	isValidAgentAccessUrl,
	parentOrigin,
	parseAgentParentMessage,
} from "../../web/src/embedded-agent-bridge";

describe("embedded agent bridge", () => {
	it("accepts only the typed access message", () => {
		expect(parseAgentParentMessage({
			type: "mapache.agent.access",
			version: EMBEDDED_AGENT_BRIDGE_VERSION,
			agentUrl: "https://runner.example/agent/?mapache_access=signed",
		})).toEqual({
			type: "mapache.agent.access",
			version: 1,
			agentUrl: "https://runner.example/agent/?mapache_access=signed",
		});
		expect(parseAgentParentMessage({type: "mapache.agent.access", version: 2, agentUrl: "https://runner.example/agent/"})).toBeNull();
		expect(parseAgentParentMessage({type: "mapache.agent.access", version: 1, agentUrl: "https://evil.example/agent/?mapache_access=x"})).not.toBeNull();
	});

	it("validates renewal URL origin, path, and exactly one access query", () => {
		const current = "https://runner.example/agent/";
		expect(isValidAgentAccessUrl("https://runner.example/agent/?mapache_access=one", current, "/agent/")).toBe(true);
		expect(isValidAgentAccessUrl("https://evil.example/agent/?mapache_access=one", current, "/agent/")).toBe(false);
		expect(isValidAgentAccessUrl("https://runner.example/api/?mapache_access=one", current, "/agent/")).toBe(false);
		expect(isValidAgentAccessUrl("https://runner.example/agent/?mapache_access=one&mapache_access=two", current, "/agent/")).toBe(false);
	});

	it("derives an exact parent origin from the referrer", () => {
		expect(parentOrigin("https://mapache.tools/app?session=one")).toBe("https://mapache.tools");
		expect(parentOrigin("not a URL")).toBe("");
	});
});
