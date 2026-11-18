"use strict";

const http = require("node:http");

/**
 * A tiny OpenAI-compatible streaming fixture for the local pi-web vertical
 * slice. It deliberately returns tool calls instead of making a network model
 * request, so the integration path remains deterministic and free of paid
 * provider credentials.
 */
function createLocalVerticalModelServer({delayMs = 8} = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || new URL(request.url || "/", "http://127.0.0.1").pathname !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }

    const body = await readBody(request);
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({error: {message: "invalid fixture JSON"}}));
      return;
    }
    requests.push(payload);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const promptText = messages.map((message) => contentText(message.content)).join("\n");
    const hasMcpResult = messages.some((message) => message.role === "tool" &&
      (message.name === "mcp" || message.tool_call_id === "vertical-mcp-call"));
    const hasEditResult = messages.some((message) => message.role === "tool" &&
      (message.name === "edit" || message.tool_call_id === "vertical-edit-call"));

    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    if (/strict, independent goal-reviewer/i.test(promptText)) {
      await streamText(response, '{"verdict":"pass","feedback":"local fixture review passed"}', delayMs);
    } else if (!hasMcpResult) {
      await streamToolCall(response, "vertical-mcp-call", "mcp", JSON.stringify({
        tool: "echo",
        server: "fixture",
        args: {message: "vertical-tool-ok"},
      }), delayMs);
    } else if (!hasEditResult) {
      await streamToolCall(response, "vertical-edit-call", "edit", JSON.stringify({
        path: "edited.txt",
        oldText: "before",
        newText: "after",
      }), delayMs);
    } else {
      await streamText(response, "vertical model final", delayMs);
    }
    response.write("data: [DONE]\n\n");
    response.end();
  });

  return {
    requests,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve(server.address().port);
        });
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

async function streamText(response, text, delayMs) {
  await writeChunk(response, {choices: [{index: 0, delta: {role: "assistant", content: text.slice(0, 9)}, finish_reason: null}]}, delayMs);
  await writeChunk(response, {choices: [{index: 0, delta: {content: text.slice(9)}, finish_reason: null}]}, delayMs);
  await writeChunk(response, {choices: [{index: 0, delta: {}, finish_reason: "stop"}]}, delayMs);
}

async function streamToolCall(response, id, name, argumentsText, delayMs) {
  await writeChunk(response, {choices: [{index: 0, delta: {
    role: "assistant",
    tool_calls: [{index: 0, id, type: "function", function: {name, arguments: ""}}],
  }, finish_reason: null}]}, delayMs);
  const midpoint = Math.max(1, Math.floor(argumentsText.length / 2));
  await writeChunk(response, {choices: [{index: 0, delta: {
    tool_calls: [{index: 0, function: {arguments: argumentsText.slice(0, midpoint)}}],
  }, finish_reason: null}]}, delayMs);
  await writeChunk(response, {choices: [{index: 0, delta: {
    tool_calls: [{index: 0, function: {arguments: argumentsText.slice(midpoint)}}],
  }, finish_reason: "tool_calls"}]}, delayMs);
}

async function writeChunk(response, value, delayMs) {
  response.write(`data: ${JSON.stringify({id: "local-vertical", object: "chat.completion.chunk", model: "fixture-model", ...value})}\n\n`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((part) => part?.type === "text").map((part) => part.text || "").join("\n");
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

module.exports = {createLocalVerticalModelServer};
