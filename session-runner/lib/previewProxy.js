"use strict";

const http = require("http");
const https = require("https");
const {normalizeEnvString} = require("./utils");

function createProxyPreviewService(config, deps = {}) {
  const appendLog = deps.appendLog || (() => {});

  async function isReady(upstream) {
    if (!upstream) return false;
    return new Promise((resolve) => {
      const url = new URL(upstream);
      const request = (url.protocol === "https:" ? https : http).request({
        hostname: url.hostname,
        method: "GET",
        path: `${url.pathname || "/"}${url.search || ""}`,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        protocol: url.protocol,
        timeout: 1500,
      }, (response) => {
        response.resume();
        resolve(true);
      });
      request.on("error", () => resolve(false));
      request.on("timeout", () => {
        request.destroy();
        resolve(false);
      });
      request.end();
    });
  }

  async function serve(req, res, previewConfig) {
    const upstream = normalizeUpstream(previewConfig.upstream);
    if (!upstream) {
      res.status(502).send("preview upstream is not configured");
      return;
    }

    const upstreamUrl = new URL(upstream);
    const relativePath = req.params[0] || "";
    const requestPath = joinProxyPath(upstreamUrl.pathname, relativePath, req.url);
    const client = upstreamUrl.protocol === "https:" ? https : http;
    const headers = {...req.headers, host: upstreamUrl.host};
    if (req.body && Object.keys(req.body).length) {
      delete headers["content-length"];
    }
    const proxyReq = client.request({
      headers,
      hostname: upstreamUrl.hostname,
      method: req.method,
      path: requestPath,
      port: upstreamUrl.port || (upstreamUrl.protocol === "https:" ? 443 : 80),
      protocol: upstreamUrl.protocol,
    }, (proxyRes) => {
      const responseHeaders = {...proxyRes.headers, "cache-control": "no-store"};
      res.writeHead(proxyRes.statusCode || 502, responseHeaders);
      proxyRes.pipe(res);
    });

    proxyReq.on("error", (error) => {
      appendLog({
        level: "error",
        args: [`Preview upstream request failed: ${error.message}`],
        href: `${config.previewBasePath}/${relativePath}`,
      });
      if (!res.headersSent) res.status(502).send("preview upstream unavailable");
    });

    if (req.body && Object.keys(req.body).length) {
      proxyReq.end(JSON.stringify(req.body));
      return;
    }
    req.pipe(proxyReq);
  }

  function normalizeUpstream(value) {
    const clean = normalizeEnvString(value);
    if (!clean) return "";
    try {
      const parsed = new URL(clean);
      if (!["http:", "https:"].includes(parsed.protocol)) return "";
      if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) return "";
      parsed.hash = "";
      return parsed.toString().replace(/\/+$/, "");
    } catch (error) {
      return "";
    }
  }

  function joinProxyPath(upstreamBasePath, relativePath, originalUrl) {
    const queryIndex = originalUrl.indexOf("?");
    const query = queryIndex >= 0 ? originalUrl.slice(queryIndex) : "";
    const base = upstreamBasePath && upstreamBasePath !== "/" ? upstreamBasePath.replace(/\/+$/, "") : "";
    const cleanRelative = `/${String(relativePath || "").replace(/^\/+/, "")}`;
    return `${base}${cleanRelative}${query}`;
  }

  return {isReady, normalizeUpstream, serve};
}

module.exports = {createProxyPreviewService};
