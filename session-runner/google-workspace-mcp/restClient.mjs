const DEFAULT_BASE_URL = "https://www.googleapis.com";
const DEFAULT_TOKEN_ENV = "GOOGLE_MCP_ACCESS_TOKEN";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_MAX_ITEMS = 500;

const STATUS_CODES = Object.freeze({
  401: "google_unauthorized",
  403: "google_forbidden",
  404: "google_not_found",
  409: "google_conflict",
  429: "google_rate_limited",
});

export class GoogleRestError extends Error {
  constructor(code, message, {status = 0, retryable = false, cause} = {}) {
    super(message, cause ? {cause} : undefined);
    this.name = "GoogleRestError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function createGoogleRestClient({
  baseUrl = DEFAULT_BASE_URL,
  env = process.env,
  fetchImpl = globalThis.fetch,
  tokenEnv = DEFAULT_TOKEN_ENV,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("Google REST client requires fetch.");

  async function request(pathOrUrl, options = {}) {
    const token = String(env?.[tokenEnv] || "").trim();
    if (!token) throw new GoogleRestError("google_access_token_missing", "Google access token is not configured.");

    const url = resolveUrl(baseUrl, pathOrUrl);
    const {responseType = "json", maxResponseBytes: requestMaxResponseBytes, ...fetchOptions} = options;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), boundedTimeout(timeoutMs));
    const headers = new Headers(options.headers || {});
    headers.set("authorization", `Bearer ${token}`);
    headers.set("accept", "application/json");
    if (options.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");

    let response;
    try {
      response = await fetchImpl(url, {...fetchOptions, headers, signal: controller.signal});
    } catch (error) {
      if (controller.signal.aborted) {
        throw new GoogleRestError("google_request_timeout", "Google request timed out.", {cause: error});
      }
      throw new GoogleRestError("google_request_failed", "Google request failed.", {cause: error});
    } finally {
      clearTimeout(timeout);
    }

    const bytes = await readBoundedBody(response, Math.min(
        positiveInteger(requestMaxResponseBytes, maxResponseBytes),
        positiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES),
    ));
    if (responseType === "bytes") return bytes;
    const bodyText = new TextDecoder().decode(bytes);
    const body = parseJsonBody(bodyText, response.status);
    if (!response.ok) throw normalizedResponseError(response.status, body, token);
    return body;
  }

  async function paginate(requestPage, {
    initialParams = {},
    itemsKey = "items",
    pageTokenKey = "nextPageToken",
    maxPages = DEFAULT_MAX_PAGES,
    maxItems = DEFAULT_MAX_ITEMS,
  } = {}) {
    if (typeof requestPage !== "function") throw new TypeError("Pagination requires a page request function.");
    const pageLimit = positiveInteger(maxPages, DEFAULT_MAX_PAGES);
    const itemLimit = positiveInteger(maxItems, DEFAULT_MAX_ITEMS);
    const items = [];
    let pageToken;
    let pages = 0;
    let truncated = false;

    while (pages < pageLimit && items.length < itemLimit) {
      const params = {...initialParams};
      if (pageToken) params.pageToken = pageToken;
      const page = await requestPage(params);
      pages += 1;
      const pageItems = Array.isArray(page?.[itemsKey]) ? page[itemsKey] : [];
      items.push(...pageItems.slice(0, itemLimit - items.length));
      pageToken = String(page?.[pageTokenKey] || "").trim();
      if (!pageToken) break;
      if (pages >= pageLimit || items.length >= itemLimit) truncated = true;
    }

    return {items, pages, nextPageToken: pageToken || null, truncated};
  }

  return Object.freeze({paginate, request});
}

function resolveUrl(baseUrl, pathOrUrl) {
  const value = String(pathOrUrl || "").trim();
  if (!value) throw new GoogleRestError("google_request_invalid", "Google request path is required.");
  try {
    return new URL(value, String(baseUrl || DEFAULT_BASE_URL)).toString();
  } catch (error) {
    throw new GoogleRestError("google_request_invalid", "Google request path is invalid.", {cause: error});
  }
}

async function readBoundedBody(response, maxResponseBytes) {
  const limit = positiveInteger(maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES);
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > limit) {
        await reader.cancel().catch(() => {});
        throw new GoogleRestError("google_response_too_large", "Google response exceeds the configured size limit.");
      }
      chunks.push(value);
    }
    return concatBytes(chunks, total);
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > limit) throw new GoogleRestError("google_response_too_large", "Google response exceeds the configured size limit.");
  return new Uint8Array(buffer);
}

function concatBytes(chunks, total) {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseJsonBody(text, status) {
  if (!String(text || "").trim()) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new GoogleRestError("google_invalid_json", status >= 400 ? "Google returned an invalid error response." : "Google returned an invalid JSON response.", {status, cause: error});
  }
}

function normalizedResponseError(status, body, token = "") {
  const code = STATUS_CODES[status] || (status >= 500 ? "google_upstream_unavailable" : "google_request_failed");
  const retryable = status === 429 || status >= 500;
  const providerMessage = safeProviderMessage(body, token);
  const message = providerMessage ? `${code}: ${providerMessage}` : `${code}.`;
  return new GoogleRestError(code, message, {status, retryable});
}

function safeProviderMessage(body, token) {
  const value = body?.error?.message || body?.message || "";
  const tokenPattern = token ? new RegExp(escapeRegExp(token), "g") : null;
  return String(value)
      .replace(tokenPattern || /$a/, "[redacted]")
      .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
      .slice(0, 200);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function boundedTimeout(value) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.min(Math.floor(timeout), 120_000) : DEFAULT_TIMEOUT_MS;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export const googleRestDefaults = Object.freeze({
  baseUrl: DEFAULT_BASE_URL,
  maxPages: DEFAULT_MAX_PAGES,
  maxItems: DEFAULT_MAX_ITEMS,
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  tokenEnv: DEFAULT_TOKEN_ENV,
});
