"use strict";

const http = require("node:http");
const {Transform} = require("node:stream");

const DEFAULT_PUBLIC_PREFIX = "/agent";
const DEFAULT_UPSTREAM_HOST = "127.0.0.1";
const DEFAULT_UPSTREAM_PORT = 8787;
const DEFAULT_REQUEST_LIMIT_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const ACCESS_COOKIE = "mapache_access";
const EMBEDDED_AGENT_REFERRER_POLICY = "strict-origin-when-cross-origin";
const AUTH_QUERY_KEYS = new Set([ACCESS_COOKIE, "token", "pi_web_token"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const STRIPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  "authorization",
  "cookie",
  "host",
  "origin",
  "referer",
  "x-pi-token",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-proto",
]);

/** Authenticated HTTP forwarding for the embedded pi-web-ui application. */
function createAgentGateway({
  accessVerifier,
  enabled = true,
  getUpstreamHeaders = () => ({}),
  httpClient = http,
  publicPrefix = DEFAULT_PUBLIC_PREFIX,
  requestLimitBytes = DEFAULT_REQUEST_LIMIT_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  secureCookie = true,
  upstreamHost = DEFAULT_UPSTREAM_HOST,
  upstreamPort = DEFAULT_UPSTREAM_PORT,
  assertCurrentWriter,
} = {}) {
  const prefix = normalizePublicPrefix(publicPrefix);
  const limitBytes = positiveNumber(requestLimitBytes, DEFAULT_REQUEST_LIMIT_BYTES);
  const timeoutMs = positiveNumber(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const host = String(upstreamHost || DEFAULT_UPSTREAM_HOST).trim() || DEFAULT_UPSTREAM_HOST;
  const port = Number(upstreamPort || DEFAULT_UPSTREAM_PORT);

  return {handle, mapPublicPath, mapUpstreamLocation, normalizeQuery, originAllowed};

  function handle(req, res) {
    if (!enabled) {
      writeError(res, 404, "not_found");
      return;
    }
    const request = parsePublicRequest(req, prefix);
    if (!request.ok) {
      writeError(res, request.status || 400, request.error || "invalid_agent_path");
      return;
    }
    const token = typeof accessVerifier?.extractToken === "function" ? accessVerifier.extractToken(req) : "";
    if (!token || typeof accessVerifier?.verify !== "function" || !accessVerifier.verify(token)) {
      writeError(res, 404, "not_found");
      return;
    }
    // The embedded pi-web-ui bridge uses the referrer origin to validate its
    // parent postMessage source. Send only the origin; forwarded requests
    // still strip referer/origin so the private upstream never sees it.
    res.setHeader("Referrer-Policy", EMBEDDED_AGENT_REFERRER_POLICY);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (isStateChanging(req.method) && !originAllowed(req)) {
      writeError(res, 403, "origin_not_allowed");
      return;
    }
    if (isBootstrapRequest(req, request, prefix) && request.hasAccessQuery) {
      establishCookie(res, token, accessVerifier, secureCookie);
      res.setHeader("Cache-Control", "no-store");
      res.statusCode = 303;
      res.setHeader("Location", bootstrapLocation(request.url, prefix));
      res.end();
      return;
    }

    const admit = () => {
      let upstreamHeaders;
      try {
        upstreamHeaders = getUpstreamHeaders() || {};
      } catch (error) {
        upstreamHeaders = {};
      }
      if (typeof upstreamHeaders["x-pi-token"] !== "string" || !upstreamHeaders["x-pi-token"]) {
        writeError(res, 503, "agent_unavailable");
        return;
      }
      forward(req, res, request, upstreamHeaders);
    };
    if (isStateChanging(req.method) && typeof assertCurrentWriter === "function") {
      Promise.resolve()
          .then(() => assertCurrentWriter())
          .then(admit)
          .catch(() => writeError(res, 503, "writer_authority_lost"));
      return;
    }
    admit();
  }

  function forward(req, res, request, upstreamHeaders) {
    const headers = forwardedRequestHeaders(req, upstreamHeaders, host, port);
    const contentLength = parseContentLength(req.headers?.["content-length"]);
    if (contentLength > limitBytes) {
      writeError(res, 413, "request_too_large");
      return;
    }

    let settled = false;
    const upstreamRequest = httpClient.request({
      hostname: host,
      method: req.method,
      path: `${request.internalPath}${request.query}`,
      port,
      headers,
    }, (upstreamResponse) => {
      if (settled) {
        upstreamResponse.resume();
        return;
      }
      const locationResult = rewriteResponseLocation(upstreamResponse.headers.location, request.internalPath);
      if (!locationResult.ok) {
        upstreamResponse.resume();
        settled = true;
        writeError(res, 502, locationResult.error);
        return;
      }
      const responseHeaders = filteredResponseHeaders(upstreamResponse.headers);
      if (locationResult.location) responseHeaders.location = locationResult.location;
      responseHeaders["referrer-policy"] = EMBEDDED_AGENT_REFERRER_POLICY;
      responseHeaders["x-content-type-options"] = "nosniff";
      res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
      settled = true;
      upstreamResponse.on("error", () => {
        if (!res.writableEnded) res.destroy();
      });
      upstreamResponse.pipe(res);
    });

    upstreamRequest.once?.("error", () => {
      if (settled || res.headersSent) return;
      settled = true;
      writeError(res, 502, "agent_unavailable");
    });
    upstreamRequest.setTimeout?.(timeoutMs, () => {
      if (settled) return;
      settled = true;
      upstreamRequest.destroy();
      writeError(res, 504, "agent_timeout");
    });

    if (!hasRequestBody(req)) {
      upstreamRequest.end();
      return;
    }
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        this.bytesSeen += Buffer.byteLength(chunk, encoding);
        if (this.bytesSeen > limitBytes) {
          callback(new Error("request_too_large"));
          return;
        }
        callback(null, chunk);
      },
    });
    limiter.bytesSeen = 0;
    limiter.once("error", () => {
      if (settled) return;
      settled = true;
      upstreamRequest.destroy();
      req.unpipe(limiter);
      req.resume?.();
      writeError(res, 413, "request_too_large");
    });
    req.once?.("aborted", () => {
      limiter.destroy();
      upstreamRequest.destroy();
    });
    req.pipe(limiter).pipe(upstreamRequest);
  }

  function rewriteResponseLocation(value, internalPath) {
    if (value === undefined) return {ok: true, location: ""};
    if (Array.isArray(value) || typeof value !== "string") return {ok: false, error: "upstream_redirect_rejected"};
    const location = mapUpstreamLocation(value, internalPath);
    return location ? {ok: true, location} : {ok: false, error: "upstream_redirect_rejected"};
  }

  function mapUpstreamLocation(value, fallbackPath = "/") {
    try {
      const base = new URL(`http://${host}:${port}${fallbackPath || "/"}`);
      const target = new URL(String(value), base);
      if (target.origin !== base.origin || hasTraversalSegment(target.pathname)) return "";
      target.pathname = target.pathname === "/" ? `${prefix}/` : `${prefix}${target.pathname}`;
      normalizeQuery(target.searchParams);
      return `${target.pathname}${target.search}${target.hash}`;
    } catch (error) {
      return "";
    }
  }

  function originAllowed(req) {
    const supplied = String(req.headers?.origin || "").trim();
    if (!supplied || supplied.toLowerCase() === "null") return false;
    try {
      const expected = requestOrigin(req);
      return new URL(supplied).origin.toLowerCase() === new URL(expected).origin.toLowerCase();
    } catch (error) {
      return false;
    }
  }
}

function parsePublicRequest(req, prefix) {
  const rawUrl = String(req.originalUrl || `${req.baseUrl || prefix}${req.url || "/"}`);
  const rawPath = rawUrl.split(/[?#]/, 1)[0] || "/";
  if (rawPath !== prefix && !rawPath.startsWith(`${prefix}/`)) {
    return {ok: false, status: 404, error: "not_found"};
  }
  const suffix = rawPath.slice(prefix.length);
  if (hasTraversalSegment(suffix)) return {ok: false, status: 400, error: "invalid_agent_path"};
  let url;
  try {
    url = new URL(rawUrl, "http://mapache.local");
  } catch (error) {
    return {ok: false, status: 400, error: "invalid_agent_path"};
  }
  const hasAccessQuery = url.searchParams.has(ACCESS_COOKIE);
  normalizeQuery(url.searchParams);
  return {
    ok: true,
    hasAccessQuery,
    internalPath: mapPublicPath(url.pathname, prefix),
    query: url.search,
    url,
  };
}

function mapPublicPath(value, prefix = DEFAULT_PUBLIC_PREFIX) {
  const publicPath = String(value || "/");
  const cleanPrefix = normalizePublicPrefix(prefix);
  if (publicPath === cleanPrefix || publicPath === `${cleanPrefix}/`) return "/";
  if (publicPath.startsWith(`${cleanPrefix}/`)) return publicPath.slice(cleanPrefix.length) || "/";
  if (publicPath.startsWith("/")) return publicPath || "/";
  return `/${publicPath}`;
}

function normalizeQuery(searchParams) {
  for (const key of AUTH_QUERY_KEYS) searchParams.delete(key);
  return searchParams;
}

function bootstrapLocation(url, prefix) {
  const target = new URL(url || `${prefix}/`, "http://mapache.local");
  target.pathname = target.pathname === prefix ? `${prefix}/` : target.pathname;
  normalizeQuery(target.searchParams);
  return `${target.pathname}${target.search}`;
}

function forwardedRequestHeaders(req, upstreamHeaders, host, port) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers || {})) {
    if (STRIPPED_REQUEST_HEADERS.has(key.toLowerCase()) || value === undefined) continue;
    headers[key] = value;
  }
  headers.host = `${host}:${port}`;
  Object.assign(headers, upstreamHeaders);
  return headers;
}

function filteredResponseHeaders(headers = {}) {
  const output = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || lower === "set-cookie" || lower === "location" || value === undefined) continue;
    output[key] = value;
  }
  return output;
}

function establishCookie(res, token, verifier, secureCookie) {
  const maxAgeMs = typeof verifier?.maxAgeMs === "function" ? verifier.maxAgeMs(token) : 0;
  const attributes = [
    `${ACCESS_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/agent/",
    "HttpOnly",
    "SameSite=None",
    `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
  ];
  if (secureCookie) attributes.push("Secure");
  attributes.push("Partitioned");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function isBootstrapRequest(req, request, prefix) {
  return ["GET", "HEAD"].includes(String(req.method || "GET").toUpperCase()) &&
    (request.url.pathname === prefix || request.url.pathname === `${prefix}/`);
}

function hasRequestBody(req) {
  const method = String(req.method || "GET").toUpperCase();
  return !["GET", "HEAD"].includes(method) || parseContentLength(req.headers?.["content-length"]) > 0;
}

function parseContentLength(value) {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function requestOrigin(req) {
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] || "").split(",")[0].trim().toLowerCase();
  const protocol = forwardedProto === "https" || forwardedProto === "http" ? forwardedProto : req.socket?.encrypted ? "https" : "http";
  return `${protocol}://${req.headers?.host || "localhost"}`;
}

function hasTraversalSegment(value) {
  return String(value || "").split("/").some((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded === ".." || decoded.includes("/") || decoded.includes("\\") || decoded.includes("\u0000");
    } catch (error) {
      return true;
    }
  });
}

function normalizePublicPrefix(value) {
  const clean = `/${String(value || DEFAULT_PUBLIC_PREFIX).replace(/^\/+|\/+$/g, "")}`;
  return clean === "/" ? DEFAULT_PUBLIC_PREFIX : clean;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function isStateChanging(method) {
  return !["GET", "HEAD", "OPTIONS"].includes(String(method || "GET").toUpperCase());
}

function writeError(res, status, message) {
  if (res.headersSent || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(message);
}

module.exports = {
  ACCESS_COOKIE,
  DEFAULT_REQUEST_LIMIT_BYTES,
  createAgentGateway,
  filteredResponseHeaders,
  hasTraversalSegment,
  mapPublicPath,
  normalizeQuery,
  parseContentLength,
};
