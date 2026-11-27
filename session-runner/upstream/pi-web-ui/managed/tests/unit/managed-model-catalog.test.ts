import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createManagedModelCatalog } from "../../server/managed-model-catalog.js";

function fixture() {
	const runtime = {
		refresh: vi.fn(async () => ({})),
		getProviders: () => [{ id: "configured" }, { id: "unconfigured" }],
		getModels: (provider: string) => [
			{ id: `${provider}/model`, name: "Model", input: ["text", "image"], apiKey: "private-key" },
		],
		hasConfiguredAuth: (provider: string) => provider === "configured",
	};
	const createRuntime = vi.fn(async () => runtime as any);
	const catalog = createManagedModelCatalog({
		agentDir: "/agent",
		savedSelection: () => "stale/model/name",
		isQuiesced: () => false,
		createRuntime,
		timeoutMs: 20,
	});
	return { runtime, createRuntime, catalog };
}

describe("managed runtime model catalog", () => {
	it("reads a custom slash-ID model from the real installed SDK without returning credentials", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "managed-model-catalog-"));
		try {
			writeFileSync(join(agentDir, "auth.json"), "{}");
			writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						"fixture-provider": {
							baseUrl: "http://127.0.0.1:1/v1",
							api: "openai-completions",
							apiKey: "fixture-not-a-real-key",
							models: [
								{
									id: "organization/family/model",
									name: "Fixture slash model",
									reasoning: false,
									input: ["text"],
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									contextWindow: 8192,
									maxTokens: 1024,
								},
							],
						},
					},
				}),
			);
			const catalog = createManagedModelCatalog({
				agentDir,
				allowNetwork: false,
				isQuiesced: () => false,
				savedSelection: () => "fixture-provider/organization/family/model",
				createRuntime: (paths) =>
					ModelRuntime.create({ ...paths, modelsStorePath: join(agentDir, "catalog.json"), allowModelNetwork: false }),
			});
			const result = await catalog.workspaceRequestModels();
			expect(result.ok).toBe(true);
			expect(result.models).toContainEqual({
				providerId: "fixture-provider",
				modelId: "organization/family/model",
				name: "Fixture slash model",
				available: true,
				input: ["text"],
			});
			expect(result.savedModelSelection).toEqual({
				providerId: "fixture-provider",
				modelId: "organization/family/model",
			});
			expect(JSON.stringify(result)).not.toContain("fixture-not-a-real-key");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
	it("returns safe full catalog rows including unavailable providers and stale saved selections", async () => {
		const { catalog, createRuntime } = fixture();
		const result = await catalog.workspaceRequestModels();
		expect(result).toMatchObject({
			ok: true,
			models: [
				{ providerId: "configured", available: true },
				{ providerId: "unconfigured", available: false },
			],
			savedModelSelection: { providerId: "stale", modelId: "model/name" },
		});
		expect(JSON.stringify(result)).not.toContain("private-key");
		expect(createRuntime).toHaveBeenCalledWith({ authPath: "/agent/auth.json", modelsPath: "/agent/models.json" });
	});
	it("shares discovery in flight but reloads the SDK after a completed query", async () => {
		const { catalog, createRuntime } = fixture();
		await Promise.all([catalog.workspaceRequestModels(), catalog.workspaceRequestModels()]);
		expect(createRuntime).toHaveBeenCalledTimes(1);
		await catalog.workspaceRequestModels();
		expect(createRuntime).toHaveBeenCalledTimes(2);
	});
	it("returns sanitized initialization and catalog errors and allows retry", async () => {
		const { catalog, createRuntime, runtime } = fixture();
		createRuntime.mockRejectedValueOnce(new Error("secret-token"));
		expect(await catalog.workspaceRequestModels()).toMatchObject({
			ok: false,
			retryable: true,
			error: "workspace_request_model_client_initialization_failed",
			stage: "client_initialization",
		});
		runtime.refresh.mockRejectedValueOnce(new Error("secret-token"));
		expect(await catalog.workspaceRequestModels()).toMatchObject({
			ok: false,
			error: "workspace_request_model_catalog_failed",
		});
		expect(await catalog.workspaceRequestModels()).toMatchObject({ ok: true });
	});
	it("bounds a hung initialization and reuses it across retries", async () => {
		const { catalog, createRuntime } = fixture();
		createRuntime.mockImplementation(() => new Promise(() => {}));
		for (let i = 0; i < 2; i++) {
			expect(await catalog.workspaceRequestModels()).toMatchObject({
				ok: false,
				error: "workspace_request_model_discovery_timeout",
				retryable: true,
			});
		}
		expect(createRuntime).toHaveBeenCalledTimes(1);
	});
	it("rejects discovery during drain without initializing the SDK", async () => {
		const createRuntime = vi.fn();
		const catalog = createManagedModelCatalog({
			agentDir: "/agent",
			savedSelection: () => undefined,
			isQuiesced: () => true,
			createRuntime,
		});
		expect(await catalog.workspaceRequestModels()).toMatchObject({ ok: false, error: "server_quiesced" });
		expect(createRuntime).not.toHaveBeenCalled();
	});
});
