import http from "node:http";

const MAX_RESPONSE_BYTES = 1024 * 1024;
const AGENT_PREFIX = "/api/agent/";

export class AutomationAgentError extends Error {
  constructor(code, {status = 502, body = null, cause = null} = {}) {
    super(code);
    this.name = "AutomationAgentError";
    this.code = code;
    this.status = status;
    this.body = body;
    if (cause) this.cause = cause;
  }
}
/**
 * Talks to the runner-owned Unix socket. The child never receives the bearer
 * token or shutdown credential; the runner adapter owns both concerns.
 */
export function createAutomationAgentClient({
  socketPath = process.env.MAPACHE_AUTOMATION_AGENT_SOCKET,
  request = requestJson,
} = {}) {
  const normalizedSocketPath = String(socketPath || "").trim();

  return {
    call,
    socketPath: normalizedSocketPath,
  };

  async function call(pathname, options = {}) {
    if (!normalizedSocketPath) throw new AutomationAgentError("automation_agent_unavailable", {status: 503});
    const path = normalizeAgentPath(pathname);
    const method = String(options.method || "GET").toUpperCase();
    const idempotencyKey = String(options.idempotencyKey || "").trim();
    const headers = {
      ...(options.body === undefined ? {} : {"content-type": "application/json"}),
      ...(idempotencyKey ? {"idempotency-key": idempotencyKey} : {}),
    };
    const retry = options.retry === undefined ? method === "GET" || Boolean(idempotencyKey) : options.retry === true;
    const requestOptions = {
      socketPath: normalizedSocketPath,
      path,
      method,
      headers,
      body: options.body,
    };
    try {
      return await request(requestOptions);
    } catch (error) {
      if (!retry || error?.status) throw error;
      // A response can be lost after the broker has committed a mutation.
      // Reuse the same idempotency key for manual run/restart operations.
      return request(requestOptions);
    }
  }
}

function normalizeAgentPath(pathname) {
  const value = String(pathname || "");
  if (!value.startsWith(AGENT_PREFIX) || value.includes("..") || value.includes("//")) {
    throw new AutomationAgentError("automation_agent_invalid_path", {status: 400});
  }
  return value;
}

function requestJson({socketPath, path, method, headers, body}) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const framedHeaders = {...headers, ...(payload === undefined ? {} : {"content-length": Buffer.byteLength(payload)})};
  return new Promise((resolve, reject) => {
    const request = http.request({socketPath, path, method, headers: framedHeaders}, (response) => {
      const chunks = [];
      let total = 0;
      response.on("data", (chunk) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          response.destroy(new AutomationAgentError("automation_agent_response_too_large", {status: 502}));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let bodyValue = {};
        try {
          bodyValue = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
        } catch (error) {
          reject(new AutomationAgentError("automation_agent_invalid_response", {status: 502, cause: error}));
          return;
        }
        if (response.statusCode >= 200 && response.statusCode < 300) {
          resolve(bodyValue);
          return;
        }
        reject(new AutomationAgentError(
            bodyValue?.error || "automation_agent_request_failed",
            {status: response.statusCode || 502, body: bodyValue},
        ));
      });
      response.on("error", reject);
    });
    request.on("error", (error) => reject(new AutomationAgentError(
        "automation_agent_transport_failed",
        {status: 502, cause: error},
    )));
    request.end(payload);
  });
}
