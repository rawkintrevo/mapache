import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createServer} from "node:http";
import type {AddressInfo} from "node:net";
import {ModelRuntime} from "@earendil-works/pi-coding-agent";
import {afterEach, expect, it} from "vitest";
import {ModelAdminService, type ModelAdminHost} from "../../server/model-admin.js";
import {mapacheProviderKey} from "../../server/mapache-provider-auth.js";
import type {ServerMessage} from "../../server/protocol.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true}); });

it("uses canonical credentials for discovery and Pi streaming/tool calls without serializing secrets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mapache-custom-")); roots.push(dir);
  const requests: {url: string; key: string | undefined}[] = [];
  const server = createServer((req, res) => {
    requests.push({url: req.url || "", key: req.headers.authorization});
    if (req.headers.authorization !== "Bearer test-only-key") { res.writeHead(401).end(); return; }
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({data: [{id: "qwen", context_window: 32768}]})); return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, {"content-type": "text/event-stream"});
      res.write(`data: ${JSON.stringify({id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{index: 0, delta: {role: "assistant", tool_calls: [{index: 0, id: "call-fixture", type: "function", function: {name: "echo", arguments: '{"text":"hello"}'}}]}, finish_reason: null}]})}\n\n`);
      res.write(`data: ${JSON.stringify({id: "chat-fixture", object: "chat.completion.chunk", created: 1, model: "qwen", choices: [{index: 0, delta: {}, finish_reason: "tool_calls"}]})}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const auth = {"custom-lab": {type: "api_key", key: "test-only-key", mapacheBaseUrl: baseUrl}, openai: {type: "api_key", key: "unrelated-key"}};
    writeFileSync(join(dir, "auth.json"), JSON.stringify(auth));
    writeFileSync(join(dir, "models.json"), JSON.stringify({providers: {"custom-lab": {baseUrl, api: "openai-completions", models: []}}}));
    const runtime = await ModelRuntime.create({authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), modelsStorePath: join(dir, "cache.json"), allowModelNetwork: false});
    const messages: ServerMessage[] = [];
    const host: ModelAdminHost = {agentDir: dir, managed: true, modelRuntime: () => runtime, emit: (m) => messages.push(m), flushSnapshot() {}, isDisposed: () => false, invalidatePiConfig() {}, pushModels: async () => {}};
    const admin = new ModelAdminService(host);
    await admin.fetchModelsList(1, baseUrl, undefined, undefined, "openai-completions", undefined, "custom-lab");
    expect(messages).toContainEqual(expect.objectContaining({type: "fetch_models_result", ok: true}));
    await admin.refreshProviderModels("custom-lab", 2);
    expect(messages).toContainEqual(expect.objectContaining({type: "refresh_provider_result", ok: true}));
    await admin.saveModelConfig("custom-lab", {providerId: "custom-lab", baseUrl, api: "openai-completions", models: [{id: "qwen", contextWindow: 32768, maxTokens: 1024}]});
    const model = runtime.getModel("custom-lab", "qwen");
    expect(model).toBeDefined();
    const result = await runtime.complete(model!, {messages: [{role: "user", content: "Call echo", timestamp: Date.now()}]});
    expect(result.content).toContainEqual(expect.objectContaining({type: "toolCall", name: "echo", arguments: {text: "hello"}}));
    expect(requests.some((r) => r.url === "/v1/chat/completions")).toBe(true);
    expect(requests.every((r) => r.key === "Bearer test-only-key")).toBe(true);
    expect(readFileSync(join(dir, "models.json"), "utf8")).not.toContain("test-only-key");
    expect(JSON.stringify(messages)).not.toContain("test-only-key");
    const before = requests.length;
    await admin.fetchModelsList(3, "https://other.example/v1", undefined, undefined, "openai-completions", undefined, "custom-lab");
    expect(requests).toHaveLength(before);
    expect(messages).toContainEqual(expect.objectContaining({type: "fetch_models_result", reqId: 3, ok: false}));
    expect(() => mapacheProviderKey(dir, "openai", baseUrl, "openai-completions")).toThrow();
    expect(() => mapacheProviderKey(dir, "custom-missing", baseUrl, "openai-completions")).toThrow();
    await admin.saveModelConfig("custom-lab", {providerId: "custom-lab", baseUrl: "https://other.example/v1", api: "openai-completions", models: [{id: "qwen"}]});
    expect(JSON.parse(readFileSync(join(dir, "models.json"), "utf8")).providers["custom-lab"].baseUrl).toBe(baseUrl);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}, 30000);
