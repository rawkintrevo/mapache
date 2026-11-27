import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

type CatalogRuntime = Pick<ModelRuntime, "refresh" | "getProviders" | "getModels" | "hasConfiguredAuth">;

export interface ManagedModelCatalogResponse {
	[key: string]: unknown;
	ok: boolean;
	models?: { providerId: string; modelId: string; name: string; available: boolean; input?: string[] }[];
	savedModelSelection?: { providerId: string; modelId: string } | null;
	error?: string;
	retryable?: boolean;
	stage?: string;
}

/** Read the installed SDK catalog without opening or taking over a browser conversation. */
export function createManagedModelCatalog(options: {
	agentDir: string;
	savedSelection(): string | undefined;
	isQuiesced(): boolean;
	timeoutMs?: number;
	allowNetwork?: boolean;
	createRuntime?: (paths: { authPath: string; modelsPath: string }) => Promise<CatalogRuntime>;
}): { workspaceRequestModels(): Promise<ManagedModelCatalogResponse> } {
	let flight: Promise<ManagedModelCatalogResponse> | undefined;
	const timeoutMs = options.timeoutMs ?? 8000;
	const unavailable = (error: string, stage: string): ManagedModelCatalogResponse => ({
		ok: false,
		error,
		stage,
		retryable: true,
	});
	const discover = async (): Promise<ManagedModelCatalogResponse> => {
		let runtime: CatalogRuntime;
		try {
			// A fresh runtime reloads credential/model files changed since the last query.
			runtime = await (options.createRuntime ?? ModelRuntime.create)({
				authPath: join(options.agentDir, "auth.json"),
				modelsPath: join(options.agentDir, "models.json"),
			});
		} catch {
			return unavailable("workspace_request_model_client_initialization_failed", "client_initialization");
		}
		try {
			await runtime.refresh({ allowNetwork: options.allowNetwork ?? true, signal: AbortSignal.timeout(timeoutMs) });
			if (options.isQuiesced()) return unavailable("server_quiesced", "catalog");
			const models = runtime
				.getProviders()
				.flatMap((provider) => {
					const available = runtime.hasConfiguredAuth(provider.id);
					return runtime.getModels(provider.id).map((model) => ({
						providerId: provider.id,
						modelId: model.id,
						name: model.name || model.id,
						available,
						...(Array.isArray(model.input) ? { input: model.input.map(String).slice(0, 8) } : {}),
					}));
				})
				.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.name.localeCompare(b.name));
			const saved = options.savedSelection() ?? "";
			const slash = saved.indexOf("/");
			return {
				ok: true,
				models,
				savedModelSelection:
					slash > 0 && slash < saved.length - 1
						? { providerId: saved.slice(0, slash), modelId: saved.slice(slash + 1) }
						: null,
			};
		} catch {
			return unavailable("workspace_request_model_catalog_failed", "catalog");
		}
	};
	return {
		async workspaceRequestModels() {
			if (options.isQuiesced()) return unavailable("server_quiesced", "catalog");
			flight ??= discover().finally(() => {
				flight = undefined;
			});
			// Keep an unsettled flight after timeout: retries must not multiply hung SDK work.
			const current = flight;
			return new Promise((resolve) => {
				const timer = setTimeout(
					() => resolve(unavailable("workspace_request_model_discovery_timeout", "catalog")),
					timeoutMs,
				);
				void current.then((result) => {
					clearTimeout(timer);
					resolve(result);
				});
			});
		},
	};
}
