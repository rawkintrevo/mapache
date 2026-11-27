import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	DefaultResourceLoader,
	ExtensionRunner,
	SessionManager,
	type BeforeAgentStartEvent,
	type ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { MAPACHE_REFERENCE_PATH, withManagedReference } from "../../packages/keel/src/adapters/sdk/managed-resources.js";

const reference = "# Mapache operating reference\nUse localhost:port in managed Chrome.";
const original = "SYSTEM.md instructions\n\nAvailable tools: read\nProject AGENTS.md\nUser APPEND_SYSTEM.md";
const event = (systemPrompt = original): BeforeAgentStartEvent => ({
	type: "before_agent_start",
	messageType: "user",
	prompt: "user request",
	systemPrompt,
	systemPromptOptions: { cwd: root, selectedTools: [], hiddenTools: [], toolSnippets: {}, toolGuidelines: {}, promptGuidelines: [], appendSystemPrompt: "", sections: {}, contextFiles: [], skills: [] },
});
let root: string;
let path: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "managed-reference-"));
	path = join(root, "mapache.md");
	writeFileSync(path, `\n${reference}\n`);
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});

function wrap(compose: Parameters<typeof withManagedReference>[0] = () => undefined) {
	return withManagedReference(compose, { PI_WEB_MANAGED: "1" }, path);
}

describe("managed operating reference", () => {
	it("appends exactly once while preserving all existing instructions and repeated turns", () => {
		const handler = wrap();
		const expected = `${original}\n\n${reference}`;
		expect(handler(event())?.systemPrompt).toBe(expected);
		expect(handler(event())?.systemPrompt).toBe(expected);
		// No override needed when a chained prompt already includes the reference.
		expect(handler(event(expected))).toBeUndefined();
	});

	it("appends after custom composition even when it omits the append token", () => {
		const composed = "Custom composer instructions\nProject rules";
		const message = { customType: "example", content: "retain", display: false };
		const handler = wrap(() => ({ systemPrompt: composed, message }));
		expect(handler(event())).toEqual({ systemPrompt: `${composed}\n\n${reference}`, message });
	});

	it.each(["append", "replace", "replace with SYSTEM.md", "empty template"])(
		"preserves the existing %s template result",
		(mode) => {
			const composed = mode === "empty template" ? original : `${mode} role\nProject rules\nUser append`;
			const handler = wrap(() => (mode === "empty template" ? undefined : { systemPrompt: composed }));
			expect(handler(event())?.systemPrompt).toBe(`${composed}\n\n${reference}`);
		},
	);

	it.each([{}, { PI_WEB_MANAGED: "0" }, { PI_WEB_MANAGED: "false" }])(
		"does not read files or alter the composer when unmanaged/disabled: %j",
		(env) => {
			const compose = () => ({ systemPrompt: "unchanged" });
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			expect(withManagedReference(compose, env, join(root, "missing"))).toBe(compose);
			expect(warn).not.toHaveBeenCalled();
		},
	);

	it.each(["missing", "empty"])("keeps existing prompt for %s reference with a safe warning", (kind) => {
		if (kind === "missing") rmSync(path);
		else writeFileSync(path, " \n\t");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const compose = () => ({ systemPrompt: original });
		expect(wrap(compose)).toBe(compose);
		expect(warn).toHaveBeenCalledOnce();
		expect(warn.mock.calls[0][0]).not.toContain(path);
	});

	it("loads fresh image content when a runtime is recreated/resumed", () => {
		const first = wrap();
		writeFileSync(path, "Updated image reference");
		const resumed = wrap();
		expect(first(event())?.systemPrompt).toContain(reference);
		expect(resumed(event())?.systemPrompt).toBe(`${original}\n\nUpdated image reference`);
	});

	it("uses the supported SDK hook and preserves earlier extension instructions without a model call", async () => {
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (e) => ({ systemPrompt: `${e.systemPrompt}\nEarlier extension` }));
					pi.on("before_agent_start", wrap());
				},
			],
		});
		await loader.reload();
		const loaded = loader.getExtensions();
		expect(loaded.errors).toEqual([]);
		const runner = new ExtensionRunner(
			loaded.extensions,
			loaded.runtime,
			root,
			SessionManager.inMemory(root),
			{} as ModelRegistry,
		);
		for (let turn = 0; turn < 2; turn++) {
			const result = await runner.emitBeforeAgentStart({messageType: "user", prompt: "request"}, {cwd: root, forceSystemPrompt: original});
			expect(result?.systemPromptOptions.forceSystemPrompt).toBe(`${original}\nEarlier extension\n\n${reference}`);
		}
	});

	it("installs the reference at the common SDK session opener after the upstream prompt renderer", () => {
		const opener = readFileSync(new URL("../../packages/keel/src/adapters/sdk/session-opener.ts", import.meta.url), "utf8");
		expect(opener).toContain('pi.on("before_agent_start", withManagedReference(');
		expect(opener.indexOf('name: "mapache-operating-reference"')).toBeGreaterThan(opener.indexOf("createPromptRenderExtension(opts.promptRender)"));
		expect(MAPACHE_REFERENCE_PATH).toBe("/app/reference/mapache.md");
	});
});
