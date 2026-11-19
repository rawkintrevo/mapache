#!/usr/bin/env node

"use strict";

const crypto = require("node:crypto");

const baseUrl = String(process.env.MAPACHE_PI_WEB_UI_SMOKE_URL || "http://127.0.0.1:8080").replace(/\/+$/, "");
const sessionId = String(process.env.SESSION_ID || "pi-web-ui-smoke");
const generation = String(process.env.MAPACHE_AGENT_RUNTIME_GENERATION || "smoke");
const secret = String(process.env.SESSION_BROWSER_TOKEN_SECRET || "pi-web-ui-smoke-secret");
const deadline = Date.now() + Number(process.env.MAPACHE_PI_WEB_UI_SMOKE_TIMEOUT_MS || 90_000);

async function main() {
  const token = signedToken();
  let lastError;
  while (Date.now() < deadline) {
    try {
      const bootstrap = await fetch(`${baseUrl}/agent/?mapache_access=${encodeURIComponent(token)}`, {
        redirect: "manual",
      });
      if (bootstrap.status !== 303) throw new Error(`bootstrap_http_${bootstrap.status}`);
      const location = bootstrap.headers.get("location");
      if (location !== "/agent/" && location !== "/agent") throw new Error(`unexpected_bootstrap_location:${location || "missing"}`);
      const page = await fetch(`${baseUrl}/agent/`, {
        headers: {cookie: `mapache_access=${encodeURIComponent(token)}`},
      });
      if (!page.ok) throw new Error(`agent_page_http_${page.status}`);
      const html = await page.text();
      const bundles = referencedBundles(html);
      if (!bundles.length) throw new Error("agent_page_has_no_application_bundle");
      const checked = [];
      for (const bundle of bundles) {
        const response = await fetch(new URL(bundle, `${baseUrl}/agent/`), {
          headers: {cookie: `mapache_access=${encodeURIComponent(token)}`},
        });
        if (!response.ok) throw new Error(`agent_bundle_http_${response.status}:${bundle}`);
        const body = await response.arrayBuffer();
        if (!body.byteLength) throw new Error(`agent_bundle_empty:${bundle}`);
        checked.push({path: bundle, bytes: body.byteLength});
      }
      console.log(JSON.stringify({ok: true, pageStatus: page.status, bundles: checked}));
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`pi-web-ui smoke timed out: ${lastError?.message || "unknown error"}`);
}

function signedToken() {
  const payload = Buffer.from(JSON.stringify({
    aud: "agent",
    exp: Math.floor(Date.now() / 1000) + 300,
    gen: generation,
    sid: sessionId,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function referencedBundles(html) {
  const values = new Set();
  const pattern = /(?:src|href)=["']([^"']+\.(?:js|mjs)(?:\?[^"']*)?)["']/gi;
  for (const match of html.matchAll(pattern)) {
    const value = match[1];
    if (value.startsWith("/agent/") || value.startsWith("./") || value.startsWith("../") || !value.includes("://")) {
      values.add(value);
    }
  }
  return [...values];
}

main().catch((error) => {
  console.error(JSON.stringify({ok: false, error: error.message || String(error)}));
  process.exitCode = 1;
});
